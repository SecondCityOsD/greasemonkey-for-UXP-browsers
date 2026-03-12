/**
 * @file sniffGrants.js
 * @overview Scans a script's source text for references to Greasemonkey API
 * names and returns the list of grants that should be auto-applied.
 */

const EXPORTED_SYMBOLS = ["sniffGrants"];

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
 * Scans a script's source for Greasemonkey API usage and returns the grants that should be applied.
 * @param {object} aScript - The script object whose source will be scanned.
 * @returns {string[]} An array of API name strings to grant, or ["none"] if no API is referenced.
 */
function sniffGrants(aScript) {
  let src = GM_util.getScriptSource(aScript);
  let grants = [];

  for (let i = 0, iLen = GM_CONSTANTS.addonAPI.length; i < iLen; i++) {
    let apiName = GM_CONSTANTS.addonAPI[i];
    if (src.indexOf(apiName) !== -1) {
      grants.push(apiName);
    }
  }
  if (grants.length == 0) {
    return ["none"];
  }

  return grants;
}
