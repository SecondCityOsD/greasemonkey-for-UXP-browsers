/**
 * @file getChannelFromUri.js
 * @overview Creates an nsIChannel for a given nsIURI via newChannelFromURI2
 * with a system principal.
 *
 * Historical note: pre-cleanup, this module fell back to the legacy
 * newChannelFromURI() (single-arg, pre-Fx48) when the modern -2 variant
 * was missing.  UXP browsers (Pale Moon 28+, Basilisk current) all ship
 * newChannelFromURI2, so the fallback was unreachable and was removed.
 */

const EXPORTED_SYMBOLS = ["getChannelFromUri"];

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


/**
 * Creates an nsIChannel for the given URI with a system-principal load info.
 * @param {nsIURI} aUri - The URI for which to create the channel.
 * @returns {nsIChannel} The newly created channel.
 */
function getChannelFromUri(aUri) {
  return GM_CONSTANTS.ioService.newChannelFromURI2(
      aUri, null, Services.scriptSecurityManager.getSystemPrincipal(),
      null, Ci.nsILoadInfo.SEC_NORMAL, Ci.nsIContentPolicy.TYPE_OTHER);
}
