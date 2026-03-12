/**
 * @file getBrowserWindow.js
 * @overview Returns the most recently active browser (navigator:browser) chrome window.
 */

const EXPORTED_SYMBOLS = ["getBrowserWindow"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}


/**
 * Returns the most recently focused navigator:browser chrome window.
 * @returns {nsIDOMWindow|null} The most recent browser window, or null if none is open.
 */
function getBrowserWindow() {
  return Cc["@mozilla.org/appshell/window-mediator;1"]
      .getService(Ci.nsIWindowMediator)
      .getMostRecentWindow("navigator:browser");
}
