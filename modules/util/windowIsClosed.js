/**
 * @file windowIsClosed.js
 * @overview Safely tests whether a content window has been closed, guarding
 * against dead wrappers and other edge cases introduced after bug 695480.
 */

const EXPORTED_SYMBOLS = ["windowIsClosed"];

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


/*
Accessing windows that are closed can be dangerous
after http://bugzil.la/695480.
This routine takes care of being careful to not trigger any of those broken
edge cases.
*/
/**
 * Safely checks whether a content window has been closed or is otherwise unusable.
 * @param {nsIDOMWindow} aWin - The window to check.
 * @returns {boolean} True if the window is closed or dead, false if it is still open.
 */
function windowIsClosed(aWin) {
  try {
    // If isDeadWrapper (Firefox 15+ only) tells us the window is dead.
    if (Cu.isDeadWrapper && Cu.isDeadWrapper(aWin)) {
      return true;
    }

    // If we can access the .closed property and it is true, or there is any
    // problem accessing that property.
    try {
      if (aWin.closed) {
        return true;
      }
    } catch (e) {
      return true;
    }
  } catch (e) {
    GM_util.logError(
        GM_CONSTANTS.info.scriptHandler + " - "
        + "windowIsClosed:" + "\n" + e,
        false, e.fileName, e.lineNumber);
    // Failsafe.
    // In case of any failure, destroy the command to avoid leaks.
    return true;
  }
  return false;
}
