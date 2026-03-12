/**
 * @file alert.js
 * @overview Provides an alert() function usable in XPCOM module/component scope
 * where the global alert() is not available.
 */

const EXPORTED_SYMBOLS = ["alert"];

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


// Because alert is not defined in component/module scope.
/**
 * Displays a modal alert dialog with the Greasemonkey handler name as title.
 * @param {string} aMsg - The message text to display in the alert dialog.
 * @returns {void}
 */
function alert(aMsg) {
  Cc["@mozilla.org/embedcomp/prompt-service;1"]
      .getService(Ci.nsIPromptService)
      .alert(null, GM_CONSTANTS.info.scriptHandler + " alert", aMsg);
}
