/**
 * @file getBestLocaleMatch.js
 * @overview Selects the best matching locale from an available list given a
 * preferred locale, preferring exact matches then language-only matches.
 */

const EXPORTED_SYMBOLS = ["getBestLocaleMatch"];

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


const SEPARATOR = "-";

// This function tries to find the best matching locale.
// Locales should be given in the form "lang[-COUNTRY]".
// If an exact match (i.e. both lang and country match) can be found,
// it is returned.
// Otherwise, a partial match based on the lang part is attempted.
// Partial matches without country are preferred over lang matches
// with non-matching country.
// If no locale matches, null is returned.
/**
 * Finds the best matching locale for the user's preferred locale from a list of available ones.
 * @param {string} aPreferred - The preferred locale tag, e.g. "en-US".
 * @param {string[]} aAvailable - Array of available locale tags to search.
 * @returns {string|null} The best-matching locale from aAvailable, or null if none match.
 */
function getBestLocaleMatch(aPreferred, aAvailable) {
  let preferredLang = aPreferred.split(SEPARATOR)[0];

  let langMatch = null;
  let partialMatch = null;
  for (let i = 0, iLen = aAvailable.length; i < iLen; i++) {
    let current = aAvailable[i];
    // Both lang and country match.
    if (current == aPreferred) {
      return current;
    }

    if (current == preferredLang) {
      // Only lang matches, no country.
      langMatch = current;
    } else if (current.split(SEPARATOR)[0] == preferredLang) {
      // Only lang matches, non-matching country.
      partialMatch = current;
    }
  }

  return langMatch || partialMatch;
}
