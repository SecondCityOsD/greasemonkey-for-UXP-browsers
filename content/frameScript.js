// The frame script for Electrolysis (e10s) compatible injection.
//   See: https://developer.mozilla.org/en-US/Firefox/Multiprocess_Firefox
if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("chrome://greasemonkey-modules/content/documentObserver.js");
Cu.import("chrome://greasemonkey-modules/content/GM_setClipboard.js");
Cu.import("chrome://greasemonkey-modules/content/ipcScript.js");
Cu.import("chrome://greasemonkey-modules/content/menuCommand.js");
Cu.import("chrome://greasemonkey-modules/content/miscApis.js");
Cu.import("chrome://greasemonkey-modules/content/sandbox.js");
Cu.import("chrome://greasemonkey-modules/content/scriptProtocol.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

Cu.import("chrome://greasemonkey-modules/content/processScript.js", {})
    .addFrame(this);


// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

const URL_ABOUT_PART2_REGEXP = new RegExp(
    GM_CONSTANTS.urlAboutPart2Regexp, "");
const URL_USER_PASS_STRIP_REGEXP = new RegExp(
    GM_CONSTANTS.urlUserPassStripRegexp, "");

var gScope = this;
var _gEnvironment = GM_util.getEnvironment();

// Observer topic constants for per-script early injection.
const TOPIC_EARLY = "content-document-global-created";
const TOPIC_NORMAL = "document-element-inserted";

// Tracks windows where document-start scripts have already been injected
// via the early observer, so the normal observer can skip them.
var gEarlyStartWindows = new WeakSet();

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

function contentObserver(aWin, aTopic) {
  if (!GM_util.getEnabled()) {
    return undefined;
  }

  if (aTopic === TOPIC_EARLY) {
    // Early observer (content-document-global-created): run only
    // document-start scripts that need privileged APIs (not @grant none).
    // @grant none scripts are deferred to document-element-inserted where
    // they get page-context injection via <script> elements (needs DOM).
    //
    // At this point document.documentURI may still be "about:blank"
    // because the document hasn't been assigned its final URI yet.
    // However, location.href is already set to the navigation target,
    // so use that for URL matching.
    let earlyUrl = aWin.location.href;
    if (!earlyUrl || !GM_util.isGreasemonkeyable(earlyUrl)) {
      return undefined;
    }

    let scripts = IPCScript.scriptsForUrl(
        earlyUrl, "document-start", GM_util.windowId(aWin, "outer"));
    // Only inject scripts at this very early timing if they:
    //   1. Don't need page-context injection (@inject-into page needs DOM)
    //   2. Have NO @require dependencies (libraries like jQuery need DOM)
    // Everything else is deferred to document-element-inserted.
    let earlyScripts = scripts.filter(function (s) {
      return s.injectInto != "page"
          && (!s.requires || s.requires.length == 0);
    });
    if (earlyScripts.length > 0) {
      injectScripts(earlyScripts, "document-start", aWin);
    }
    // Mark the window so the normal observer knows which scripts were
    // already handled. Store the count of early-injected scripts.
    if (earlyScripts.length > 0) {
      gEarlyStartWindows.add(aWin);
    }
    return undefined;
  }

  // Normal observer (document-element-inserted): set up listeners for
  // document-end and document-idle, and run document-start as a fallback
  // if the early observer did not already handle it.
  let doc = aWin.document;
  let url = doc.documentURI;
  if (!GM_util.isGreasemonkeyable(url)) {
    return undefined;
  }

  aWin.addEventListener("DOMContentLoaded", contentLoad, true);
  aWin.addEventListener("load", contentLoad, true);

  if (!gEarlyStartWindows.has(aWin)) {
    // No early injection happened — run all document-start scripts normally.
    runScripts("document-start", aWin);
  } else {
    // Early injection already ran scripts without @require that don't
    // need page-context.  Now run the deferred ones: @inject-into page
    // scripts and scripts with @require dependencies (need DOM).
    gEarlyStartWindows.delete(aWin);
    let deferredUrl = urlForWin(aWin);
    if (deferredUrl) {
      let allStartScripts = IPCScript.scriptsForUrl(
          deferredUrl, "document-start", GM_util.windowId(aWin, "outer"));
      let deferredScripts = allStartScripts.filter(function (s) {
        return s.injectInto == "page"
            || (s.requires && s.requires.length > 0);
      });
      if (deferredScripts.length > 0) {
        injectScripts(deferredScripts, "document-start", aWin);
      }
    }
  }

  // @run-at document-body: fire when <body> first appears.
  // If <body> already exists, run immediately; otherwise use MutationObserver.
  if (doc.body) {
    runScripts("document-body", aWin);
  } else {
    try {
      let bodyObserver = new aWin.MutationObserver(function (aMutations) {
        for (let i = 0; i < aMutations.length; i++) {
          let addedNodes = aMutations[i].addedNodes;
          for (let j = 0; j < addedNodes.length; j++) {
            if (addedNodes[j].nodeName
                && addedNodes[j].nodeName.toLowerCase() == "body") {
              bodyObserver.disconnect();
              runScripts("document-body", aWin);
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
      // Fallback: run at document-end time instead.
    }
  }
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

// See #1696:
// "document-element-inserted" doesn't see about:blank
// "content-document-global-created" sees about:blank,
// but:
// aSubject.document.documentURI = "about:blank"
// aData = null

// See #2229 (#2357).
// http://bugzil.la/1196270
// about:blank, the script with alert function
// - after the restart, the browser hangs
/*  
let response = gScope.sendSyncMessage("greasemonkey:is-window-visible", {});
let isWindowVisible = true;
if (response.length) {
  isWindowVisible = response[0];
}
if (!isWindowVisible) {
  return undefined;
}
*/

// http://bugzil.la/1357383
function isWindowVisible(aContentWin) {
  // let _gEnvironment = GM_util.getEnvironment();
  if (!_gEnvironment.e10s) {
    // See #2229.
    // http://bugzil.la/1196270
    if (aContentWin) {
      let winUtils = aContentWin.QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindowUtils);
      try {
        if (winUtils && !winUtils.isParentWindowMainWidgetVisible) {
          return false;
        }
      } catch (e) {
        return false;
      }
    }
  }

  return true;
}

function browserLoadEnd(aEvent) {
  let contentWin = aEvent.target.defaultView;
  let href = contentWin.location.href;

  if (GM_util.getEnabled()) {
    // See #1820, #2371, #2195.
    if ((href == GM_CONSTANTS.urlAboutPart1)
        || (href.match(URL_ABOUT_PART2_REGEXP))) {
      if (!isWindowVisible(contentWin)) {
        return undefined;
      }
      runScripts("document-end", contentWin);
      runScripts("document-idle", contentWin);
    }
  } else {
    gScope.sendAsyncMessage("greasemonkey:DOMContentLoaded", {
      "contentType": contentWin.document.contentType,
      "href": href,
    });
  }
}

function contentLoad(aEvent) {
  var contentWin = aEvent.target.defaultView;

  // Now that we've seen any first load event, stop listening for any more.
  contentWin.removeEventListener("DOMContentLoaded", contentLoad, true);
  contentWin.removeEventListener("load", contentLoad, true);

  runScripts("document-end", contentWin);
  GM_util.timeout(function () {
    runScripts("document-idle", contentWin);
  }, 50);
}

function createScriptFromObject(aObject) {
  let script = Object.create(IPCScript.prototype);

  for (let key in aObject) {
    // if (aObject.hasOwnProperty(key)) {
      script[key] = aObject[key];
    // }
  }

  return script;
};

function injectDelayedScript(aMessage) {
  let runAt = aMessage.data.runAt;
  let windowId = aMessage.data.windowId;
  let windowMediator = Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator);
  let win = windowMediator.getOuterWindowWithId(windowId);

  if (!win) {
    dump("Framescript: Couldn't find window with (outer?!) ID:" + " "
        + windowId + "\n");
  } else {
    let script = createScriptFromObject(aMessage.data.script);
    injectScripts([script], runAt, win);
  }
};

/**
 * Injects a @grant none script directly into the page context via a <script>
 * element.  This matches Violentmonkey/Tampermonkey behavior: the script runs
 * in the page's global scope so writes to `window` are visible to page JS.
 *
 * @param {Window}    aContentWin - The content window to inject into.
 * @param {IPCScript} aScript     - The script to inject.
 */
function injectScriptIntoPage(aContentWin, aScript) {
  let doc = aContentWin.document;
  let parent = doc.documentElement || doc;

  /**
   * Helper: injects a single piece of code as a <script> element.
   * Returns true on success, false if blocked (e.g. by CSP).
   */
  function injectCode(aCode, aSourceHint) {
    try {
      let el = doc.createElement("script");
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

  // 1) Inject GM_info and unsafeWindow declarations.
  let gmInfoJson = "{}";
  try {
    gmInfoJson = JSON.stringify(aScript.info());
  } catch (e) {
    // Fall back to empty object if serialization fails.
  }
  if (!injectCode(
      "var GM_info = " + gmInfoJson + ";\n"
      + "var unsafeWindow = window;",
      "GM_info")) {
    // CSP blocked <script> injection — fall back to sandbox.
    let sandbox = createSandbox(gScope, aContentWin,
        aContentWin.document.documentURI, aScript, "document-end");
    runScriptInSandbox(sandbox, aScript);
    return undefined;
  }

  // 2) Inject each @require as a separate <script> element.
  //    This matches VM/TM behavior and ensures libraries like jQuery
  //    execute in the correct document context.
  for (let i = 0; i < aScript.requires.length; i++) {
    try {
      let code = GM_util.fileXhr(
          aScript.requires[i].fileURL, "application/javascript");
      injectCode(code, aScript.requires[i].fileURL);
    } catch (e) {
      GM_util.logError(
          "Error loading @require " + aScript.requires[i].fileURL
          + ":\n" + e, false, e.fileName, e.lineNumber);
    }
  }

  // 3) Inject the script itself.
  try {
    let scriptCode = GM_util.fileXhr(
        aScript.fileURL, "application/javascript");
    injectCode(scriptCode, aScript.fileURL);
  } catch (e) {
    GM_util.logError(
        "Error loading script " + aScript.fileURL
        + ":\n" + e, false, e.fileName, e.lineNumber);
  }
}

function injectScripts(aScripts, aRunAt, aContentWin) {
  try {
    aContentWin.QueryInterface(Ci.nsIDOMChromeWindow);
    // Never ever inject scripts into a chrome context window.
    return undefined;
  } catch (e) {
    // Ignore, it's good if we can't QI to a chrome window.
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
      if (script.injectInto == "page"
          && aContentWin.document.documentElement) {
        // @inject-into page: inject directly into page context via <script>
        // element.  Only used when explicitly requested — page-context
        // injection can interfere with page JS if not intended.
        injectScriptIntoPage(aContentWin, script);
      } else {
        let sandbox = createSandbox(gScope, aContentWin, url, script, aRunAt);
        runScriptInSandbox(sandbox, script);
      }
    } catch (e) {
      // Log but continue — one script's failure must not block others.
      let scriptName = script.localized && script.localized.name
          ? script.localized.name : script.id;
      GM_util.logError(
          "Error injecting script " + JSON.stringify(scriptName)
          + " at " + aRunAt + ":\n" + e,
          false, e.fileName, e.lineNumber);
    }
  }
}

function contextMenuStart(aMessage) {
  let culprit = aMessage.objects.culprit;

  while (culprit && culprit.tagName && (culprit.tagName.toLowerCase() != "a")) {
    culprit = culprit.parentNode;
  }

  aMessage.target.sendAsyncMessage(
      "greasemonkey:context-menu-end", {
        "href": culprit.href,
      });
}

function newScriptLoadStart(aMessage) {
  aMessage.target.sendAsyncMessage(
      "greasemonkey:newscript-load-end", {
        "href": content.location.href,
      });
}

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

function urlForWin(aContentWin) {
  if (GM_util.windowIsClosed(aContentWin)) {
    return false;
  }
  // See #1970.
  // When content does (e.g.) history.replacestate() in an inline script,
  // the location.href changes between document-start and document-end time.
  // But the content can call replacestate() much later, too.
  // The only way to be consistent is to ignore it.
  // Luckily, the document.documentURI does _not_ change,
  // so always use it when deciding whether to run scripts.
  let url = aContentWin.document.documentURI;

  // At very early injection (content-document-global-created),
  // documentURI may still be "about:blank" while location.href already
  // holds the real navigation target.  Fall back to location.href so
  // that document-start scripts can match the correct URL.
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

  // But (see #1631) ignore user/pass in the URL.
  return url.replace(URL_USER_PASS_STRIP_REGEXP, "$1");
}

function windowIsTop(aContentWin) {
  try {
    aContentWin.QueryInterface(Ci.nsIDOMWindow);
    if (aContentWin.frameElement) {
      return false;
    }
  } catch (e) {
    let url = "unknown";
    try {
      url = aContentWin.location.href;
    } catch (e) { }
    // Ignore non-DOM-windows.
    dump("Framescript: Could not QI window to nsIDOMWindow (?!) at:" + "\n"
        + url + "\n");
  }

  return true;
};

function windowCreated(aEvent) {
  if (aEvent && GM_util.getEnabled()) {
    // See #1849.
    let contentWin = aEvent.target.defaultView;
    let href = contentWin.location.href;
    // See #1820, #2371, #2195.
    if ((href == GM_CONSTANTS.urlAboutPart1)
        || (href.match(URL_ABOUT_PART2_REGEXP))) {
      if (!isWindowVisible(contentWin)) {
        return undefined;
      }
      runScripts("document-start", contentWin);
    }
  }

  onNewDocument(content, contentObserver);
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

addEventListener("DOMContentLoaded", browserLoadEnd, false);
addEventListener("DOMWindowCreated", windowCreated, false);

if (content) {
  windowCreated(null);
}

addMessageListener("greasemonkey:inject-delayed-script", injectDelayedScript);
addMessageListener("greasemonkey:menu-command-list", function (aMessage) {
  MenuCommandListRequest(content, aMessage);
});
addMessageListener("greasemonkey:menu-command-run", function (aMessage) {
  MenuCommandRun(content, aMessage);
});
addMessageListener("greasemonkey:context-menu-start", contextMenuStart);
addMessageListener("greasemonkey:newscript-load-start", newScriptLoadStart);

initScriptProtocol();
