/**
 * @file getUriFromUrl.js
 * @overview Parses a URL string into an nsIURI, optionally resolving it
 * relative to a base URL.  Results are memoized for performance.
 */

const EXPORTED_SYMBOLS = ["getUriFromUrl"];

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

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Parses a URL string into an nsIURI, optionally resolving it relative to a base.
 * Results are memoized.
 * @param {string} aUrl - The URL string to parse.
 * @param {string|nsIURI} [aBase] - An optional base URL string or nsIURI for relative resolution.
 * @returns {nsIURI|null} The parsed URI, or null if parsing fails.
 */
function getUriFromUrl(aUrl, aBase) {
  let baseUri = null;
  if (typeof aBase == "string") {
    baseUri = GM_util.getUriFromUrl(aBase);
  } else if (aBase) {
    baseUri = aBase;
  }

  try {
    return GM_CONSTANTS.ioService.newURI(aUrl, null, baseUri);
  } catch (e) {
    return null;
  }
}
getUriFromUrl = GM_util.memoize(getUriFromUrl);
