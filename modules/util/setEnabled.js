/**
 * @file setEnabled.js
 * @overview Persists the global Greasemonkey enabled/disabled state to the
 * "enabled" preference.
 */

const EXPORTED_SYMBOLS = ["setEnabled"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


/**
 * Persists the global enabled state of Greasemonkey to preferences.
 * @param {boolean} aEnabled - The new enabled state to store.
 * @returns {void}
 */
function setEnabled(aEnabled) {
  GM_prefRoot.setValue("enabled", aEnabled);
}
