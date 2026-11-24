/**
 * @file hashFile.js
 * @overview The hex digest of a local file, for the hashes a script pins
 *   to its @require and @resource files (sha256, sha384, sha512) and the
 *   backup's sha256 of each file.
 */

const EXPORTED_SYMBOLS = ["hashFile"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}

/**
 * Streams the file through the platform's nsICryptoHash: no bytes are
 * held in JavaScript.
 *
 * @param {nsIFile} aFile
 * @param {string}  [aAlgo] - "sha256" (the default), "sha384" or "sha512".
 * @returns {string} The lowercase hex digest.
 * @throws When the file can't be read.
 */
function hashFile(aFile, aAlgo) {
  let algo;
  switch (aAlgo) {
    case "sha512":
      algo = Ci.nsICryptoHash.SHA512;
      break;
    case "sha384":
      algo = Ci.nsICryptoHash.SHA384;
      break;
    default:
      algo = Ci.nsICryptoHash.SHA256;
      break;
  }
  let istream = Cc["@mozilla.org/network/file-input-stream;1"]
      .createInstance(Ci.nsIFileInputStream);
  istream.init(aFile, 0x01 /* PR_RDONLY */, parseInt("444", 8), 0);
  try {
    let hasher = Cc["@mozilla.org/security/hash;1"]
        .createInstance(Ci.nsICryptoHash);
    hasher.init(algo);
    hasher.updateFromStream(istream, 0xffffffff);
    let binary = hasher.finish(false);
    let hex = "";
    for (let i = 0; i < binary.length; i++) {
      hex += ("0" + binary.charCodeAt(i).toString(16)).slice(-2);
    }
    return hex;
  } finally {
    try {
      istream.close();
    } catch (e) {
      // Best effort.
    }
  }
}
