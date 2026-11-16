/**
 * @file miscApis.js
 * @overview Miscellaneous GM_* API implementations that don't warrant their
 *   own file:
 *
 *   GM_addStyle(aWrappedContentWin, aFileURL, aRunAt, aCss)
 *     Injects a <style> element into the page's <head>.  At document-start
 *     (before <head> exists), uses a MutationObserver to inject as soon as
 *     <head> is created (see bugs #2515 and #1849).
 *
 *   GM_console(aScript)
 *     Minimal Firebug-style console shim.  All methods except log() are no-ops.
 *     log() prefixes messages with "<namespace>/<name>: " and writes to the
 *     XPCOM console service.
 *
 *   GM_Resources(aScript)
 *     Provides GM_getResourceText() and GM_getResourceURL() for @resource
 *     entries declared in the script metadata.
 *
 *   GM_ScriptLogger(aScript)
 *     Low-level logger used by GM_log() and GM_console.log().
 *     Writes to nsIConsoleService with a script-name prefix.
 *
 *   GM_window(aContentWin, aFileURL, aWhat)
 *     Implements GM_windowClose() and GM_windowFocus() by calling
 *     GM_BrowserUI.window directly on the chrome window that owns
 *     aContentWin.  Direct invocation (rather than a frame-message
 *     round-trip) is correct here because UXP is single-process.
 */

const EXPORTED_SYMBOLS = [
    "GM_addElement", "GM_addStyle", "GM_console", "GM_Resources",
    "GM_ScriptLogger", "GM_window"];

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

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/cspNonce.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// Element tag names that carry executable content on the page and are
// therefore subject to CSP `script-src` / `style-src` enforcement.
// `GM_addElement` attaches the page's nonce attribute when injecting
// these, so the inline content slips past nonce-based CSPs that ship
// with strict directives on GitHub, Google search, news sites, etc.
const CSP_GUARDED_TAGS = { "script": "script", "style": "style" };


// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Puts aElement into aDoc at once when it can (in aParent, else <head> /
 * <body> as aPreferred says, else the root element), or else as soon as
 * the document has a root element: at document-start the earliest scripts
 * run before the page has any element (see #2515, #1849,
 * http://bugzil.la/1333990).  Either way the script gets the element at
 * once, as in Violentmonkey; it used to get null, and `s.id = ...` threw.
 *
 * @param {Window}  aWin       - The content window.
 * @param {Document} aDoc      - Its document.
 * @param {Element} aElement   - The element to insert.
 * @param {?Node}   aParent    - Where the script asked for it, or null.
 * @param {string}  aPreferred - "head" or "body".
 * @returns {Element} aElement.
 */
function insertElement(aWin, aDoc, aElement, aParent, aPreferred) {
  let parent = aParent
      || aDoc.getElementsByTagName(aPreferred)[0]
      || ((aPreferred == "head") ? aDoc.getElementsByTagName("body")[0] : null)
      || aDoc.documentElement;
  if (parent) {
    parent.appendChild(aElement);
    return aElement;
  }
  let observer = new aWin.MutationObserver(function () {
    if (aDoc.documentElement) {
      observer.disconnect();
      aDoc.documentElement.appendChild(aElement);
    }
  });
  observer.observe(aDoc, {"childList": true});
  return aElement;
}

/**
 * Injects a CSS string into the page as a <style> element: in <head>, else
 * wherever the page lets it go now (see insertElement), at every run-at
 * and in documents without a <head> (SVG, XML).
 *
 * @param {Window} aWrappedContentWin - The content window (Xray-wrapped).
 * @param {string} aFileURL           - Script URL for error attribution.
 * @param {string} aRunAt             - Script run-at phase.
 * @param {string} aCss               - The CSS text to inject.
 * @returns {HTMLStyleElement|null} The <style> element; null only without
 *   a document.
 */
function GM_addStyle(aWrappedContentWin, aFileURL, aRunAt, aCss) {
  var doc = aWrappedContentWin.document;
  if (!doc) {
    return null;
  }
  try {
    let style = doc.createElement("style");
    style.textContent = String(aCss);
    style.type = "text/css";
    // Pages with a `style-src 'nonce-…'` CSP block any <style> element
    // without a matching nonce.  No-op on pages without a nonce CSP.
    let cspNonce = getNonceForWindow(aWrappedContentWin, "style");
    if (cspNonce) {
      style.setAttribute("nonce", cspNonce);
    }
    return insertElement(aWrappedContentWin, doc, style, null, "head");
  } catch (e) {
    throw new aWrappedContentWin.Error(e.message, aFileURL, null);
  }
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Creates and injects a DOM element into the page, bypassing CSP restrictions.
 *
 * Two call forms:
 *   GM_addElement(tagName, attributes)        — appends to default parent
 *   GM_addElement(parentNode, tagName, attributes) — appends to given parent
 *
 * Default parent: <head> for script/style/link/meta, <body> for everything else.
 * At document-start, uses a MutationObserver if the target element doesn't exist.
 *
 * @param {Window}  aWrappedContentWin - Content window (bound by sandbox.js).
 * @param {string}  aFileURL           - Script file URL for error attribution.
 * @param {string}  aRunAt             - @run-at phase (for MutationObserver fallback).
 * @param {Node|string}    aParentOrTag - Parent node (3-arg form) or tag name (2-arg).
 * @param {string|object}  [aTagOrAttrs] - Tag name (3-arg) or attributes object (2-arg).
 * @param {object}  [aAttrs]           - Attributes object (3-arg form only).
 * @returns {Element|null} The element (see insertElement); null only
 *   without a document.
 */
function GM_addElement(
    aWrappedContentWin, aFileURL, aRunAt,
    aParentOrTag, aTagOrAttrs, aAttrs) {
  var doc = aWrappedContentWin.document;
  if (!doc) {
    return null;
  }

  // Detect call form: 2-arg (tag, attrs) vs 3-arg (parent, tag, attrs).
  var parentNode;
  var tagName;
  var attrs;
  if (typeof aParentOrTag == "string") {
    // 2-arg: GM_addElement("script", {textContent: "..."})
    tagName = aParentOrTag;
    attrs = aTagOrAttrs || {};
    parentNode = null;  // Will be resolved to a default below.
  } else {
    // 3-arg: GM_addElement(document.body, "div", {id: "foo"})
    parentNode = aParentOrTag;
    tagName = String(aTagOrAttrs);
    attrs = aAttrs || {};
  }

  let elem = doc.createElement(tagName);

  // If the script is injecting a <script> or <style> into a page
  // protected by a nonce-based CSP, attach the page's nonce so the
  // injected element passes the script-src / style-src check.  No-op
  // on pages without a nonce CSP — the element is then injected
  // un-attributed, which is also fine on no-CSP pages.  The script
  // author can still override via `attrs.nonce` (handled below by
  // the normal attribute application loop).
  let tagLower = (tagName || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(CSP_GUARDED_TAGS, tagLower)) {
    let cspNonce = getNonceForWindow(aWrappedContentWin, tagLower);
    if (cspNonce) {
      elem.setAttribute("nonce", cspNonce);
    }
  }

  // Apply attributes.  Call hasOwnProperty via Object.prototype so a
  // script that passes `Object.create(null)` (or any object whose own
  // `hasOwnProperty` has been shadowed) doesn't crash the API here.
  for (let key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) {
      continue;
    }
    let val = attrs[key];
    // Properties that must be set directly (not via setAttribute).
    if (key == "textContent" || key == "innerHTML") {
      elem[key] = val;
    } else {
      elem.setAttribute(key, val);
    }
  }

  // Default parent: <head> for script/style/link/meta, else <body>; at
  // document-start, wherever the page lets it go now (insertElement).
  let headTags = {"script": 1, "style": 1, "link": 1, "meta": 1};
  try {
    return insertElement(aWrappedContentWin, doc, elem, parentNode || null,
        (tagLower in headTags) ? "head" : "body");
  } catch (e) {
    throw new aWrappedContentWin.Error(e.message, aFileURL, null);
  }
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Minimal console shim for userscripts.
 * Based on the Firebug console stub pattern.
 * All standard console methods (debug, warn, error, …) are no-ops.
 * Only console.log() is wired to the XPCOM console service via GM_ScriptLogger.
 *
 * @constructor
 * @param {IPCScript} aScript - The script whose name/namespace is used as the
 *   log message prefix.
 */
function GM_console(aScript) {
  // Based on:
  // http://www.getfirebug.com/firebug/firebugx.js
  let names = [
    "debug", "warn", "error", "info", "assert", "dir", "dirxml",
    "group", "groupEnd", "time", "timeEnd", "count", "trace", "profile",
    "profileEnd"
  ];

  for (let i = 0, iLen = names.length; i < iLen; i++) {
    let name = names[i];
    this[name] = function () {};
  }

  // Important to use this private variable so that user scripts
  // can't make this call something else by redefining <this> or <logger>.
  var logger = new GM_ScriptLogger(aScript);
  this.log = function () {
    logger.log(
      Array.prototype.slice.apply(arguments).join("\n")
    );
  };
}

GM_console.prototype.log = function () {};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Provides access to the named @resource entries declared by a script.
 *
 * @constructor
 * @param {IPCScript} aScript - The script whose resources to expose.
 */
function GM_Resources(aScript) {
  this.script = aScript;
}

/**
 * Returns the text content of a named @resource.
 *
 * @param {Window}  aWrappedContentWin - Content window (for error attribution).
 * @param {Sandbox} aSandbox           - Target sandbox (for Cu.cloneInto).
 * @param {string}  aFileURL           - Script URL (for errors).
 * @param {string}  aName              - The @resource name declared in metadata.
 * @param {string}  [aResponseType]    - Optional responseType for the XHR.
 * @returns {string} The resource text, cloned into sandbox scope.
 * @throws {Error} If no resource with aName is found.
 */
GM_Resources.prototype.getResourceText = function (
    aWrappedContentWin, aSandbox, aFileURL, aName, aResponseType) {
  // Verify the existence of the resource.
  let dep = this._getDependency(aWrappedContentWin, aFileURL, aName);
  if (typeof dep.textContent != "undefined") {
    return dep.textContent;
  }
  return Cu.cloneInto(GM_util.fileXhr(
      dep.file_url, "text/plain", aResponseType), aSandbox);
};

/**
 * Returns the greasemonkey-script: URL for a named @resource:
 * greasemonkey-script:<uuid>/<encoded name>, as IPCScript makes it (the
 * name was put in as it was, which a name past ASCII never matched).
 *
 * @param {Window}    aWrappedContentWin - Content window (for error attribution).
 * @param {Sandbox}   aSandbox           - Unused; kept for API symmetry.
 * @param {IPCScript} aScript            - The owning script (provides UUID).
 * @param {string}    aName              - The @resource name.
 * @returns {string} The greasemonkey-script: URL string.
 * @throws {Error} If no resource with aName is found.
 */
GM_Resources.prototype.getResourceURL = function (
    aWrappedContentWin, aSandbox, aScript, aName) {
  return this._getDependency(
      aWrappedContentWin, aScript.fileURL, aName).gm_url;
};

/**
 * Internal helper: looks up a @resource by name.
 *
 * @param {Window} aWrappedContentWin - Content window (for Error construction).
 * @param {string} aFileURL           - Script URL (for Error objects).
 * @param {string} aName              - The resource name to find.
 * @returns {ScriptResource} The matching resource descriptor.
 * @throws {Error} If no resource with the given name exists.
 */
GM_Resources.prototype._getDependency = function (
    aWrappedContentWin, aFileURL, aName) {
  let resources = this.script.resources;
  for (var i = 0, iLen = resources.length; i < iLen; i++) {
    let resource = resources[i];
    if (resource.name == aName) {
      return resource;
    }
  }

  throw new aWrappedContentWin.Error(
      GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("error.missingResource")
          .replace("%1", aName),
          aFileURL, null
      );
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Low-level logger that writes messages to the XPCOM console service with a
 * per-script prefix ("namespace/name: ").
 *
 * @constructor
 * @param {IPCScript} aScript - Provides namespace and name for the log prefix.
 */
function GM_ScriptLogger(aScript) {
  let namespace = aScript.namespace;

  if (namespace.substring(namespace.length - 1) != "/") {
    namespace += "/";
  }

  this.prefix = [namespace, aScript.name, ": "].join("");
}

GM_ScriptLogger.prototype.consoleService = Cc["@mozilla.org/consoleservice;1"]
    .getService(Ci.nsIConsoleService);

/**
 * Writes a message to the browser console with the script's prefix.
 * Strips null bytes (U+0000) from the message to avoid truncation.
 *
 * @param {string} aMessage - The message text to log.
 */
GM_ScriptLogger.prototype.log = function (aMessage) {
  // https://developer.mozilla.org/en-US/docs/XPCOM_Interface_Reference/nsIConsoleService#logStringMessage()
  // - wstring / wide string
  this.consoleService.logStringMessage((this.prefix + "\n" + aMessage)
      .replace(new RegExp("\\0", "g"), ""));
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Implements GM_windowClose() and GM_windowFocus() by calling
 * GM_BrowserUI.window directly on the chrome window that owns
 * aContentWin.
 *
 * @param {nsIDOMWindow} aContentWin - The script's content window.
 * @param {string}       aFileURL    - Script file URL (forwarded to the
 *                                     handler for attribution).
 * @param {string}       aWhat       - Operation: "close" or "focus".
 */
function GM_window(aContentWin, aFileURL, aWhat) {
  let chromeWin = getChromeWinForContentWin(aContentWin);
  if (!chromeWin || !chromeWin.GM_BrowserUI
      || (typeof chromeWin.GM_BrowserUI.window != "function")) {
    return undefined;
  }
  // GM_BrowserUI.window expects the IPC-message envelope shape; preserve
  // it verbatim so that the chrome-side handler stays unchanged.  The
  // .target field locates the script's owning <browser> element so the
  // GM_windowClose handler closes the right tab even when the script is
  // running in a background tab.
  let scriptBrowser;
  try {
    scriptBrowser = aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDocShell)
        .chromeEventHandler;
  } catch (e) {
    scriptBrowser = chromeWin.gBrowser
        ? chromeWin.gBrowser.selectedBrowser
        : null;
  }
  try {
    chromeWin.GM_BrowserUI.window({
      "target": scriptBrowser || chromeWin.gBrowser.selectedBrowser,
      "data": {
        "fileURL": aFileURL,
        "what": aWhat,
      },
    });
  } catch (e) {
    // Window may have closed; ignore.
  }
};
