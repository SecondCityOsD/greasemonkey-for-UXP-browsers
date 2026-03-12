/**
 * @file getUriFromFile.js
 * @overview Converts an nsIFile to a file:// nsIURI using the IO service.
 */

const EXPORTED_SYMBOLS = ["getUriFromFile"];

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


/**
 * Converts an nsIFile to a file:// nsIURI.
 * @param {nsIFile} aFile - The local file to convert.
 * @returns {nsIURI} The corresponding file:// URI.
 */
function getUriFromFile(aFile) {
  return GM_CONSTANTS.ioService.newFileURI(aFile);
}
