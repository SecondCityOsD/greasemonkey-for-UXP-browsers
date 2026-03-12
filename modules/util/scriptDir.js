/**
 * @file scriptDir.js
 * @overview Resolves and caches the Greasemonkey scripts directory (nsIFile),
 * creating it if it does not yet exist.
 */

const EXPORTED_SYMBOLS = ["scriptDir"];

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


const DIRECTORY_TYPE = Ci.nsIFile.DIRECTORY_TYPE;

var gDirectoryScript = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceScriptName, Ci.nsIFile);

gDirectoryScript.append(GM_CONSTANTS.directoryScriptsName);
if (!gDirectoryScript.exists()) {
  gDirectoryScript.create(
      DIRECTORY_TYPE,
      GM_CONSTANTS.directoryMask);
}
// e.g. in case of symlinks.
gDirectoryScript.normalize();

/**
 * Returns a clone of the Greasemonkey scripts directory nsIFile.
 * @returns {nsIFile} A clone of the scripts directory object.
 */
function scriptDir() {
  return gDirectoryScript.clone();
}
