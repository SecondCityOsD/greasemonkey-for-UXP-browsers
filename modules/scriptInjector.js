/**
 * @file scriptInjector.js
 * @overview Chrome-side script-injection driver.
 *
 * This module owns every step of the path from "new document seen" to
 * "user script running in its sandbox":
 *
 *   1. Subscribes to Services.obs topics
 *      "content-document-global-created" and
 *      "document-element-inserted" so it catches every new window /
 *      iframe.
 *   2. For document-start scripts that need privileged APIs, injects
 *      them at the earliest possible point (TOPIC_EARLY).
 *   3. For everything else, listens on the content window's
 *      DOMContentLoaded + load events and runs document-end and
 *      document-idle phases at the right moment.
 *   4. Handles the special about: URLs that the regular event sequence
 *      doesn't fire on (bug #1820, #2371, #2195).
 *   5. Decides per-script whether to inject into the page context
 *      (@grant none, @inject-into page) via a <script> element, or
 *      into a sandbox via Cu.Sandbox + runScriptInSandbox().
 *
 * UXP is single-process — chrome and content share a JS runtime — so
 * everything in this driver runs in chrome scope with no message-manager
 * indirection.
 *
 * Exports:
 *   startScriptInjector()
 *     Called once at extension startup from components/greasemonkey.js.
 *     Registers the Services.obs observers.  Idempotent: calling
 *     a second time is a no-op.
 *
 *   injectDelayedScript(aScript, aRunAt, aWindowId, aBrowser)
 *     Used by modules/script.js when a script update completes mid-
 *     page-load.  aBrowser is the chrome <browser> element; we walk
 *     its contentWindow / nsIWindowMediator to find the right window.
 *
 *   urlsOfAllFrames(aContentWin)
 *     Recursive frame-URL collector, called by content/browser.js for
 *     the toolbar popup and tooltip.
 *
 *   scriptsRanIn(aTopWin) / scriptRunCountIn(aTopWin)
 *     The scripts that actually ran in a tab's page (top document and
 *     its frames), for the toolbar button's badge: their ids, each
 *     script once, or how many ran counting each frame they ran in.
 *     Each new run is announced with the "greasemonkey:scripts-ran"
 *     observer topic (subject: the top window).
 */

const EXPORTED_SYMBOLS = [
  "startScriptInjector",
  "injectDelayedScript",
  "scriptRunCountIn",
  "scriptsRanIn",
  "urlsOfAllFrames",
];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/constants.js");
Cu.import("chrome://greasemonkey-modules/content/cspNonce.js");
Cu.import("chrome://greasemonkey-modules/content/extractMeta.js");
Cu.import("chrome://greasemonkey-modules/content/GM_openInTab.js");
Cu.import("chrome://greasemonkey-modules/content/ipcScript.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/sandbox.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// Observer topic constants for per-script early injection (bug #1849).
const TOPIC_EARLY  = "content-document-global-created";
const TOPIC_NORMAL = "document-element-inserted";

const URL_ABOUT_PART2_REGEXP = new RegExp(
    GM_CONSTANTS.urlAboutPart2Regexp, "");
const URL_USER_PASS_STRIP_REGEXP = new RegExp(
    GM_CONSTANTS.urlUserPassStripRegexp, "");

/**
 * Documents whose document-start scripts the early observer already ran,
 * so the normal observer runs only the deferred ones.  Per document, not
 * per window: an iframe's initial about:blank window is reused for a
 * same-origin page without a new early notification, and the flag it left
 * made that page skip its document-start scripts.  WeakSet → no GC
 * retention.
 *
 * @type {WeakSet<Document>}
 */
var gEarlyStartDocs = new WeakSet();

/**
 * Documents whose document-start phase has run, so nothing runs it twice
 * (about:reader did, from contentLoad).
 *
 * @type {WeakSet<Document>}
 */
var gStartRanDocs = new WeakSet();

// Documents that already have a window.onurlchange monitor (see
// setupUrlChangeMonitor): one per page, so every page of a tab gets one.
var gUrlChangeDocs = new WeakSet();

/**
 * Idempotency flag for startScriptInjector().  Re-registering the
 * Services.obs observer would cause every document event to fire our
 * handler twice.
 */
var gStarted = false;

/**
 * Safe-globals snapshot prelude, evaluated once per page-mode script
 * to capture clean references to a curated set of platform builtins
 * AS THEY EXIST when the script's prelude runs.
 *
 * Held at module scope because the string is literally identical for
 * every script and every page — its tokens reference `window.X` which
 * is resolved at script-eval time, not at string-build time, so
 * memoisation is safe.
 *
 * Wrapped in `(function(){…})()` so its two `var` helpers
 * (`__SO__` / `__SF__`) stay private even in the @unwrap path —
 * without this, they'd leak to `window.__SO__` and pollute the page's
 * global namespace.  GM_info is reachable from inside the IIFE via
 * lexical scope (declared `var`/`const` in both wrappers below, so
 * it's in the outer Activation Record).
 */
const GM_SAFE_GLOBALS_SNAPSHOT_PRELUDE =
    "(function () {\n"
    + "  var __SO__ = window.Object;\n"
    + "  var __SF__ = __SO__.freeze;\n"
    + "  GM_info.safeGlobals = __SF__.call(__SO__, {\n"
    + "    Object: window.Object, Array: window.Array,\n"
    + "    Function: window.Function, Promise: window.Promise,\n"
    + "    JSON: window.JSON, Map: window.Map, Set: window.Set,\n"
    + "    WeakMap: window.WeakMap, WeakSet: window.WeakSet,\n"
    + "    RegExp: window.RegExp, Date: window.Date,\n"
    + "    String: window.String, Number: window.Number,\n"
    + "    Boolean: window.Boolean, Symbol: window.Symbol,\n"
    + "    Error: window.Error, TypeError: window.TypeError,\n"
    + "    RangeError: window.RangeError,\n"
    + "    SyntaxError: window.SyntaxError,\n"
    + "    ReferenceError: window.ReferenceError,\n"
    + "    URL: window.URL,\n"
    + "    URLSearchParams: window.URLSearchParams,\n"
    + "    FormData: window.FormData, Blob: window.Blob,\n"
    + "    File: window.File, ArrayBuffer: window.ArrayBuffer,\n"
    + "    Uint8Array: window.Uint8Array,\n"
    + "    DataView: window.DataView,\n"
    + "    Proxy: window.Proxy, Reflect: window.Reflect,\n"
    + "    parseInt: window.parseInt,\n"
    + "    parseFloat: window.parseFloat,\n"
    + "    isNaN: window.isNaN, isFinite: window.isFinite,\n"
    + "    encodeURIComponent: window.encodeURIComponent,\n"
    + "    decodeURIComponent: window.decodeURIComponent,\n"
    + "    encodeURI: window.encodeURI,\n"
    + "    decodeURI: window.decodeURI,\n"
    + "  });\n"
    + "})();\n";


/**
 * Determines whether a content window is visible enough that scripts
 * should run in it.  Uses nsIDOMWindowUtils.isParentWindowMainWidgetVisible
 * to skip the rare "tab-being-restored" case where the parent widget is
 * not yet attached.
 *
 * @param {Window} aContentWin
 * @returns {boolean}
 */
function isWindowVisible(aContentWin) {
  if (!aContentWin) {
    return false;
  }
  try {
    let winUtils = aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils);
    if (winUtils && !winUtils.isParentWindowMainWidgetVisible) {
      return false;
    }
  } catch (e) {
    return false;
  }
  return true;
}

/**
 * Returns true iff aContentWin is the top of its frame tree.  A non-DOM
 * window (rare) is treated as "top" defensively.
 *
 * @param {Window} aContentWin
 * @returns {boolean}
 */
function windowIsTop(aContentWin) {
  try {
    aContentWin.QueryInterface(Ci.nsIDOMWindow);
    if (aContentWin.frameElement) {
      return false;
    }
  } catch (e) {
    // Ignore non-DOM windows.
  }
  return true;
}

/**
 * Best-effort URL for an in-flight document.  Uses documentURI as the
 * primary source (it does NOT change under history.replaceState — see
 * bug #1970), with a fallback to location.href for the very-early
 * "about:blank-before-real-URL" window state (see bug #1696).  Strips
 * user/pass from the URL for matching (bug #1631).
 *
 * @param {Window} aContentWin
 * @returns {string|false} URL string, or false if the window is closed.
 */
function urlForWin(aContentWin) {
  if (GM_util.windowIsClosed(aContentWin)) {
    return false;
  }
  let url = aContentWin.document.documentURI;
  if (url == "about:blank") {
    try {
      let locHref = aContentWin.location.href;
      if (locHref && locHref != "about:blank") {
        url = locHref;
      }
    } catch (e) {
      // location may not be accessible in some edge cases.
    }
  }
  return url.replace(URL_USER_PASS_STRIP_REGEXP, "$1");
}

/**
 * Recursively collects the href of every frame nested inside
 * aContentWin.  Called by the toolbar-popup and tooltip code in
 * content/browser.js.
 *
 * @param {Window} aContentWin
 * @returns {string[]} Flat array of URL strings.
 */
function urlsOfAllFrames(aContentWin) {
  if (!aContentWin) {
    return [];
  }
  let urls = [];
  try {
    urls.push(aContentWin.location.href);
  } catch (e) {
    return urls;
  }
  try {
    let frames = aContentWin.frames;
    for (let i = 0; i < frames.length; i++) {
      // `Array.prototype.push(...sub)` mutates in place; pre-fix
      // `urls = urls.concat(...)` allocated a fresh array per iframe,
      // making this O(N²) in deep frame trees.  Spread-push is O(N).
      urls.push.apply(urls, urlsOfAllFrames(frames[i]));
    }
  } catch (e) {
    // Cross-origin frame access denied — skip silently.
  }
  return urls;
}

/**
 * What ran where, for the toolbar badge.  Both keyed on documents, not
 * windows: a tab's window is reused when it navigates, its document isn't,
 * and Back/Forward restores the very same document from the bfcache.
 *
 *   gScriptsRan:  top-level document -> the Set of ids of the scripts that
 *                 ran in it or its frames (scriptsRanIn).
 *   gFrameRuns:   any document (the top one included) -> the Set of ids of
 *                 the scripts that ran in it (scriptRunCountIn adds these
 *                 up over the frames the page has now).
 *
 * Neither holds a window or a document strongly: a removed iframe's
 * record goes with it.  (A Map of frame windows to {doc, ids} kept every
 * iframe a long-lived page ever had alive.)
 */
var gScriptsRan = new WeakMap();
var gFrameRuns = new WeakMap();

/**
 * Records that aScript ran in aContentWin (a page or a frame), and
 * announces it when it's new for that frame's page.  A script that runs
 * again in the same page (another run-at) counts once.
 * @param {Window}    aContentWin
 * @param {IPCScript} aScript
 */
function noteScriptRan(aContentWin, aScript) {
  let top, doc;
  try {
    top = aContentWin.top;
    doc = aContentWin.document;
    if (!top || !top.document || !doc) {
      return;
    }
  } catch (e) {
    return;
  }
  let frameIds = gFrameRuns.get(doc);
  if (!frameIds) {
    frameIds = new Set();
    gFrameRuns.set(doc, frameIds);
  }
  if (frameIds.has(aScript.id)) {
    return;
  }
  frameIds.add(aScript.id);
  let topIds = gScriptsRan.get(top.document);
  if (!topIds) {
    topIds = new Set();
    gScriptsRan.set(top.document, topIds);
  }
  topIds.add(aScript.id);
  Services.obs.notifyObservers(top, "greasemonkey:scripts-ran", null);
}

/**
 * @param {Window} aTopWin - A tab's content window.
 * @returns {string[]} The ids of the scripts that ran in its current page,
 *          frames included, each once.
 */
function scriptsRanIn(aTopWin) {
  let ids = aTopWin && aTopWin.document && gScriptsRan.get(aTopWin.document);
  return ids ? Array.from(ids) : [];
}

/**
 * @param {Window} aTopWin - A tab's content window.
 * @returns {number} How many scripts ran in its current page, each counted
 *          once per frame it runs in (Violentmonkey's "total").  Only the
 *          frames the page has now count, each for the page it shows.
 */
function scriptRunCountIn(aTopWin) {
  let count = 0;
  let visit = function (aWin) {
    try {
      let ids = gFrameRuns.get(aWin.document);
      if (ids) {
        count += ids.size;
      }
      for (let i = 0; i < aWin.frames.length; i++) {
        visit(aWin.frames[i]);
      }
    } catch (e) {
      // A frame we can't reach (going away) doesn't count.
    }
  };
  if (aTopWin && aTopWin.document && gScriptsRan.has(aTopWin.document)) {
    visit(aTopWin);
  }
  return count;
}


/**
 * Injects a @grant none / @inject-into page script directly into the
 * page context via a <script> element.  Matches Violentmonkey /
 * Tampermonkey behaviour: the script runs in the page's global scope
 * so explicit `window.x = …` writes are visible to page JS, but
 * bare `var/let/const` stay local thanks to the IIFE wrapper.
 *
 * @param {Window}    aContentWin
 * @param {IPCScript} aScript
 * @param {string}    aRunAt
 * @returns {boolean} Whether the script ran (in the page, or in the
 *          sandbox it falls back to); false when it was blocked or its
 *          file couldn't be read.
 */
function injectScriptIntoPage(aContentWin, aScript, aRunAt) {
  let doc = aContentWin.document;
  // Fallback to the Document itself if documentElement is null (very
  // early load); appendChild still works.
  let parent = doc.documentElement || doc;

  // Look up the page's CSP script-source nonce, if any, so injected
  // <script> elements can carry a matching nonce attribute and slip
  // past nonce-based CSPs (GitHub, Google search, modern news sites).
  // null on pages without a nonce CSP — the element then just gets
  // injected un-attributed, which is also fine on no-CSP pages.
  let cspNonce = getNonceForWindow(aContentWin);

  function injectCode(aCode, aSourceHint) {
    try {
      let el = doc.createElement("script");
      if (cspNonce) {
        el.setAttribute("nonce", cspNonce);
      }
      if (aSourceHint) {
        aCode += "\n//# sourceURL=" + aSourceHint;
      }
      el.textContent = aCode;
      parent.appendChild(el);
      el.remove();
      return true;
    } catch (e) {
      return false;
    }
  }

  // 1) Inject a probe element to detect whether the page allows
  //    inline-script injection (e.g. uBlock / strict CSP).
  injectCode(`(()=>{
      let el = document.createElement("div");
      el.setAttribute("id", "${GM_CONSTANTS.injectIntoPageTestID}");
      document.documentElement.append(el);
    })();`);
  let testElement = doc.querySelector("#" + GM_CONSTANTS.injectIntoPageTestID);
  let scriptBlocked = !testElement && aScript.fileURL;
  if (testElement) {
    testElement.remove();
  }

  // 2) Inject each @require as its own <script> element so library
  //    globals (jQuery's $, etc.) are reachable by the userscript.
  for (let i = 0; !scriptBlocked && i < aScript.requires.length; i++) {
    let code;
    try {
      code = GM_util.fileXhr(
          aScript.requires[i].fileURL, "application/javascript");
    } catch (e) {
      GM_util.logError(
          "Error loading @require " + aScript.requires[i].fileURL
          + ":\n" + e, true, e.fileName, e.lineNumber);
      continue;
    }
    if (!injectCode(code, aScript.requires[i].fileURL)) {
      scriptBlocked = aScript.requires[i].fileURL;
      break;
    }
  }

  // 3) If injection was blocked (CSP / blocker extension) and the
  //    script did not *require* page context, fall back to the
  //    sandbox path so the user still gets their script running.
  if (scriptBlocked) {
    let warning = aScript.injectInto !== "page";
    GM_util.logError(
        `Error loading user script "${aScript.name}" into page context, ${
        warning ? "fall back to sandbox" : "the script has been blocked"}.`
        + `\nPage URL: ${aContentWin.document.documentURI}`,
        warning, scriptBlocked, null);
    if (warning) {
      let sandbox = createSandbox(
          aContentWin, aContentWin.document.documentURI, aScript, aRunAt);
      runScriptInSandbox(sandbox, aScript);
    }
    return warning;
  }

  // 4) Prepare script body + GM_info JSON.
  let scriptCode;
  try {
    scriptCode = GM_util.fileXhr(aScript.fileURL, "application/javascript");
  } catch (e) {
    GM_util.logError(
        "Error loading script " + aScript.fileURL
        + ":\n" + e, false, e.fileName, e.lineNumber);
    return false;
  }

  let gmInfoJson = "{}";
  try {
    let gmInfo = aScript.info();
    gmInfo.isIncognito = GM_util.windowIsPrivate(aContentWin);
    gmInfo.isPrivate = gmInfo.isIncognito;
    gmInfo.scriptSource = scriptCode;
    gmInfo.scriptMetaStr = extractMeta(scriptCode);
    gmInfoJson = JSON.stringify(gmInfo);
  } catch (e) {
    GM_util.logError(
        "Error loading GM_info:\n" + e, true, e.fileName, e.lineNumber);
  }

  // Safe-globals snapshot: captures clean references to a curated set
  // of built-in constructors and globals AS THEY EXIST at the moment
  // the user script's prelude runs.  Exposed to the script body as
  // `GM_info.safeGlobals`, frozen with the just-captured `Object` so
  // the snapshot object itself is defended against `Object.freeze`
  // being later shadowed on the prototype.
  //
  // Most defensive when the script uses `@run-at document-start`
  // (the page hasn't run inline scripts yet, so the captured
  // references are the pristine platform builtins).  Captured later
  // — document-end / document-idle — the references are whatever
  // the page already saw / replaced; the snapshot then merely
  // freezes the values at script-start, which still defends against
  // FURTHER mutation but cannot un-do prior tainting.
  //
  // Curated list balances common-use coverage vs. surface area:
  // sandbox scripts already get fresh prototypes via Cu.Sandbox so
  // they don't need this; this snapshot is for @grant none /
  // @inject-into page scripts that explicitly chose page context
  // and so share globals with potentially-hostile page JS.
  // The snapshot is itself wrapped in a `(function(){…})()` so its
  // two `var` helpers (`__SO__` / `__SF__`) stay private even in the
  // @unwrap path — without this, they'd leak to `window.__SO__` and
  // pollute the page's global namespace.  GM_info is reachable from
  // inside the IIFE via lexical scope (declared `var` in both
  // wrappers below, so it's in the outer Activation Record).
  // Hoisted to GM_SAFE_GLOBALS_SNAPSHOT_PRELUDE at module scope — the
  // string is identical for every script + every page and was being
  // rebuilt fresh on every injection.  See comment at the constant.
  let safeGlobalsSnapshot = GM_SAFE_GLOBALS_SNAPSHOT_PRELUDE;

  // 5) Inject the user script body.  Default wrapping is an IIFE so
  //    bare var/let/const declarations stay local; @topLevelAwait
  //    upgrades the wrapper to async IIFE (matches Violentmonkey).
  //
  //    @unwrap (legacy GM1.x) opts the script out of the IIFE so its
  //    top-level declarations leak into the page's window scope —
  //    that's the whole point of the directive.  When @unwrap is set,
  //    GM_info and the unsafeWindow alias are still made available,
  //    but as top-level `var` declarations rather than function-scoped
  //    locals so they're visible to the unwrapped body below.
  let wrappedCode;
  if (aScript.unwrap) {
    wrappedCode =
        "var GM_info = " + gmInfoJson + ";\n"
        + safeGlobalsSnapshot
        + "var unsafeWindow = window;\n"
        + scriptCode;
  } else {
    wrappedCode = `
      (${aScript.topLevelAwait ? "async " : ""}function() {
        var GM_info = ${gmInfoJson};
${safeGlobalsSnapshot}
        const unsafeWindow = window;
        ${scriptCode}
      })();`;
  }
  return injectCode(wrappedCode, aScript.fileURL);
}

/** @grant values that aren't GM APIs: a page script has these too. */
const PAGE_SAFE_GRANTS = [
  "none", "gm_info", "gm.info", "unsafewindow", "window.onurlchange",
];

/**
 * Whether aScript runs as a <script> in the page: only for @inject-into
 * page, and only without GM APIs to grant.  A page script gets GM_info and
 * unsafeWindow and nothing else, so a script with, say, @grant GM_setValue
 * failed at its first call.  Those run in the sandbox instead, which has
 * the page through unsafeWindow (Violentmonkey bridges its API into the
 * page instead; exposing privileged functions to the page is what the
 * sandbox avoids).
 *
 * @param {IPCScript} aScript
 * @returns {boolean}
 */
function runsInPage(aScript) {
  return (aScript.injectInto == "page")
      && (aScript.grants || []).every(function (aGrant) {
        return PAGE_SAFE_GRANTS.indexOf(String(aGrant).toLowerCase()) > -1;
      });
}

/**
 * Routes a list of scripts to either the page-context injector or the
 * sandbox path, one at a time.  A script's failure is logged but does
 * not interrupt the rest of the list (one broken userscript must not
 * shadow the others).
 *
 * @param {IPCScript[]} aScripts
 * @param {string}      aRunAt
 * @param {Window}      aContentWin
 */
function injectScripts(aScripts, aRunAt, aContentWin) {
  try {
    aContentWin.QueryInterface(Ci.nsIDOMChromeWindow);
    // Never inject into a chrome-context window.
    return undefined;
  } catch (e) {
    // Not a chrome window — proceed.
  }

  let url = urlForWin(aContentWin);
  if (!url) {
    return undefined;
  }
  let winIsTop = windowIsTop(aContentWin);

  for (let i = 0, iLen = aScripts.length; i < iLen; i++) {
    let script = aScripts[i];
    if (script.noframes && !winIsTop) {
      continue;
    }
    try {
      // Routing:
      //   @inject-into page (EXPLICIT), with no GM APIs granted
      //       → true DOM-<script> injection via injectScriptIntoPage.
      //         The author opted into page-script semantics (visible
      //         in DevTools, perfect instanceof against page-side
      //         objects, page-style eval/Function) and accepts the
      //         CSP risk that comes with it.  Built-in fallback in
      //         injectScriptIntoPage drops down to the sandbox path
      //         if the test-probe detects a CSP block.  With GM APIs
      //         granted it takes the sandbox path (runsInPage).
      //
      //   everything else, INCLUDING @grant none
      //       → sandbox-with-page-prototype via createSandbox.
      //         Cu.Sandbox(contentWin, {sandboxPrototype: contentWin,
      //         wantXrays: false}) gives @grant none scripts the
      //         exact mechanism the pre-WebExtensions Greasemonkey
      //         for Pale Moon used: chrome-privileged Cu.evalInSandbox
      //         that BYPASSES the page's CSP (script-src, nonces,
      //         'strict-dynamic', require-trusted-types-for) while
      //         preserving the semantics polyfills depend on — writes
      //         to `window.X` walk the prototype chain to contentWin
      //         and become own properties on the real page window.
      //
      // Pre-fix: @grant none scripts ALWAYS took the injectScriptIntoPage
      // path, so on Trusted-Types sites (ChatGPT, modern banking SPAs)
      // even the post-Phase-B nonce attribute couldn't save them — the
      // .textContent assignment is blocked unconditionally by TT.  The
      // fallback to sandbox theoretically worked, but adding a layer
      // of DOM-injection-then-detect-block-then-retry both slowed down
      // document-start polyfills and made debugging confusing.
      //
      // The trade-offs of routing @grant none through the sandbox:
      //   + CSP / Trusted Types / nonce-CSP all bypassed unconditionally
      //   + script-start polyfills (WebStreams, fetch, etc.) work on
      //     strict-CSP sites that previously silently failed
      //   + sandbox compartment has fresh built-ins (page can't taint
      //     Object.prototype etc. into the script's view)
      //   + scriptSource / scriptMetaStr become lazy (memory win on
      //     large polyfills)
      //   - DevTools attributes the script as sandbox-evaluated rather
      //     than a page-loaded <script>
      //   - rare polyfills that need true page-script `eval()` realm
      //     semantics (uncommon) should add @inject-into page to opt
      //     back into the DOM-injection path
      if (runsInPage(script) && aContentWin.document.documentElement) {
        if (injectScriptIntoPage(aContentWin, script, aRunAt)) {
          noteScriptRan(aContentWin, script);
        }
      } else {
        let sandbox = createSandbox(aContentWin, url, script, aRunAt);
        runScriptInSandbox(sandbox, script);
        noteScriptRan(aContentWin, script);
      }
    } catch (e) {
      let scriptName = script.localized && script.localized.name
          ? script.localized.name : script.id;
      GM_util.logError(
          "Error injecting script " + JSON.stringify(scriptName)
          + " at " + aRunAt + ":\n" + e,
          false, e.fileName, e.lineNumber);
    }
  }
}

/**
 * Convenience wrapper: look up matching scripts for the given URL and
 * run-at phase, then inject them.
 *
 * @param {string} aRunAt
 * @param {Window} aContentWin
 */
function runScripts(aRunAt, aContentWin) {
  let url = urlForWin(aContentWin);
  if (!url) {
    return undefined;
  }
  if (!GM_util.isGreasemonkeyable(url)) {
    return undefined;
  }
  let scripts = IPCScript.scriptsForUrl(
      url, aRunAt, GM_util.windowId(aContentWin, "outer"));
  injectScripts(scripts, aRunAt, aContentWin);
}


/**
 * Whether a document-start script runs at TOPIC_EARLY, before the page has
 * any element: sandbox scripts without @require.  Scripts that need the
 * page's DOM (@grant none, @inject-into page, unless @inject-into content)
 * and those with @require (jQuery etc.) wait for TOPIC_NORMAL.
 *
 * @param {IPCScript} aScript
 * @returns {boolean}
 */
function runsEarly(aScript) {
  let needsPageContext = aScript.grants.includes("none")
      || (aScript.injectInto == "page");
  if (aScript.injectInto == "content") {
    needsPageContext = false;
  }
  return !needsPageContext
      && (!aScript.requires || (aScript.requires.length == 0));
}

/**
 * Handles a new content document at its earliest observable moment.
 * Splits into two cases per observer topic:
 *
 *   TOPIC_EARLY:
 *     Fires before DOM parsing.  Runs document-start scripts that
 *     fit the sandbox path AND have no @require dependencies (jQuery
 *     etc. need a DOM, so they defer).  @grant none / @inject-into
 *     page scripts also defer — they need a real documentElement.
 *
 *   TOPIC_NORMAL:
 *     Fires when the <html> element exists.  Sets up the per-window
 *     DOMContentLoaded / load listeners for document-end + document-
 *     idle, runs document-body via MutationObserver, and either
 *     finishes the document-start phase (if early didn't catch it)
 *     or runs only the deferred document-start scripts.
 *
 * @param {Window} aContentWin
 * @param {string} aTopic
 */
function contentObserver(aContentWin, aTopic) {
  if (!GM_util.getEnabled()) {
    return undefined;
  }

  if (aTopic === TOPIC_EARLY) {
    // documentURI may still be "about:blank" here; location.href is
    // already the navigation target so use it for matching.
    let earlyUrl;
    try {
      earlyUrl = aContentWin.location.href;
    } catch (e) {
      return undefined;
    }
    if (!earlyUrl || !GM_util.isGreasemonkeyable(earlyUrl)) {
      return undefined;
    }

    let scripts = IPCScript.scriptsForUrl(
        earlyUrl, "document-start",
        GM_util.windowId(aContentWin, "outer"));
    let earlyScripts = scripts.filter(runsEarly);
    if (earlyScripts.length > 0) {
      injectScripts(earlyScripts, "document-start", aContentWin);
      // The document this window has now (the notification comes after
      // the window gets its new document).
      gEarlyStartDocs.add(aContentWin.document);
    }
    return undefined;
  }

  // TOPIC_NORMAL — document-element-inserted.
  let doc = aContentWin.document;
  let url = doc.documentURI;
  if (!GM_util.isGreasemonkeyable(url)) {
    return undefined;
  }

  aContentWin.addEventListener("DOMContentLoaded", contentLoad, true);
  aContentWin.addEventListener("load", contentLoad, true);

  // window.onurlchange (SPA navigation events): announce support and begin
  // the read-only location monitor before any document-start script runs.
  setupUrlChangeMonitor(aContentWin);

  if (!gEarlyStartDocs.has(doc)) {
    // Early did nothing for this document — run all document-start
    // scripts normally.
    runScripts("document-start", aContentWin);
  } else {
    // Early ran the sandbox-no-require subset.  Run the rest now.
    gEarlyStartDocs.delete(doc);
    let deferredUrl = urlForWin(aContentWin);
    if (deferredUrl) {
      let deferredScripts = IPCScript.scriptsForUrl(
          deferredUrl, "document-start",
          GM_util.windowId(aContentWin, "outer")).filter(function (s) {
            return !runsEarly(s);
          });
      if (deferredScripts.length > 0) {
        injectScripts(deferredScripts, "document-start", aContentWin);
      }
    }
  }
  gStartRanDocs.add(doc);

  // @run-at document-body — fire when <body> first appears.
  if (doc.body) {
    runScripts("document-body", aContentWin);
  } else {
    try {
      let bodyObserver = new aContentWin.MutationObserver(function (aMutations) {
        for (let i = 0; i < aMutations.length; i++) {
          let addedNodes = aMutations[i].addedNodes;
          for (let j = 0; j < addedNodes.length; j++) {
            if (addedNodes[j].nodeName
                && addedNodes[j].nodeName.toLowerCase() == "body") {
              bodyObserver.disconnect();
              runScripts("document-body", aContentWin);
              return undefined;
            }
          }
        }
      });
      bodyObserver.observe(doc.documentElement || doc, {
        "childList": true,
        "subtree": true,
      });
    } catch (e) {
      // Fallback: covered by document-end later.
    }
  }
}

/**
 * Per-window DOMContentLoaded / load handler.  Self-removes so each
 * fires exactly once.  Runs document-end immediately and queues
 * document-idle for 50 ms later — the 50 ms gap matches the timing
 * that userscripts in the wild depend on.
 *
 * Only the browser's own events for the document count: the capturing
 * "load" listener also hears every <img> / <script> / <iframe> load (it
 * threw on each, as their target has no defaultView), and a page could
 * fire a fake DOMContentLoaded to run document-end scripts early.
 */
function contentLoad(aEvent) {
  let doc = aEvent.target;
  if (!aEvent.isTrusted || !doc || (doc.nodeType !== 9)) {
    return undefined;
  }
  let aContentWin = doc.defaultView;
  if (!aContentWin) {
    return undefined;
  }
  aContentWin.removeEventListener("DOMContentLoaded", contentLoad, true);
  aContentWin.removeEventListener("load", contentLoad, true);

  // For about: pages whose document-start phase didn't run (bug #1820,
  // #2371, #2195), run it now; never a second time (about:reader ran its
  // document-start scripts twice).
  try {
    let href = aContentWin.location.href;
    if (!gStartRanDocs.has(doc) && isWindowVisible(aContentWin)
        && ((href == GM_CONSTANTS.urlAboutPart1)
            || (href && href.match(URL_ABOUT_PART2_REGEXP)))) {
      gStartRanDocs.add(doc);
      runScripts("document-start", aContentWin);
    }
  } catch (e) {
    // location access can throw on torn-down windows.
  }

  runScripts("document-end", aContentWin);
  GM_util.timeout(function () {
    runScripts("document-idle", aContentWin);
  }, 50);

  // Deliberately no re-run when Back/Forward restores this page from the
  // bfcache (pageshow with persisted = true).  The restored page still
  // holds every script's live state, its listeners and menu commands, so
  // running a script again would make a second instance with doubled side
  // effects.  Firefox/Chrome content scripts, Violentmonkey and
  // Tampermonkey don't re-run either.  A script that wants to react to a
  // restore can listen for pageshow itself.
  return undefined;
}


/**
 * Attaches a read-only URL-change monitor to a page so scripts can observe
 * SPA navigations via window.addEventListener("urlchange", fn) or the
 * window.onurlchange property (Tampermonkey-compatible).  The support
 * sentinel is `window.onurlchange === null` (undefined when the feature is
 * disabled by pref).  The event has the new address as `url` (Tampermonkey
 * scripts read `info.url`) and as `detail.url`.
 *
 * Implementation notes:
 *   - One monitor per document: every page of a tab gets its own (a
 *     WeakSet of windows gave only a tab's first page one), with its own
 *     starting address (the old one's fired a false event about a second
 *     after each navigation) and its own listeners.
 *   - Read-only: it never patches history.pushState, so it cannot break a
 *     page's own navigation.  popstate / hashchange are handled at once;
 *     a ~1s location poll catches pushState / replaceState routes.
 *   - The poll stops when the window closes or shows another page; the
 *     whole monitor is gated by the api.window.onurlchange pref.
 *   - The sentinel and the handler here are the page's own (page-mode and
 *     @grant none scripts share them).  A sandbox with GM APIs can't see
 *     those through its X-ray view of window, so sandbox.js gives each one
 *     its own (installUrlChangeSupport there).
 *
 * @param {Window} aContentWin
 */
function setupUrlChangeMonitor(aContentWin) {
  if (!GM_prefRoot.getValue("api.window.onurlchange", true)) {
    return undefined;
  }
  let doc;
  try {
    doc = aContentWin.document;
  } catch (e) {
    return undefined;
  }
  if (!doc || gUrlChangeDocs.has(doc)) {
    return undefined;
  }
  gUrlChangeDocs.add(doc);

  let waived;
  try {
    waived = Cu.waiveXrays(aContentWin);
    // Support sentinel (TM detection: window.onurlchange === null).
    if (typeof waived.onurlchange === "undefined") {
      waived.onurlchange = null;
    }
  } catch (e) {
    return undefined;
  }

  let lastHref;
  try {
    lastHref = aContentWin.location.href;
  } catch (e) {
    return undefined;
  }

  /** @returns {boolean} Whether the window still shows this page. */
  function current() {
    try {
      return !GM_util.windowIsClosed(aContentWin)
          && (aContentWin.document === doc);
    } catch (e) {
      return false;
    }
  }

  function fire() {
    if (!current()) {
      return undefined;
    }
    let href;
    try {
      href = aContentWin.location.href;
    } catch (e) {
      return undefined;
    }
    if (href === lastHref) {
      return undefined;
    }
    lastHref = href;
    try {
      let ev = new aContentWin.CustomEvent("urlchange", {
        "detail": Cu.cloneInto({ "url": href }, aContentWin),
      });
      // For the page's own listeners (sandboxes add theirs, sandbox.js).
      Cu.waiveXrays(ev).url = href;
      aContentWin.dispatchEvent(ev);
    } catch (e) {
      // Best effort.
    }
    try {
      let handler = waived.onurlchange;
      if (typeof handler === "function") {
        handler.call(waived, Cu.cloneInto({ "url": href }, aContentWin));
      }
    } catch (e) {
      // Script handler threw; ignore.
    }
    return undefined;
  }

  try {
    aContentWin.addEventListener("popstate", fire, true);
    aContentWin.addEventListener("hashchange", fire, true);
  } catch (e) {
    // Best effort; the poll below still catches changes.
  }

  function pollTick() {
    if (!current()) {
      return undefined;
    }
    fire();
    GM_util.timeout(pollTick, 1000);
    return undefined;
  }
  GM_util.timeout(pollTick, 1000);
  return undefined;
}


/**
 * Top-level Services.obs handler.  Filters subject to chrome vs
 * content windows (only the latter get script injection) and routes
 * by topic.
 */
const injectorObserver = {
  "observe": function (aSubject, aTopic, aData) {
    let enabled = GM_util.getEnabled();
    if (!enabled && (aTopic !== TOPIC_NORMAL)) {
      return undefined;
    }
    let aContentWin;
    if (aTopic === TOPIC_EARLY) {
      // aData != "null" guards against about:blank framers that don't
      // have a real document yet.
      if (!aData || aData == "null") {
        return undefined;
      }
      aContentWin = aSubject;
    } else if (aTopic === TOPIC_NORMAL) {
      let doc = aSubject;
      aContentWin = doc && doc.defaultView;
    } else {
      return undefined;
    }
    if (!aContentWin) {
      return undefined;
    }
    // Skip chrome windows; their JS lifecycle isn't ours to touch.
    try {
      aContentWin.QueryInterface(Ci.nsIDOMChromeWindow);
      return undefined;
    } catch (e) {
      // Not a chrome window — proceed.
    }
    if (!enabled) {
      offerInstallWhileDisabled(aContentWin);
      return undefined;
    }
    contentObserver(aContentWin, aTopic);
  },
};

/**
 * While Greasemonkey is switched off, a .user.js opened in a tab shows as
 * text.  This offers, in that tab, to switch Greasemonkey on and install
 * it (GM_BrowserUI.checkDisabledScriptNavigation, which checks the address
 * and type).  It used to be reachable only from contentLoad, whose
 * listeners are never attached while Greasemonkey is off.
 *
 * @param {Window} aContentWin - A page whose root element just appeared.
 */
function offerInstallWhileDisabled(aContentWin) {
  try {
    let doc = aContentWin.document;
    if (!windowIsTop(aContentWin)
        || (doc.documentURI.indexOf(GM_CONSTANTS.fileScriptExtension) == -1)) {
      return undefined;
    }
    let chromeWin = getChromeWinForContentWin(aContentWin);
    if (!chromeWin || !chromeWin.GM_BrowserUI || !chromeWin.gBrowser) {
      return undefined;
    }
    chromeWin.GM_BrowserUI.checkDisabledScriptNavigation(
        doc.contentType, doc.documentURI,
        chromeWin.gBrowser.getBrowserForDocument(doc));
  } catch (e) {
    GM_util.logError(e, true, e.fileName || null, e.lineNumber || 0);
  }
  return undefined;
}


/**
 * Wires up the observer.  Called once from components/greasemonkey.js
 * at profile-after-change startup; subsequent calls are no-ops.
 */
function startScriptInjector() {
  if (gStarted) {
    return undefined;
  }
  gStarted = true;
  Services.obs.addObserver(injectorObserver, TOPIC_EARLY, false);
  Services.obs.addObserver(injectorObserver, TOPIC_NORMAL, false);
}


/**
 * Injects a script that just finished updating mid-page-load.  Called
 * directly from modules/script.js.
 *
 * The browser element is used as the primary content-window source;
 * if a specific frame is targeted we look it up via nsIWindowMediator
 * by outer-window ID.  Falls back to the browser's top contentWindow.
 *
 * @param {IPCScript|object} aScript    - Script descriptor.  May be a
 *   bare object whose prototype is not IPCScript; we lift it onto
 *   IPCScript.prototype so info() / matchesURL() are callable.
 * @param {string}           aRunAt
 * @param {number|null}      aWindowId  - Outer window ID, or null.
 * @param {Element}          aBrowser   - Chrome <browser> element.
 */
function injectDelayedScript(aScript, aRunAt, aWindowId, aBrowser) {
  let win = null;
  if (aWindowId) {
    try {
      let windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
          .getService(Ci.nsIWindowMediator);
      win = windowMediator.getOuterWindowWithId(aWindowId);
    } catch (e) {
      win = null;
    }
  }
  if (!win && aBrowser) {
    try {
      win = aBrowser.contentWindow;
    } catch (e) {
      win = null;
    }
  }
  if (!win) {
    GM_util.logError(
        "scriptInjector.injectDelayedScript: no window for ID " + aWindowId,
        true, null, 0);
    return undefined;
  }

  // Lift a bare descriptor onto IPCScript.prototype so the dispatch
  // path can call .info() / .matchesURL() through the canonical class.
  let script = aScript;
  if (!(script instanceof IPCScript)) {
    let lifted = Object.create(IPCScript.prototype);
    for (let key in aScript) {
      lifted[key] = aScript[key];
    }
    script = lifted;
  }

  injectScripts([script], aRunAt, win);
}
