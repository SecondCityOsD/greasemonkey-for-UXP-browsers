/**
 * @file getService.js
 * @overview Returns the Greasemonkey XPCOM service's underlying JavaScript
 * object via wrappedJSObject.
 */

const EXPORTED_SYMBOLS = ["getService"];

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


/**
 * Returns the Greasemonkey addon service's JavaScript implementation object.
 * @returns {object} The wrappedJSObject of the Greasemonkey XPCOM service.
 */
function getService() {
  return Cc[GM_CONSTANTS.addonServiceContractID].getService().wrappedJSObject;
}
