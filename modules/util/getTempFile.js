/**
 * @file getTempFile.js
 * @overview Creates and returns a uniquely-named temporary file under the
 * system temp directory (or a provided root directory).
 */

const EXPORTED_SYMBOLS = ["getTempFile"];

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
const FILE_TYPE = Ci.nsIFile.NORMAL_FILE_TYPE;

/**
 * Creates a uniquely-named temporary file and returns it.
 * @param {nsIFile} [aRoot] - Parent directory for the new temp file; defaults to the system temp directory.
 * @param {string} [aLeaf] - Base leaf name for the temp file; defaults to the configured temp name constant.
 * @returns {nsIFile} The newly created temporary file.
 */
function getTempFile(aRoot, aLeaf) {
  let file = (aRoot || DIRECTORY_TEMP).clone();
  file.append(aLeaf || GM_CONSTANTS.directoryTempName);
  file.createUnique(FILE_TYPE, GM_CONSTANTS.fileMask);

  return file;
}
