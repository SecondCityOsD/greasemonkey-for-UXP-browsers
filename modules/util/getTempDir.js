/**
 * @file getTempDir.js
 * @overview Creates and returns a uniquely-named temporary directory under the
 * system temp directory (or a provided root directory).
 */

const EXPORTED_SYMBOLS = ["getTempDir"];

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


const DIRECTORY_TEMP = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceTempName, Ci.nsIFile);
const DIRECTORY_TYPE = Ci.nsIFile.DIRECTORY_TYPE;

/**
 * Creates a uniquely-named temporary directory and returns it.
 * @param {nsIFile} [aRoot] - Parent directory for the new temp dir; defaults to the system temp directory.
 * @returns {nsIFile} The newly created temporary directory.
 */
function getTempDir(aRoot) {
  let dir = (aRoot || DIRECTORY_TEMP).clone();
  dir.append(GM_CONSTANTS.directoryTempName);
  dir.createUnique(DIRECTORY_TYPE, GM_CONSTANTS.directoryMask);

  return dir;
}
