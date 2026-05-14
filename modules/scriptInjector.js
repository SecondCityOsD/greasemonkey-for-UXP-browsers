/**
 * @file scriptInjector.js
 * @overview Chrome-side script-injection driver.
 *
 * This module is the Phase 4f-3 replacement for content/frameScript.js.
 * It owns every step of the path from "new document seen" to "user script
 * running in its sandbox":
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
 * On UXP single-process this all runs in chrome scope; the framescript
 * indirection (loadFrameScript + sendAsyncMessage) that the Era-2
 * multi-process design required is gone — the IPC was a no-op detour
 * since chrome and content share a JS runtime.
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
 *     the toolbar popup and tooltip (formerly the "greasemonkey:frame-
 *     urls" IPC round-trip handled by modules/processScript.js).
 */

const EXPORTED_SYMBOLS = [
  "startScriptInjector",
  "injectDelayedScript",
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
 * Tracks windows where document-start scripts have already been
 * injected via the early observer, so the normal observer can skip
 * them and only run deferred scripts.  WeakSet → no GC retention.
 *
 * @type {WeakSet<Window>}
 */
var gEarlyStartWindows = new WeakSet();

/**
 * Idempotency flag for startScriptInjector().  Re-registering the
 * Services.obs observer would cause every document event to fire our
 * handler twice.
 */
var gStarted = false;


/**
 * Determines whether a content window is visible enough that scripts
 * should run in it.  The pre-Phase-4f check was specific to multi-
 * process e10s; on UXP single-process the same nsIDOMWindowUtils
 * fallback still serves the rare "tab-being-restored" case where the
 * parent widget is not yet attached.
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
 * Returns true iff aContentWin is the top of its frame tree.  Mirrors
 * the frameScript implementation; a non-DOM window (rare) is treated
 * as "top" defensively.
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
 * aContentWin.  Replaces the "greasemonkey:frame-urls" IPC round-trip
 * that used to bounce through modules/processScript.js for the
 * toolbar-popup and tooltip code in content/browser.js.
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
      urls = urls.concat(urlsOfAllFrames(frames[i]));
    }
  } catch (e) {
    // Cross-origin frame access denied — skip silently.
  }
  return urls;
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
    return;
  }

  // 4) Prepare script body + GM_info JSON.
  let scriptCode;
  try {
    scriptCode = GM_util.fileXhr(aScript.fileURL, "application/javascript");
  } catch (e) {
    GM_util.logError(
        "Error loading script " + aScript.fileURL
        + ":\n" + e, false, e.fileName, e.lineNumber);
    return;
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
  let safeGlobalsSnapshot =
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
  injectCode(wrappedCode, aScript.fileURL);
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
      if ((script.grants.includes("none") || script.injectInto == "page")
          && script.injectInto != "content"
          && aContentWin.document.documentElement) {
        injectScriptIntoPage(aContentWin, script, aRunAt);
      } else {
        let sandbox = createSandbox(aContentWin, url, script, aRunAt);
        runScriptInSandbox(sandbox, script);
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
    // Only sandbox scripts without @require run this early; everything
    // else needs DOM and is deferred to TOPIC_NORMAL.
    let earlyScripts = scripts.filter(function (s) {
      let needsPageContext = s.grants.includes("none")
          || s.injectInto == "page";
      if (s.injectInto == "content") needsPageContext = false;
      return !needsPageContext
          && (!s.requires || s.requires.length == 0);
    });
    if (earlyScripts.length > 0) {
      injectScripts(earlyScripts, "document-start", aContentWin);
      gEarlyStartWindows.add(aContentWin);
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

  if (!gEarlyStartWindows.has(aContentWin)) {
    // Early did nothing — run all document-start scripts normally.
    runScripts("document-start", aContentWin);
  } else {
    // Early ran the sandbox-no-require subset.  Run the rest now.
    gEarlyStartWindows.delete(aContentWin);
    let deferredUrl = urlForWin(aContentWin);
    if (deferredUrl) {
      let allStartScripts = IPCScript.scriptsForUrl(
          deferredUrl, "document-start",
          GM_util.windowId(aContentWin, "outer"));
      let deferredScripts = allStartScripts.filter(function (s) {
        let needsPageContext = s.grants.includes("none")
            || s.injectInto == "page";
        if (s.injectInto == "content") needsPageContext = false;
        return needsPageContext
            || (s.requires && s.requires.length > 0);
      });
      if (deferredScripts.length > 0) {
        injectScripts(deferredScripts, "document-start", aContentWin);
      }
    }
  }

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
 * document-idle for 50 ms later, matching the original framescript
 * semantics that scripts in the wild depend on.
 */
function contentLoad(aEvent) {
  let aContentWin = aEvent.target.defaultView;
  aContentWin.removeEventListener("DOMContentLoaded", contentLoad, true);
  aContentWin.removeEventListener("load", contentLoad, true);

  runScripts("document-end", aContentWin);
  GM_util.timeout(function () {
    runScripts("document-idle", aContentWin);
  }, 50);

  // Back/forward-cache awareness: when the user navigates BACK to a
  // page that's still resident in BFCache, the browser restores the
  // existing window without firing DOMContentLoaded/load again (the
  // listeners above also self-removed on the initial fire).  Result
  // pre-fix: scripts never re-ran on bfcache, so userscripts that
  // applied styling / replaced page elements would silently lose
  // their work when the user came back.
  //
  // The pageshow event IS dispatched on bfcache restoration with
  // event.persisted = true, so we hook it here once per page-load
  // lifecycle.  Initial-load pageshow (persisted = false) is filtered
  // out since the document-end / document-idle scripts just ran above.
  //
  // Re-runs document-end + document-idle but NOT document-start —
  // the latter only makes sense before the DOM exists, and the DOM
  // is already there on bfcache restore.  Matches the standard TM/VM
  // bfcache behaviour (idempotent userscripts are the norm; those
  // that aren't can guard with `if (!document.getElementById(...))`).
  aContentWin.addEventListener("pageshow", function pageshowRerun(aPageshow) {
    if (!aPageshow.persisted) {
      return;
    }
    if (!GM_util.getEnabled()) {
      return;
    }
    runScripts("document-end", aContentWin);
    GM_util.timeout(function () {
      runScripts("document-idle", aContentWin);
    }, 50);
  }, true);

  // Special-case for the "about:" URLs whose document lifecycle didn't
  // fire content-document-global-created / document-element-inserted
  // in the expected order (bug #1820, #2371, #2195).  If GM is
  // disabled, instead surface the navigation to the chrome UI so it
  // can render the "scripts are disabled" affordance.
  try {
    let href = aContentWin.location.href;
    if ((href == GM_CONSTANTS.urlAboutPart1)
        || (href && href.match(URL_ABOUT_PART2_REGEXP))) {
      if (!GM_util.getEnabled()) {
        // Was: framescript's gScope.sendAsyncMessage(
        //   "greasemonkey:DOMContentLoaded", { contentType, href });
        // which the chrome browser.js listened for and routed to
        // GM_BrowserUI.checkDisabledScriptNavigation.  Direct call.
        try {
          let chromeWin = getChromeWinForContentWin(aContentWin);
          if (chromeWin && chromeWin.GM_BrowserUI
              && typeof chromeWin.GM_BrowserUI.checkDisabledScriptNavigation
                  === "function") {
            chromeWin.GM_BrowserUI.checkDisabledScriptNavigation(
                aContentWin.document.contentType, href);
          }
        } catch (e) {
          GM_util.logError(e, true, e.fileName || null, e.lineNumber || 0);
        }
      } else if (isWindowVisible(aContentWin)) {
        // For about: URLs the document-element-inserted path may not
        // have fired document-start — run it now defensively.
        runScripts("document-start", aContentWin);
      }
    }
  } catch (e) {
    // location access can throw on torn-down windows.
  }
}


/**
 * Top-level Services.obs handler.  Filters subject to chrome vs
 * content windows (only the latter get script injection) and routes
 * by topic.
 */
const injectorObserver = {
  "observe": function (aSubject, aTopic, aData) {
    if (!GM_util.getEnabled()) {
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
    contentObserver(aContentWin, aTopic);
  },
};


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
 * directly from modules/script.js (formerly via the
 * "greasemonkey:inject-delayed-script" mm message to the framescript).
 *
 * The browser element is used as the primary content-window source;
 * if a specific frame is targeted we look it up via nsIWindowMediator
 * by outer-window ID.  Falls back to the browser's top contentWindow.
 *
 * @param {IPCScript|object} aScript    - Script descriptor.  May be a
 *   bare object if it came over what used to be IPC; we lift it onto
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
