/**
 * @file getChannelFromUri.js
 * @overview Creates an nsIChannel for a given nsIURI, using the appropriate
 * API variant (newChannelFromURI2 or legacy newChannelFromURI).
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
 * Creates an nsIChannel for the given URI using the best available API.
 * @param {nsIURI} aUri - The URI for which to create the channel.
 * @returns {nsIChannel} The newly created channel.
 */
function getChannelFromUri(aUri) {
  if (GM_CONSTANTS.ioService.newChannelFromURI2) {
    return GM_CONSTANTS.ioService.newChannelFromURI2(
        aUri, null, Services.scriptSecurityManager.getSystemPrincipal(),
        null, Ci.nsILoadInfo.SEC_NORMAL, Ci.nsIContentPolicy.TYPE_OTHER);
  } else {
    return GM_CONSTANTS.ioService.newChannelFromURI(aUri);
  }
}
