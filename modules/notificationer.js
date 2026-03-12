/**
 * @file notificationer.js
 * @overview Implements the GM_notification() API for userscripts.
 *
 * GM_notificationer is a per-script helper object that bridges the content
 * security context (where the userscript runs) and the chrome security
 * context (where native browser notifications are created).
 *
 * It supports two call forms (legacy positional and modern object):
 *   GM_notification(text, title, image, onclick)
 *   GM_notification({ text, title, image, onclick, ondone, timeout, ... })
 *
 * Security model:
 *   - Xray wrappers are waived when reading callback properties from the
 *     script-supplied details object (Part 1 in the code).
 *   - Before invoking any callback, its principal is verified against the
 *     sandbox principal to ensure it originated from the script rather than
 *     from content (Part 2).  This prevents a malicious page from injecting
 *     a privileged callback via the GM_notification options object.
 *   - Callbacks are always invoked via window.setTimeout(..., 0) on the
 *     browser thread using XPCNativeWrapper to prevent privilege escalation.
 *
 * Requires dom.webnotifications.enabled = true in about:config.
 *
 * Note: tab highlight (details.highlight) is currently stubbed out —
 * the relevant code is commented out because it does not work reliably.
 */

const EXPORTED_SYMBOLS = ["GM_notificationer"];

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

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Per-script notification helper.
 *
 * @constructor
 * @param {Window}   aChromeWin         - The browser chrome window; used to
 *   create Notification objects and access PopupNotifications.
 * @param {Window}   aWrappedContentWin - The X-ray wrapped content window;
 *   used to construct Error objects and call setTimeout.
 * @param {Sandbox}  aSandbox           - The script's sandbox; principal is
 *   captured here for later callback verification.
 * @param {string}   aFileURL           - The script's file URL (for errors).
 * @param {string}   aScriptName        - The script name used as the default
 *   notification title.
 */
function GM_notificationer(
    aChromeWin, aWrappedContentWin, aSandbox, aFileURL, aScriptName) {
  this.chromeWin = aChromeWin;  
  this.fileURL = aFileURL;
  this.sandbox = aSandbox;
  this.sandboxPrincipal = Cu.getObjectPrincipal(aSandbox);
  this.scriptName = aScriptName;
  this.setupEvent = GM_util.hitch(
      this, "setupEvent", aWrappedContentWin, aSandbox,
      aFileURL);
  this.wrappedContentWin = aWrappedContentWin;
}

/**
 * Entry point called from the userscript (content security context).
 * Normalises the two supported call forms (object or positional arguments)
 * into a single internal "details" object, validates required fields,
 * creates the native Notification, and hands off to chromeStart().
 *
 * @param {object|string} aDetailsOrText
 *   Object form: { text, title, image, onclick, ondone, timeout, highlight }
 *   String form: the notification message text.
 * @param {function|string} [aOnDoneOrTitle]
 *   Object form: ondone callback (ignored — kept for compatibility).
 *   String form: the notification title.
 * @param {string}   [aImage]   - Notification icon URL (string form only).
 * @param {function} [aOnClick] - Click callback (string form only).
 * @throws {Error} If message is empty and highlight is false.
 * @throws {Error} If onclick or ondone is not a function.
 * @throws {Error} If desktop notifications are not supported or not enabled.
 */
GM_notificationer.prototype.contentStart = function (
    aDetailsOrText, aOnDoneOrTitle, aImage, aOnClick) {
  let _functionEmpty = function () {};

  var details = {
    "highlight": true,
    "highlightOnly": false,
    "image": "chrome://greasemonkey/skin/icon32.png",
    "message": "",
    "onclick": _functionEmpty,
    "ondone": _functionEmpty,
    "timeout": 0,
    "timeoutWasReached": false,
    "title": this.scriptName,
  };

  var _details = {};

  if (aDetailsOrText) {
    if (typeof aDetailsOrText == "object") {
      // Part 1a:
      // Waive Xrays so that we can read callback function properties...
      // aDetailsOrText = Cu.waiveXrays(aDetailsOrText);
      _details.highlight = aDetailsOrText.highlight;
      _details.image = aDetailsOrText.image;
      _details.message = aDetailsOrText.text;
      _details.onclick = Cu.waiveXrays(aDetailsOrText).onclick;
      _details.ondone = Cu.waiveXrays(aDetailsOrText).ondone;
      _details.timeout = aDetailsOrText.timeout;
      _details.title = aDetailsOrText.title;
    } else if (typeof aDetailsOrText == "string") {
      details.message = aDetailsOrText;
    }
  }

  if (typeof _details.highlight != "undefined") {
    details.highlight = _details.highlight;
  }
  // i.e. a data scheme
  if (_details.image && (typeof _details.image == "string")) {
    details.image = _details.image;
  }
  if (_details.message && (typeof _details.message == "string")) {
    details.message = _details.message;
  }
  if (_details.onclick) {
    details.onclick = _details.onclick;
  }
  if (_details.ondone) {
    details.ondone = _details.ondone;
  }
  if (_details.timeout && Number.isInteger(_details.timeout)) {
    details.timeout = _details.timeout;
  }
  if (_details.title && (typeof _details.title == "string")) {
    details.title = _details.title;
  }

  if (aOnDoneOrTitle) {
    if (typeof aDetailsOrText == "object") {
      // Part 1b:
      // Waive Xrays so that we can read callback function properties...
      details.ondone = Cu.waiveXrays(aOnDoneOrTitle);
    } else if (typeof aOnDoneOrTitle == "string") {
      details.title = aOnDoneOrTitle;
    }
  }

  if (aImage) {
    // i.e. a data scheme
    if (typeof aImage == "string") {
      details.image = aImage;
    }
  }

  if (aOnClick) {
    details.onclick = aOnClick;
  }

  if ((details.message == "") && !details.highlight) {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.notification.messageOrHighlight")
            .replace("%1", details.title),
        this.fileURL, null);
  }

  let _notification = {
    "details": details,
    "onClick": details.onclick,
    "onDone": details.ondone,
  };

  if (typeof _notification.onClick != "function") {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.notification.callbackIsNotFunction")
            .replace("%1", _notification.details.title)
            .replace("%2", "onclick"),
        this.fileURL, null);
  }
  if (typeof _notification.onDone != "function") {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.notification.callbackIsNotFunction")
            .replace("%1", _notification.details.title)
            .replace("%2", "ondone"),
        this.fileURL, null);
  }

  var options = {
    "body": details.message,
    "icon": details.image,
    "requireInteraction": true,
  };

  var notification = null;
  if (this.chromeWin) {
    if (!("Notification" in this.chromeWin)) {
      // This browser does not support desktop notification.
      // Ignore.
    } else if (this.chromeWin.Notification.permission === "granted") {
      // Let's check whether notification permissions
      // have already been granted.
      // If it's okay let's create a notification.
      notification = new this.chromeWin
          .Notification(details.title, options);
    } else if (this.chromeWin.Notification.permission !== "denied") {
      // Otherwise, we need to ask the user for permission.
      this.chromeWin.Notification.requestPermission(function (aPermission) {
        // If the user accepts, let's create a notification.
        if (aPermission === "granted") {
          notification = new this.chromeWin
              .Notification(details.title, options);
        }
      });
    }
    if (notification) {
      if (details.timeout && (details.timeout > 0)) {
        GM_util.timeout(function () {
          if (notification) {
            details.timeoutWasReached = true;
            notification.close();
          }
        }, details.timeout);
      }
    }
  } else {
    throw new this.wrappedContentWin.Error(
        'GM_notification() - "' + details.title + '": '
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.environment.unsupported.e10s"),
        this.fileURL, null);
  }

  if (notification) {
    // Hightlight tab does not work.
    /*
    if (details.highlight) {
      this.wrappedContentWin.focus();
      if (details.message == "") {
        details.highlightOnly = true;
        this.setupEvent(notification, "done", details);
      }
    }
    */
    // if (details.message != "") {
      GM_util.hitch(this, "chromeStart", notification, details)();
    // }
  } else {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.notification.functionIsNotEnabled")
            .replace("%1", details.title)
            .replace("%2", '"about:config" - "dom.webnotifications.enabled"'),
        this.fileURL, null);
  }
};

/**
 * Called in the chrome security context after the Notification object has
 * been successfully created.  Wires up all event listeners.
 *
 * @param {Notification} aNotification - The native browser Notification object.
 * @param {object}       aDetails      - Normalised details object from contentStart.
 */
GM_notificationer.prototype.chromeStart =
function (aNotification, aDetails) {
  this.setupEvent(aNotification, "click", aDetails);
  // Deprecated.
  this.setupEvent(aNotification, "close", aDetails);
  this.setupEvent(aNotification, "done", aDetails);
  this.setupEvent(aNotification, "error", aDetails);
};

/**
 * Attaches a DOM event listener to aNotification for aEvent, wired to call
 * the corresponding "on<event>" callback from aDetails in the content context.
 *
 * Security: the callback's principal is checked against this.sandboxPrincipal
 * to ensure it came from the script and not from the page (Part 2).
 *
 * Event-specific behaviour:
 *   "click"  — also fires the "done" callback; skips if onclose is defined
 *              (browser handles it natively in that case).
 *   "close"  — fires the "done" callback unless a timeout was reached.
 *   "error"  — throws an Error into the content window.
 *
 * @param {Window}       aWrappedContentWin - Content window for setTimeout / Error.
 * @param {Sandbox}      aSandbox           - Script sandbox (unused directly here).
 * @param {string}       aFileURL           - Script URL (for Error objects).
 * @param {Notification} aNotification      - Native Notification to attach to.
 * @param {string}       aEvent             - Event name: "click", "close",
 *                                            "done", or "error".
 * @param {object}       aDetails           - Normalised details from contentStart.
 */
GM_notificationer.prototype.setupEvent = function (
    aWrappedContentWin, aSandbox, aFileURL, aNotification, aEvent, aDetails) {
   var eventCallback = aDetails["on" + aEvent];

  // Part 2: ...but ensure that the callback came from a script, not content,
  // by checking that its principal equals that of the sandbox.
  if (eventCallback) {
    let callbackPrincipal = Cu.getObjectPrincipal(eventCallback);
    if (!this.sandboxPrincipal.equals(callbackPrincipal)) {
      return undefined;
    }
  }

  var startEventCallback = GM_util.hitch(
      this, "startEventCallback", aWrappedContentWin, aDetails);

  aNotification.addEventListener(aEvent, function (aEvt) {
    if (!aDetails.highlightOnly) {
      aEvt.preventDefault();
    }
    startEventCallback(aDetails["on" + aEvt.type]);
    switch (aEvt.type) {
      case "click":
        startEventCallback(
            aDetails["on" + "done"],
            (typeof aNotification.onclose != "undefined"));
        break;
      case "close":
        if (!aDetails.timeoutWasReached) {
          startEventCallback(aDetails["on" + "done"]);
        }
        break;
      case "error":
        throw new aWrappedContentWin.Error(
            GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.notification.error")
                .replace("%1", aDetails.title),
            aFileURL, null);
        break;
    }
  }, false);
};

/**
 * Safely invokes an event callback in the content window's security context.
 *
 * The callback is dispatched via XPCNativeWrapper + setTimeout(..., 0) to:
 *   1. Return to the browser event loop before calling user code.
 *   2. Prevent privilege escalation via a replaced window.setTimeout.
 *
 * @param {Window}    aWrappedContentWin        - The content window.
 * @param {object}    aDetails                  - Normalised details (unused here,
 *   kept for GM_util.hitch arity).
 * @param {function}  aEventCallback            - The callback to invoke.
 * @param {boolean}  [aIsNothingOrOnCloseExists] - If truthy, skip invocation
 *   (used when the browser will fire the close event itself).
 */
GM_notificationer.prototype.startEventCallback = function (
    aWrappedContentWin, aDetails, aEventCallback,
    aIsNothingOrOnCloseExists) {
  if (!aEventCallback || aIsNothingOrOnCloseExists) {
    return undefined;
  }
  if (GM_util.windowIsClosed(aWrappedContentWin)) {
    return undefined;
  }

  // Pop back onto browser thread and call event handler.
  // Have to use nested function here instead of GM_util.hitch
  // because otherwise aDetails[aEvent].apply can point to window.setTimeout,
  // which can be abused to get increased privileges.
  new XPCNativeWrapper(aWrappedContentWin, "setTimeout()")
      .setTimeout(function () {
        aEventCallback.call();
      }, 0);
};
