/**
 * @file abstractScript.js
 * @overview Base class for all script objects (Script, IPCScript).
 *
 * Provides the matchesURL() algorithm that decides whether a script should
 * run on a given page URL.  The logic evaluates four sets of patterns in
 * priority order:
 *
 *   1. globalExcludes — site-wide excludes from Greasemonkey preferences.
 *   2. userExcludes   — per-script user-defined excludes (override script).
 *   3. userIncludes / userMatches — per-script user-defined includes (override).
 *   4. Script-defined @include / @exclude / @match patterns.
 *
 * Subclasses must supply the following properties on their prototype or
 * instances: excludes, includes, matches, userExcludes, userIncludes,
 * userMatches, userOverride, localized.name.
 *
 * See the large truth-table comment inside matchesURL() for the full
 * interaction between these sets (issue #1298).
 */

"use strict";

const EXPORTED_SYMBOLS = ["AbstractScript"];

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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/convertToRegexp.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/matchPattern.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const ABOUT_BLANK_REGEXP = new RegExp(GM_CONSTANTS.urlAboutPart1Regexp, "");

/**
 * Abstract base class for script objects.
 * Do not instantiate directly — use Script or IPCScript.
 *
 * @constructor
 */
function AbstractScript() { }

/**
 * Site-wide global excludes sourced from Greasemonkey preferences.
 * Returns an empty array in the base class; overridden by IPCScript to
 * return the real list received from the parent process.
 *
 * @type {string[]}
 */
Object.defineProperty(AbstractScript.prototype, "globalExcludes", {
  "get": function AbstractScript_getGlobalExcludes() {
    return [];
  },
  "configurable": true,
});

/**
 * Determines whether this script should execute on the given URL.
 *
 * Evaluation order (first matching rule wins):
 *   1. URL is not greasemonkeyable (chrome:, about:, …) → false
 *   2. URL matches a global exclude → false
 *   3. URL matches a user exclude → false
 *   4. URL matches a user include/match → true
 *   5. userOverride is set but no user includes defined → match against "*"
 *   6. URL matches a script @exclude → false
 *   7. URL matches a script @include or @match → true
 *   8. No rules matched → false
 *
 * about:blank is never matched unless the pattern explicitly targets it
 * (see bug #1298).
 *
 * @param {string} aUrl - The page URL to test.
 * @returns {boolean} True if the script should run on this URL.
 */
AbstractScript.prototype.matchesURL = function (aUrl) {
  var uri = GM_util.getUriFromUrl(aUrl);
  var _AbstractScript = this;

  function testClude(aGlob) {
    // See #1298.
    // Do not run in about:blank unless _specifically_ requested.
    if (ABOUT_BLANK_REGEXP.test(aUrl) && !ABOUT_BLANK_REGEXP.test(aGlob)) {
      return false;
    }

    return GM_convertToRegexp(aGlob, uri).test(aUrl);
  }
  function testMatch(aMatchPattern) {
    if (typeof aMatchPattern == "string") {
      aMatchPattern = new MatchPattern(aMatchPattern);
    }

    let _url = aUrl;
    if (!GM_prefRoot.getValue("api.@match.hash")) {
      if (uri) {
        _url = uri.specIgnoringRef;
      } else {
        GM_util.logError(
            '"' + _AbstractScript.localized.name + '"' + "\n" +
            "abstractScript - AbstractScript.matchesURL - testMatch:" + "\n" +
            GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.invalidUrl")
            .replace("%1", aUrl));
      }
    }

    return aMatchPattern.doMatch(_url);
  }

  // Flat deny if URL is not greaseable, or matches global excludes.
  if (!GM_util.isGreasemonkeyable(aUrl)) {
    return false;
  }

  /*
  uE - the user excludes
  uIM - the user includes/matches
  sE - the script excludes
  sIM - the script includes/matches

  0  0   0  0

  0  uIM 0  0
  0  0   sE 0
  0  0   0  sIM

  0  uIM sE 0
  0  uIM 0  sIM
  0  0   sE sIM

  0  uIM sE sIM

  uE 0   0  0

  uE uIM 0  0
  uE 0   sE 0
  uE 0   0  sIM

  uE uIM sE 0
  uE uIM 0  sIM
  uE 0   sE sIM

  uE uI  sE sIM
  */

  if (this.globalExcludes.some(testClude)) {
    return false;
  }

  // Allow based on user cludes.
  if (this.userExcludes.some(testClude)) {
    return false;
  }
  if (this.userIncludes.some(testClude) || this.userMatches.some(testMatch)) {
    return true;
  } else {
    if (this.userOverride) {
      if ((this.userIncludes.length == 0) && (this.userMatches.length == 0)) {
        return [GM_CONSTANTS.script.includeAll].some(testClude);
      } else {
        return false;
      }
    }
  }

  // Finally allow based on script cludes and matches.
  if (this.excludes.some(testClude)) {
    return false;
  }
  return (this.includes.some(testClude) || this.matches.some(testMatch));
};
