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
 *   GM_window(aFrame, aFileURL, aWhat)
 *     Implements GM_windowClose() and GM_windowFocus() by sending an IPC
 *     message to the parent process.
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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Injects a CSS string into the page as a <style> element.
 *
 * If the document's <head> already exists, the <style> is appended immediately.
 * If <head> does not yet exist (run-at "document-start"), a MutationObserver
 * watches the document and inserts the style as soon as <head> is added.
 *
 * @param {Window} aWrappedContentWin - The content window (Xray-wrapped).
 * @param {string} aFileURL           - Script URL for error attribution.
 * @param {string} aRunAt             - Script run-at phase ("document-start",
 *   "document-end", or "document-idle").
 * @param {string} aCss               - The CSS text to inject.
 * @returns {HTMLStyleElement|null} The injected <style> element if the head
 *   already existed, or null if injection was deferred/impossible.
 */
function GM_addStyle(aWrappedContentWin, aFileURL, aRunAt, aCss) {
  var elementName = "head";

  aCss = String(aCss);

  function addStyle(aDoc, aHead, aCss) {
    let style = aDoc.createElement("style");

    style.textContent = aCss;
    style.type = "text/css";
    aHead.appendChild(style);

    return style;
  }

  var doc = aWrappedContentWin.document;
  if (!doc) {
    return null;
  }
  let head = doc.getElementsByTagName(elementName)[0];
  if (head) {
    return addStyle(doc, head, aCss);
  } else if (aRunAt == "document-start") {
    // See #2515 and #1849.
    // http://bugzil.la/1333990
    try {
      let MutationObserver = aWrappedContentWin.MutationObserver;
      var observer = new MutationObserver(function (aMutations) {
        aMutations.forEach(function (aMutation) {
          let addedNodes = aMutation.addedNodes;
          for (let i = 0, iLen = addedNodes.length; i < iLen; i++) {
            let node = addedNodes[i];
            if ((node.nodeType == 1)
                && (node.nodeName.toLowerCase() == elementName)) {
              observer.disconnect();
              addStyle(doc, node, aCss);
              break;
            }
          }
        });
      });
      observer.observe(doc, {
        "attributes": true,
        "childList": true,
        "subtree": true,
      });
    } catch (e) {
      throw new aWrappedContentWin.Error(e.message, aFileURL, null);
    }
  }

  return null;
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
 * @returns {Element|null} The created element, or null if deferred via observer.
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

  function createElement(aDoc, aParent) {
    let elem = aDoc.createElement(tagName);

    // Apply attributes.
    for (let key in attrs) {
      if (!attrs.hasOwnProperty(key)) {
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

    aParent.appendChild(elem);
    return elem;
  }

  // Resolve default parent if not given.
  if (!parentNode) {
    let headTags = {"script": 1, "style": 1, "link": 1, "meta": 1};
    let targetName = (tagName.toLowerCase() in headTags) ? "head" : "body";
    parentNode = doc.getElementsByTagName(targetName)[0];

    if (!parentNode) {
      // At document-start, head/body may not exist yet.
      // Fall back to documentElement if available.
      parentNode = doc.documentElement;
    }

    if (!parentNode && aRunAt == "document-start") {
      // Use MutationObserver to wait for the target element.
      try {
        let MutationObserver = aWrappedContentWin.MutationObserver;
        var observer = new MutationObserver(function (aMutations) {
          aMutations.forEach(function (aMutation) {
            let addedNodes = aMutation.addedNodes;
            for (let i = 0, iLen = addedNodes.length; i < iLen; i++) {
              let node = addedNodes[i];
              if (node.nodeType == 1) {
                observer.disconnect();
                createElement(doc, node);
                break;
              }
            }
          });
        });
        observer.observe(doc, {
          "childList": true,
          "subtree": true,
        });
      } catch (e) {
        throw new aWrappedContentWin.Error(e.message, aFileURL, null);
      }
      return null;
    }
  }

  if (!parentNode) {
    return null;
  }

  return createElement(doc, parentNode);
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
 * Returns the greasemonkey-script:// URL for a named @resource.
 * The URL format is: greasemonkey-script:<uuid>/<name>
 *
 * @param {Window}    aWrappedContentWin - Content window (for error attribution).
 * @param {Sandbox}   aSandbox           - Unused; kept for API symmetry.
 * @param {IPCScript} aScript            - The owning script (provides UUID).
 * @param {string}    aName              - The @resource name.
 * @returns {string} The greasemonkey-script:// URL string.
 * @throws {Error} If no resource with aName is found.
 */
GM_Resources.prototype.getResourceURL = function (
    aWrappedContentWin, aSandbox, aScript, aName) {
  // Verify the existence of the resource.
  let dep = this._getDependency(aWrappedContentWin, aScript.fileURL, aName);
  return [
    GM_CONSTANTS.addonScriptProtocolScheme + ":",
    aScript.uuid,
    GM_CONSTANTS.addonScriptProtocolSeparator, aName
  ].join("");
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
 * Implements GM_windowClose() and GM_windowFocus() by sending an async IPC
 * message to the parent process, which performs the actual window operation.
 *
 * @param {nsIMessageSender} aFrame   - Frame message manager.
 * @param {string}           aFileURL - Script file URL (sent for attribution).
 * @param {string}           aWhat    - Operation: "close" or "focus".
 */
function GM_window(aFrame, aFileURL, aWhat) {
  aFrame.sendAsyncMessage("greasemonkey:window", {
    "fileURL": aFileURL,
    "what": aWhat,
  });
};
