/*
Some basic tests:

See #1717.
HTTP authentication: Several times enter the wrong password.
1a) Then enter the correct password - some temporary directories remains.
1b) The window: Authentication Required:
    Press "Cancel" - all temporary directories are deleted
    ("enqueuedRemovals" will be filled - but it doesn't matter...).
1c) ...because we will check it after browser start
    (temporary directories and "enqueuedRemovals").

2a) A script with the database (after use of GM_setValue).
    Set the database (file) read-only flag to on.
    Delete this script. The attached database (file) remains.
2b) Set the database (file) read-only flag to off. 
    We will check it after browser start
    (the attached database (file) and "enqueuedRemovals").
*/

/**
 * @file enqueueRemove.js
 * @overview Removes files and directories on behalf of Greasemonkey, queuing
 * failed deletions to preferences so they are retried on the next browser startup.
 */

const EXPORTED_SYMBOLS = ["enqueueRemove"];

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
Cu.import("chrome://greasemonkey-modules/content/util.js");


const DIRECTORY_TEMP = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceTempName, Ci.nsIFile);

/*
var gDirectoryScript = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceScriptName, Ci.nsIFile);
gDirectoryScript.append(GM_CONSTANTS.directoryScriptsName);
*/

function addEnqueuedPath(aPath, aRecursive) {
  let paths = getEnqueuedPaths();
  paths.push({
    "path": aPath,
    "recursive": aRecursive ? true : false,
  });
  GM_prefRoot.setValue("enqueuedRemovals", JSON.stringify(paths));
}

function getEnqueuedPaths() {
  return JSON.parse(GM_prefRoot.getValue("enqueuedRemovals", "[]"));
}

function removeEnqueuedPath(aPath) {
  let paths = getEnqueuedPaths();
  paths = paths.filter(function (aItem) {
    return aItem.path != aPath;
  });
  GM_prefRoot.setValue("enqueuedRemovals", JSON.stringify(paths));
}

// Try to remove a directory / file identified by path.
// Return true for success.
function removePath(aPath, aRecursive, aDoEnqueueFailure) {
  let dirOrFile = Cc["@mozilla.org/file/local;1"]
      .createInstance(Ci.nsILocalFile);
  aRecursive = aRecursive ? true : false;

  try {
    dirOrFile.initWithPath(aPath);
  } catch (e) {
    // Invalid path; just act like it was removed.
    return true;
  }

  if (dirOrFile.exists()) {
    if (dirOrFile.isDirectory() && aRecursive) {
      // Does not support symlinks.
      // See also:
      // nsIFile.normalize()
      // #2502
      /*
      if (!DIRECTORY_TEMP.contains(dirOrFile)
          && !gDirectoryScript.contains(dirOrFile)) {
        GM_util.logError(
            GM_CONSTANTS.info.scriptHandler + " - "
            + "enqueueRemove - removePath - this path:"
            + "\n" + dirOrFile.path
            + "\n" + "is not a descendant of:"
            + "\n" + DIRECTORY_TEMP.path
            + "\n" + "or"
            + "\n" + gDirectoryScript.path);
        return true;
      }
      */
      if (!DIRECTORY_TEMP.contains(dirOrFile)) {
        GM_util.logError(
            GM_CONSTANTS.info.scriptHandler + " - "
            + "enqueueRemove - removePath - this path:"
            + "\n" + dirOrFile.path
            + "\n" + "is not a descendant of:"
            + "\n" + DIRECTORY_TEMP.path);
        return true;
      }
    }
    try {
      dirOrFile.remove(aRecursive);
    } catch (e) {
      if (aDoEnqueueFailure) {
        addEnqueuedPath(aPath, aRecursive);
      }

      return false;
    }
  }

  return true;
}

/**
 * Attempts to remove a file or directory immediately; if removal fails, queues
 * the path for deletion on the next browser startup.
 * @param {nsIFile} aDirOrFile - The file or directory to remove.
 * @param {boolean} aRecursive - Whether to remove a directory recursively.
 * @returns {void}
 */
function enqueueRemove(aDirOrFile, aRecursive) {
  removePath(aDirOrFile.path, aRecursive, true);
}

// Once at start up, try to remove all enqueued paths.
(function () {
  let _enqueueRemovePaths = getEnqueuedPaths();
  for (let _enqueueRemoveI = 0,
      _enqueueRemoveILen = _enqueueRemovePaths.length;
      _enqueueRemoveI < _enqueueRemoveILen;
      _enqueueRemoveI++) {
    let _enqueueRemovePath = 
        _enqueueRemovePaths[_enqueueRemoveI].path;
    let _enqueueRemoveRecursive = 
        _enqueueRemovePaths[_enqueueRemoveI].recursive;
    if (removePath(_enqueueRemovePath, _enqueueRemoveRecursive, false)) {
      removeEnqueuedPath(_enqueueRemovePath);
    }
  }
})();
