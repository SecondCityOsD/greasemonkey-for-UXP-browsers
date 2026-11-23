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
 *
 * The name is "gm-temp-" and a random part, normally created at the first
 * try.  createUnique() tried gm-temp, gm-temp-1, gm-temp-2... one by one:
 * with a leftover gm-temp and the folders of the downloads in flight, each
 * new folder cost a dozen failed creations, a second of an import of 200
 * scripts.  createUnique() remains the fallback.
 *
 * @param {nsIFile} [aRoot] - Parent directory for the new temp dir; defaults to the system temp directory.
 * @returns {nsIFile} The newly created temporary directory.
 */
function getTempDir(aRoot) {
  for (let i = 0; i < 3; i++) {
    let dir = (aRoot || DIRECTORY_TEMP).clone();
    dir.append(GM_CONSTANTS.directoryTempName + "-"
        + Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
    try {
      dir.create(DIRECTORY_TYPE, GM_CONSTANTS.directoryMask);
      return dir;
    } catch (e) {
      // Taken (or can't be made): another name, then the old way.
    }
  }
  let dir = (aRoot || DIRECTORY_TEMP).clone();
  dir.append(GM_CONSTANTS.directoryTempName);
  dir.createUnique(DIRECTORY_TYPE, GM_CONSTANTS.directoryMask);

  return dir;
}
