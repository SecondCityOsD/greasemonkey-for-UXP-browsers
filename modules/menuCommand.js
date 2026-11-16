/**
 * @file menuCommand.js
 * @overview Implements GM_registerMenuCommand() — allows userscripts to add
 *   items to the Greasemonkey toolbar/context menu.
 *
 * Architecture overview (two layers communicate via DOM events on the
 * content window):
 *
 *   [Chrome scope]
 *     content/menuCommander.js dispatches CustomEvents directly onto the
 *     active tab's page window and each of its frames' (each sandbox
 *     listens on the window its script runs in):
 *       - "greasemonkey-menu-command-list-<suffix>" when the popup opens,
 *         to ask each sandbox for its registered commands.
 *       - "greasemonkey-menu-command-run-<suffix>" when the user clicks a
 *         menu item.
 *     Receives responses via Services.obs ("greasemonkey:menu-command-
 *     response" topic), emitted from MenuCommandRespond() below.
 *
 *   [Script sandbox]
 *     MenuCommandSandbox() — injected BY SOURCE into the sandbox (not by
 *       reference) so that it runs in the script's security context.
 *       Registers the GM_registerMenuCommand function and sets up listeners
 *       for the list/run CustomEvents.
 *
 * Security:
 *   The event name is suffixed with a per-session random token
 *   (MenuCommandEventNameSuffix) so that page scripts cannot intercept or
 *   forge the events.  The token is generated once at startup and persisted
 *   in preferences.
 *
 *   MenuCommandSandbox is injected by source (toSource()) rather than by
 *   reference so that its closure does not hold privileged chrome references
 *   that the script could abuse.
 */

const EXPORTED_SYMBOLS = [
  "MenuCommandEventNameSuffix", "MenuCommandRespond", "MenuCommandSandbox",
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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


/**
 * Per-session random suffix appended to all menu-command event names.
 * Prevents page scripts from guessing or spoofing the event names.
 * Generated once and stored in preferences so it survives restarts.
 *
 * @type {string}
 */
var MenuCommandEventNameSuffix = (function () {
  let suffix = GM_prefRoot.getValue("menuCommanderEventNameSuffix");

  if (!suffix) {
    Cu.import("resource://services-crypto/utils.js");
    let rnd = CryptoUtils.generateRandomBytes(128);
    try {
      // Pale Moon 27.2+
      suffix = CryptoUtils.sha256Base32(rnd);
    } catch (e) {
      suffix = CryptoUtils.sha1Base32(rnd);
    }
    GM_prefRoot.setValue("menuCommanderEventNameSuffix", suffix);
  }

  return suffix;
})();

/**
 * Callback invoked from inside the script sandbox when it responds to a
 * list-commands request.  Forwards the list to any subscribed chrome menu
 * commander via the platform observer service.
 *
 * @param {number} aCookie - The request cookie echoed from the list-request event.
 * @param {object} aData   - Map of cookie → command descriptor for all registered
 *                           commands in this script.
 */
function MenuCommandRespond(aCookie, aData) {
  // UXP runs chrome and content in the same process, so Services.obs
  // reaches the chrome menu commander listener (content/menuCommander.js)
  // directly.  Subject is null, topic identifies the message, data is a
  // JSON-serialised payload (Services.obs only accepts strings as the
  // data argument).
  let payload = JSON.stringify({
    "commands": aData,
    "cookie": aCookie,
  });
  Services.obs.notifyObservers(null,
      "greasemonkey:menu-command-response", payload);
}

/**
 * This function is injected into the script sandbox BY SOURCE (via toSource())
 * rather than by reference.  It runs entirely in the script's security context
 * so that no chrome references leak into the sandbox via closure.
 *
 * Responsibilities (executed once, immediately when injected):
 *   1. Maintains an internal registry of {cookie → command descriptor} and
 *      {cookie → callback function} for all commands registered by this script.
 *   2. Adds a "greasemonkey-menu-command-list-<suffix>" event listener on the
 *      content window.  When fired, calls aCommandResponder() with the current
 *      command list so the frame layer can forward it to the parent process.
 *   3. Adds a "greasemonkey-menu-command-run-<suffix>" event listener.
 *      When fired for this script's UUID, calls the registered callback.
 *   4. Exports this.GM_registerMenuCommand to the sandbox scope.
 *
 * @param {Window}   aContent           - Content window for event listeners.
 * @param {string}   aScriptUuid        - UUID of the owning script.
 * @param {string}   aScriptName        - Human-readable script name (for errors).
 * @param {string}   aScriptFileURL     - Script URL (for Error objects).
 * @param {function} aCommandResponder  - MenuCommandRespond; called with the
 *                                        cookie and command list.
 * @param {string}   aMenuCommandCallbackIsNotFunctionErrorStr
 * @param {string}   aMenuCommandCouldNotRunErrorStr
 * @param {string}   aMenuCommandInvalidAccesskeyErrorStr
 * @param {string}   aMenuCommandEventNameSuffix - Security suffix for event names.
 */
// IMPORTANT: Held as a raw template-literal string, NOT a function.
// Concatenating a Function with "" in the injection site would invoke
// Function.prototype.toString(), which on older Pale Moon / New Moon
// SpiderMonkey builds still runs through the same buggy decompiler as
// .toSource() and can produce malformed source.  Keeping the source as
// a string from birth avoids every variant of that bug — the sandbox
// eval sees the exact text we wrote, byte for byte.
// See issue #13 and the v3.6.1 regression that made the menu disappear.
var MenuCommandSandbox = `
function MenuCommandSandbox(
    aContent,
    aScriptUuid, aScriptName, aScriptFileURL,
    aCommandResponder,
    aMenuCommandCallbackIsNotFunctionErrorStr,
    aMenuCommandCouldNotRunErrorStr,
    aMenuCommandInvalidAccesskeyErrorStr,
    aMenuCommandEventNameSuffix) {
  // 1) Internally to this function's private scope,
  // maintain a set of registered menu commands.
  // Keyed by script-chosen strings (an id or a caption): no prototype,
  // so "__proto__" is an ordinary key.
  var commands = Object.create(null);
  var commandFuncs = Object.create(null);
  // "var" instead of "let"
  // Firefox 43-
  // http://bugzil.la/932517
  var _addEventListener = true;
  try {
    aContent.addEventListener;
  } catch (e) {
    // e.g.:
    // Error: Permission denied to access property "addEventListener"
    _addEventListener = false;
  }
  if (_addEventListener) {
    // 2) Respond to requests to list those registered commands.
    aContent.addEventListener(
          "greasemonkey-menu-command-list-" + aMenuCommandEventNameSuffix,
          function (e) {
            e.stopPropagation();
            aCommandResponder(e.detail, commands);
          }, true);
    // 3) Respond to requests to run those registered commands.
    aContent.addEventListener(
        "greasemonkey-menu-command-run-" + aMenuCommandEventNameSuffix,
        function (e) {
          e.stopPropagation();
          var detail = JSON.parse(e.detail);
          if (aScriptUuid != detail.scriptUuid) {
            return undefined;
          }
          // This event is for this script; stop propagating to other scripts.
          e.stopImmediatePropagation();
          if (!(detail.cookie in commands)) {
            // Unregistered while the menu was open.
            return undefined;
          }
          var commandFunc = commandFuncs[detail.cookie];
          if (!commandFunc) {
            throw new Error(
                aMenuCommandCouldNotRunErrorStr.replace(
                    "%1", commands[detail.cookie].name),
                aScriptFileURL, null);
          } else if (typeof commandFunc != "function") {
            throw new Error(
                aMenuCommandCallbackIsNotFunctionErrorStr.replace(
                    "%1", commands[detail.cookie].name),
                aScriptFileURL, null);
          } else {
            commandFunc.call();
          }
        }, true);
  }
  // 4) Export the "register a command" API function to the sandbox scope.
  /**
   * GM_registerMenuCommand: registers a new menu command for this script.
   *
   * A command's key is options.id, else its caption, as in Violentmonkey:
   * registering a key again replaces that command where it is (the toggle
   * pattern, re-registering "X: ON" / "X: OFF" with one id, keeps one row;
   * it used to add a row each time).
   *
   * @param {string}   aCommandName - Display name shown in the menu.
   * @param {function} aCommandFunc - Callback invoked when the user clicks
   *                                  the menu item.
   * @param {string|object} [aOptions] - Single-character keyboard shortcut,
   *                                     OR a Tampermonkey/Violentmonkey
   *                                     options object of the form
   *                                     { accessKey, id, autoClose, title }:
   *                                     title is the item's tooltip, and
   *                                     autoClose: false keeps the menu open.
   * @param {*}        [aUnused]    - Legacy parameter (ignored).
   * @param {string}   [aAccesskey2]- Legacy 5th-argument access key override.
   * @returns {string} The command's key, for GM_unregisterMenuCommand.
   * @throws {Error} If the access key resolves to a non-single-character
   *   string.
   */
  this.GM_registerMenuCommand = function (
      aCommandName, aCommandFunc, aOptions, aUnused, aAccesskey2) {
    aCommandName = String(aCommandName);

    var accesskey = aOptions;
    var id = null;
    var title = null;
    var autoClose = true;
    if (aOptions && typeof aOptions === "object") {
      accesskey = aOptions.accessKey || null;
      if (aOptions.id != null) {
        id = String(aOptions.id);
      }
      if (aOptions.title != null) {
        title = String(aOptions.title);
      }
      autoClose = (aOptions.autoClose !== false);
    }

    // Legacy support:
    // If all five parameters were specified
    // (from when two were for accelerators) use the last one as the access key.
    if (typeof aAccesskey2 != "undefined") {
      accesskey = aAccesskey2;
    }

    if (accesskey
        && ((typeof accesskey != "string") || (accesskey.length != 1))) {
      throw new Error(
          aMenuCommandInvalidAccesskeyErrorStr.replace("%1", aCommandName),
          aScriptFileURL, null);
    }

    var key = (id !== null) ? id : aCommandName;
    commands[key] = {
      "accesskey": accesskey || null,
      "autoClose": autoClose,
      "cookie": key,
      "name": aCommandName,
      "scriptName": aScriptName,
      "scriptUuid": aScriptUuid,
      "title": title,
    };
    commandFuncs[key] = aCommandFunc;

    return key;
  };

  /**
   * GM_unregisterMenuCommand: removes a previously registered menu command.
   *
   * @param {string} aKey - What GM_registerMenuCommand returned, or the
   *                        command's caption (as Violentmonkey accepts).
   */
  this.GM_unregisterMenuCommand = function (aKey) {
    var key = String(aKey);
    if (!(key in commands)) {
      for (var other in commands) {
        if (commands[other].name === key) {
          key = other;
          break;
        }
      }
    }
    delete commands[key];
    delete commandFuncs[key];
  };
}`;
