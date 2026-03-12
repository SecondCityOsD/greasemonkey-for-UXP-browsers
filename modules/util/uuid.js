/**
 * @file uuid.js
 * @overview Generates a random UUID string (without surrounding braces) using
 * the XPCOM nsIUUIDGenerator service.
 */

const EXPORTED_SYMBOLS = ["uuid"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}


/**
 * Generates a new random UUID string without surrounding braces.
 * @returns {string} A UUID string in the form "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
 */
function uuid() {
  let uuid = Cc["@mozilla.org/uuid-generator;1"]
      .getService(Ci.nsIUUIDGenerator)
      .generateUUID().toString();

  return uuid.substring(1, uuid.length - 1);
}
