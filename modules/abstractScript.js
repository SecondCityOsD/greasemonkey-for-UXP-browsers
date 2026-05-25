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

// URL-test result memos.
//
// gCludeResultCache: keyed on "<url>|<glob>" — used by testClude's
//   GM_convertToRegexp(...).test(aUrl) call.  Many scripts share
//   common @include / @exclude globs (e.g. literal "*", or
//   "http*:" + "/" + "/" + "*/*"); without this memo every
//   script's matchesURL would re-run the same regex.
//
// gMatchResultCache: keyed on "<url>|<pattern>" — used by testMatch's
//   MatchPattern.doMatch(_url) call.  Same rationale.
//
// Both are bounded; FIFO eviction on overflow.  Both are cleared by
// AbstractScript.clearUrlMatchCaches() whenever the script list or
// globalExcludes changes (called by IPCScript.update).
//
// For a power-user profile (200 scripts, lots of shared rules) this
// cuts per-navigation regex evaluations by roughly the number of
// scripts that share each popular pattern.
const URL_MATCH_CACHE_SIZE = 1024;
var gCludeResultCache = new Map();
var gMatchResultCache = new Map();

function bumpCache(aCache, aKey, aValue) {
  if (aCache.size >= URL_MATCH_CACHE_SIZE) {
    let firstKey = aCache.keys().next().value;
    if (firstKey !== undefined) {
      aCache.delete(firstKey);
    }
  }
  aCache.set(aKey, aValue);
  return aValue;
}

/**
 * Abstract base class for script objects.
 * Do not instantiate directly — use Script or IPCScript.
 *
 * @constructor
 */
function AbstractScript() { }

/**
 * Drops every entry from the URL-test result caches.  Invoked by
 * IPCScript.update whenever the installed-script list, per-script
 * @match patterns, or site-wide globalExcludes changes — any of
 * which can flip a cached test from true to false (or vice versa).
 */
AbstractScript.clearUrlMatchCaches = function () {
  gCludeResultCache.clear();
  gMatchResultCache.clear();
};

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

    // Memoise (url, glob) → bool.  Shared @include / @exclude globs
    // across many scripts (e.g. `*`, `http*://*/*`) compile + test
    // exactly once per URL instead of once per script per URL.
    let key = aUrl + "|" + aGlob;
    let cached = gCludeResultCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    return bumpCache(gCludeResultCache, key,
        GM_convertToRegexp(aGlob, uri).test(aUrl));
  }
  function testMatch(aMatchPattern) {
    // Tolerate string entries.  Live MatchPattern instances are the
    // common case (the compiled form avoids recompiling the same
    // regex per URL test) but a defensively-stored string still
    // works.
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

    // Memoise (url, pattern) → bool.  Popular @match patterns (e.g.
    // `*://*.github.com/*`, `*://www.google.com/search*`) hit dozens
    // of scripts on a power-user profile.  doMatch + the regex-test
    // it routes through are the single largest CPU cost per
    // navigation — caching turns them into a hash lookup.
    let key = _url + "|" + aMatchPattern.pattern;
    let cached = gMatchResultCache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    return bumpCache(gMatchResultCache, key, aMatchPattern.doMatch(_url));
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
  if (this.excludeMatches && this.excludeMatches.some(testMatch)) {
    return false;
  }
  return (this.includes.some(testClude) || this.matches.some(testMatch));
};
