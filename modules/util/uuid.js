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


// Cache the UUID generator service at module load.  uuid() is called
// for every sandbox name, menu-command id, injectIntoPage test id,
// and elsewhere — pre-fix each invocation did a fresh getService.
const UUID_GENERATOR = Cc["@mozilla.org/uuid-generator;1"]
    .getService(Ci.nsIUUIDGenerator);

/**
 * Generates a new random UUID string without surrounding braces.
 * @returns {string} A UUID string in the form "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx".
 */
function uuid() {
  let uuid = UUID_GENERATOR.generateUUID().toString();

  return uuid.substring(1, uuid.length - 1);
}
