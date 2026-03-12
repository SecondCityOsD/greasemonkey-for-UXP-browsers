/**
 * @file isGreasemonkeyable.js
 * @overview Determines whether Greasemonkey scripts should be allowed to run
 * on a given URL based on its scheme and user preferences.
 */

const EXPORTED_SYMBOLS = ["isGreasemonkeyable"];

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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


/**
 * Determines whether Greasemonkey scripts are permitted to run on the given URL.
 * @param {string} aUrl - The URL to check.
 * @returns {boolean} True if scripts may run on this URL, false otherwise.
 */
function isGreasemonkeyable(aUrl) {
  let scheme = GM_CONSTANTS.ioService.extractScheme(aUrl);

  switch (scheme) {
    case "about":
      // Always allow "about:blank" and "about:reader".
      if (new RegExp(GM_CONSTANTS.urlAboutAllRegexp, "").test(aUrl)) {
        return true;
      }
      // See #1375.
      // Never allow the rest of "about:".
      return false;
    case "data":
      return GM_prefRoot.getValue("dataIsGreaseable");
    case "file":
      return GM_prefRoot.getValue("fileIsGreaseable");
    case "ftp":
    case "http":
    case "https":
      return true;
    case "jar":
      return GM_prefRoot.getValue("jarIsGreaseable");
    case "unmht":
      return GM_prefRoot.getValue("unmhtIsGreaseable");
    case "view-source":
      return GM_prefRoot.getValue("view-sourceIsGreaseable");
  }

  return false;
}
