/**
 * @file logError.js
 * @overview Logs an error or warning message to the browser's JavaScript
 * error console via nsIConsoleService.
 */

const EXPORTED_SYMBOLS = ["logError"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}


// Cache the console service at module load.  Userscripts that throw
// in event handlers can drop dozens of errors per second; pre-fix
// every logError call did a fresh `Cc[..].getService(Ci..)` lookup.
const CONSOLE_SERVICE = Cc["@mozilla.org/consoleservice;1"]
    .getService(Ci.nsIConsoleService);

/**
 * Logs an error or warning to the browser's JavaScript error console.
 * @param {Error|string} e - The error object or message string to log.
 * @param {boolean} [aWarning] - If true, logs as a warning instead of an error.
 * @param {string} [aFileName] - Source file name to associate with the message.
 * @param {number} [aLineNumber] - Line number to associate with the message.
 * @returns {void}
 */
function logError(e, aWarning, aFileName, aLineNumber) {
  if (typeof e == "string") {
    e = new Error(e);
  }

  let consoleError = Cc["@mozilla.org/scripterror;1"]
      .createInstance(Ci.nsIScriptError);
  // Third parameter "sourceLine" is supposed to be the line, of the source,
  // on which the error happened.
  // We don't know it. (Directly...)
  consoleError.init(
      e.message, aFileName, null, aLineNumber, e.columnNumber,
      (aWarning ? Ci.nsIScriptError.warningFlag : Ci.nsIScriptError.errorFlag),
      null);

  CONSOLE_SERVICE.logMessage(consoleError);
}
