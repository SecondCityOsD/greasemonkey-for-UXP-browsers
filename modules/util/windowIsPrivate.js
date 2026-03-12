/**
 * @file windowIsPrivate.js
 * @overview Checks whether a content window belongs to a private-browsing
 * session using PrivateBrowsingUtils.
 */

const EXPORTED_SYMBOLS = ["windowIsPrivate"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");


/**
 * Checks whether a content window is part of a private-browsing session.
 * @param {nsIDOMWindow} aContentWin - The content window to inspect.
 * @returns {boolean} True if the window is in a private-browsing context.
 */
function windowIsPrivate(aContentWin) {
  // i.e. the Private Browsing autoStart pref:
  // "browser.privatebrowsing.autostart"
  return PrivateBrowsingUtils.isContentWindowPrivate(aContentWin);
}
