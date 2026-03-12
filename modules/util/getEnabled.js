/**
 * @file getEnabled.js
 * @overview Returns whether Greasemonkey is globally enabled via the
 * "enabled" preference.
 */

const EXPORTED_SYMBOLS = ["getEnabled"];

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
 * Returns whether Greasemonkey script injection is globally enabled.
 * @returns {boolean} True if Greasemonkey is enabled, false otherwise.
 */
function getEnabled() {
  return GM_prefRoot.getValue("enabled", true);
}
