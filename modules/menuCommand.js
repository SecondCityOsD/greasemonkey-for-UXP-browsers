/**
 * @file menuCommand.js
 * @overview Implements GM_registerMenuCommand() — allows userscripts to add
 *   items to the Greasemonkey toolbar/context menu.
 *
 * Architecture overview (three layers communicate via DOM events + IPC):
 *
 *   [Parent process]
 *     Requests the list of registered commands by sending an IPC message to
 *     the frame.  Receives the response via MenuCommandRespond().
 *     Sends a "run this command" IPC message when the user clicks a menu item.
 *
 *   [Frame scope / content process]
 *     MenuCommandListRequest() — receives the list-request IPC message and
 *       re-dispatches it into the sandbox as a CustomEvent.
 *     MenuCommandRun() — receives the run-request IPC message and re-dispatches
 *       it as a CustomEvent so the sandbox can pick it up.
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
  "MenuCommandEventNameSuffix",
  "MenuCommandListRequest", "MenuCommandRespond",
  "MenuCommandRun", "MenuCommandSandbox",
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
 * Frame-scope handler for the "list menu commands" IPC message.
 * Re-dispatches the request into the sandbox by firing a CustomEvent on the
 * content window.  MenuCommandSandbox listens for this event and responds
 * via MenuCommandRespond().
 *
 * @param {Window} aContent  - The content window of the tab.
 * @param {object} aMessage  - IPC message; aMessage.data.cookie identifies
 *                             this request.
 */
function MenuCommandListRequest(aContent, aMessage) {
  let e = new aContent.CustomEvent(
      "greasemonkey-menu-command-list-" + MenuCommandEventNameSuffix, {
        "detail": aMessage.data.cookie,
      });
  aContent.dispatchEvent(e);
}

/**
 * Callback invoked from inside the script sandbox when it responds to a
 * "list menu commands" request.  Forwards the list up to the parent process.
 *
 * @param {number} aCookie - The request cookie echoed from the list-request event.
 * @param {object} aData   - Map of cookie → command descriptor for all registered
 *                           commands in this script.
 */
function MenuCommandRespond(aCookie, aData) {
  Services.cpmm.sendAsyncMessage(
      "greasemonkey:menu-command-response", {
        "commands": aData,
        "cookie": aCookie,
      });
}

/**
 * Frame-scope handler for the "run this menu command" IPC message.
 * Re-dispatches the run request into the sandbox as a CustomEvent so that
 * MenuCommandSandbox can invoke the registered callback.
 *
 * @param {Window} aContent  - The content window of the tab.
 * @param {object} aMessage  - IPC message; aMessage.data contains the
 *                             scriptUuid and cookie identifying which command
 *                             to run.
 */
function MenuCommandRun(aContent, aMessage) {
  let e = new aContent.CustomEvent(
      "greasemonkey-menu-command-run-" + MenuCommandEventNameSuffix, {
        "detail": JSON.stringify(aMessage.data),
      });
  aContent.dispatchEvent(e);
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
  var commands = {};
  var commandFuncs = {};
  var commandCookie = 0;
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
   * GM_registerMenuCommand — registers a new menu command for this script.
   *
   * @param {string}   aCommandName - Display name shown in the menu.
   * @param {function} aCommandFunc - Callback invoked when the user clicks
   *                                  the menu item.
   * @param {string|object} [aAccesskey] - Single-character keyboard shortcut,
   *                                       OR a Tampermonkey/Violentmonkey
   *                                       options object of the form
   *                                       { accessKey, id, autoClose, title }
   *                                       (only accessKey is currently honoured).
   * @param {*}        [aUnused]    - Legacy parameter (ignored).
   * @param {string}   [aAccesskey2]- Legacy 5th-argument access key override.
   * @throws {Error} If aAccesskey resolves to a non-single-character string.
   */
  this.GM_registerMenuCommand = function (
      aCommandName, aCommandFunc, aAccesskey, aUnused, aAccesskey2) {
    aCommandName = String(aCommandName);

    // Tampermonkey / Violentmonkey compatibility: the third argument may
    // be an options object of the form { accessKey, id, autoClose, title }
    // instead of a raw access-key string.  We only act on the access-key
    // portion here; the other properties are accepted but currently have
    // no visible effect.  Without this normalisation a script that passes
    // {} as the third argument would hit the single-character validator
    // below and throw "Invalid accesskey".
    if (aAccesskey && typeof aAccesskey === "object") {
      aAccesskey = aAccesskey.accessKey || null;
    }

    // Legacy support:
    // If all five parameters were specified
    // (from when two were for accelerators) use the last one as the access key.
    if (typeof aAccesskey2 != "undefined") {
      aAccesskey = aAccesskey2;
    }

    if (aAccesskey
        && ((typeof aAccesskey != "string") || (aAccesskey.length != 1))) {
      throw new Error(
          aMenuCommandInvalidAccesskeyErrorStr.replace("%1", aCommandName),
          aScriptFileURL, null);
    }

    var command = {
      "accesskey": aAccesskey,
      "cookie": ++commandCookie,
      "name": aCommandName,
      "scriptName": aScriptName,
      "scriptUuid": aScriptUuid,
    };
    commands[command.cookie] = command;
    commandFuncs[command.cookie] = aCommandFunc;

    return command.cookie;
  };

  /**
   * GM_unregisterMenuCommand — removes a previously registered menu command.
   *
   * @param {number} aCookie - The ID returned by GM_registerMenuCommand.
   */
  this.GM_unregisterMenuCommand = function (aCookie) {
    delete commands[aCookie];
    delete commandFuncs[aCookie];
  };
}`;
