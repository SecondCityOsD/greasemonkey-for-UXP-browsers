/**
 * @file getContents.js
 * @overview Reads the text contents of an nsIFile and converts it from the
 * specified charset to a Unicode string.
 */

const EXPORTED_SYMBOLS = ["getContents"];

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

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


const SCRIPTABLE_INPUT_STREAM = Cc["@mozilla.org/scriptableinputstream;1"]
    .getService(Ci.nsIScriptableInputStream);
const SCRIPTABLE_UNICODE_CONVERTER = 
    Cc["@mozilla.org/intl/scriptableunicodeconverter"]
    .createInstance(Ci.nsIScriptableUnicodeConverter);

/**
 * Reads and returns the text contents of an nsIFile as a Unicode string.
 * @param {nsIFile} aFile - The file to read; must be a regular file.
 * @param {string} [aCharset] - The character set to use for decoding; defaults to the script charset constant.
 * @param {boolean} [aFatal] - If true, re-throws charset conversion errors instead of returning the raw bytes.
 * @returns {string} The decoded text contents, or an empty string if the file cannot be opened.
 * @throws {Error} If aFile is not a regular file, or if aFatal is true and conversion fails.
 */
function getContents(aFile, aCharset, aFatal) {
  if (!aFile.isFile()) {
    throw new Error(
        "getContents - "
        + GM_CONSTANTS.info.scriptHandler + " "
        + "tried to get contents of non-file:"
        + "\n" + aFile.path);
  }
  SCRIPTABLE_UNICODE_CONVERTER.charset = aCharset
      || GM_CONSTANTS.fileScriptCharset;

  let channel = GM_util.getChannelFromUri(GM_util.getUriFromFile(aFile));
  let input = null;
  try {
    input = channel.open();
  } catch (e) {
    GM_util.logError(
        "getContents - Could not open file:" + "\n" + aFile.path, false,
        e.fileName, e.lineNumber);
    return "";
  }

  SCRIPTABLE_INPUT_STREAM.init(input);
  let str = SCRIPTABLE_INPUT_STREAM.read(input.available());
  SCRIPTABLE_INPUT_STREAM.close();

  input.close();

  try {
    return SCRIPTABLE_UNICODE_CONVERTER.ConvertToUnicode(str);
  } catch (e) {
    if (aFatal) {
      throw e;
    }
    return str;
  }
}
