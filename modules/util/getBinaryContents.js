/**
 * @file getBinaryContents.js
 * @overview Reads the complete binary contents of an nsIFile and returns them
 * as a raw byte string.
 */

const EXPORTED_SYMBOLS = ["getBinaryContents"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Reads all bytes from a file and returns them as a raw binary string.
 * @param {nsIFile} aFile - The file to read.
 * @returns {string} A string of raw bytes representing the file's contents.
 */
function getBinaryContents(aFile) {
  let channel = GM_util.getChannelFromUri(GM_util.getUriFromFile(aFile));
  let input = channel.open();

  let bstream = Cc["@mozilla.org/binaryinputstream;1"]
      .createInstance(Ci.nsIBinaryInputStream);
  bstream.setInputStream(input);

  return bstream.readBytes(bstream.available());
}
