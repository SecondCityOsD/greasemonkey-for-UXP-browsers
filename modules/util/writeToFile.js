/**
 * @file writeToFile.js
 * @overview Safely writes a Unicode string to an nsIFile by first writing to a
 * unique temp file and then atomically moving it into place.
 */

const EXPORTED_SYMBOLS = ["writeToFile"];

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

Cu.import("resource://gre/modules/NetUtil.jsm");


const FILE_TYPE = Ci.nsIFile.NORMAL_FILE_TYPE;
//                   PR_WRONLY   PR_CREATE_FILE PR_TRUNCATE
const STREAM_FLAGS = 0x02      | 0x08         | 0x20;

var converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
    .createInstance(Ci.nsIScriptableUnicodeConverter);
converter.charset = GM_CONSTANTS.fileScriptCharset;

// Given string data and an nsIFile, write it safely to that file.
/**
 * Asynchronously writes a Unicode string to an nsIFile using a temp-then-move strategy.
 * @param {string} aData - The text content to write.
 * @param {nsIFile} aFile - The destination file; the write is performed to a sibling temp file first.
 * @param {Function} [aCallback] - Always called when the operation finishes:
 *   with undefined on success, with an Error on failure (failed copy, or a
 *   failed move into place).  Existing 0-arg callers are unaffected; callers
 *   that care can inspect the argument and abort instead of proceeding —
 *   previously the callback simply never fired on failure, silently stalling
 *   any continuation chained on it.
 * @returns {void}
 */
function writeToFile(aData, aFile, aCallback) {
  // Assume aData is a string; convert it to a UTF-8 stream.
  let istream = converter.convertToInputStream(aData);

  // Create a temporary file (stream) to hold the data.
  let tmpFile = aFile.clone();
  tmpFile.createUnique(FILE_TYPE, GM_CONSTANTS.fileMask);
  let ostream = Cc["@mozilla.org/network/safe-file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
  ostream.init(tmpFile, STREAM_FLAGS, GM_CONSTANTS.fileMask, 0);

  NetUtil.asyncCopy(istream, ostream, function (aStatus) {
    let error = null;
    if (Components.isSuccessCode(aStatus)) {
      // On successful write, move it to the real location.  moveTo can
      // itself throw (destination locked on Windows, permissions) — that
      // is a failure too, not an exception to leak into NetUtil.
      try {
        tmpFile.moveTo(aFile.parent, aFile.leafName);
      } catch (e) {
        error = e;
      }
    } else {
      error = new Error(
          "async copy failed: 0x" + (aStatus >>> 0).toString(16));
    }

    if (error) {
      Cu.reportError(
          "Greasemonkey: writeToFile(" + aFile.path + "): " + error);
      try {
        tmpFile.remove(false);
      } catch (e) {
        // Best effort — an orphaned unique temp file is otherwise harmless.
      }
    }
    if (aCallback) {
      aCallback(error || undefined);
    }
  });
}
