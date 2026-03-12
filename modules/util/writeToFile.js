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
 * @param {Function} [aCallback] - Called with no arguments after the file has been successfully written and renamed.
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
    if (Components.isSuccessCode(aStatus)) {
      // On successful write, move it to the real location.
      tmpFile.moveTo(aFile.parent, aFile.leafName);

      if (aCallback) {
        aCallback();
      }
    }
  });
}
