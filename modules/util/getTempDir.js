/**
 * @file getTempDir.js
 * @overview Creates and returns a uniquely-named temporary directory under the
 * system temp directory (or a provided root directory).
 */

const EXPORTED_SYMBOLS = ["cleanOldTempDirs", "getTempDir"];

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

/** How old a leftover temporary folder must be to be removed. */
const OLD_TEMP_DIR_MS = 24 * 60 * 60 * 1000;

/**
 * Removes Greasemonkey's temporary folders ("gm-temp", "gm-temp-...")
 * that are more than a day old: a download or import cut short (the
 * browser closed or crashed) leaves its folder behind.  A download in
 * flight has a fresh one, whatever profile or browser it belongs to.
 * All off the main thread (OS.File); errors are ignored.
 *
 * @param {nsIFile} [aRoot] - Where to look; the system temp directory.
 * @returns {Promise} Settles when done; never rejects.
 */
function cleanOldTempDirs(aRoot) {
  let scope = {};
  Cu.import("resource://gre/modules/osfile.jsm", scope);
  let OS = scope.OS;
  let name = new RegExp(
      "^" + GM_CONSTANTS.directoryTempName + "(-.*)?$", "i");
  let before = Date.now() - OLD_TEMP_DIR_MS;
  let old = [];
  let iterator = new OS.File.DirectoryIterator((aRoot || DIRECTORY_TEMP).path);
  return iterator.forEach(function (aEntry) {
    if (aEntry.isDir && name.test(aEntry.name)) {
      old.push(aEntry.path);
    }
  }).then(function () {
    iterator.close();
    return Promise.all(old.map(function (aPath) {
      return OS.File.stat(aPath).then(function (aInfo) {
        if (aInfo.lastModificationDate.getTime() < before) {
          return OS.File.removeDir(aPath, {"ignoreAbsent": true});
        }
        return undefined;
      }).catch(function () {});
    }));
  }).catch(function () {
    try {
      iterator.close();
    } catch (e) {}
  });
}
