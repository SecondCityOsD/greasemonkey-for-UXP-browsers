/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1/GPL 2.0/LGPL 2.1
 *
 * The contents of this file are subject to the Mozilla Public License Version
 * 1.1 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 * http://www.mozilla.org/MPL/
 *
 * Software distributed under the License is distributed on an "AS IS" basis,
 * WITHOUT WARRANTY OF ANY KIND, either express or implied. See the License
 * for the specific language governing rights and limitations under the
 * License.
 *
 * The Original Code is Page Modifications code.
 *
 * The Initial Developer of the Original Code
 * the Mozilla Foundation.
 * Portions created by the Initial Developer are Copyright (C) 2009
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   David Dahl <ddahl@mozilla.com>
 *   Drew Willcoxon <adw@mozilla.com>
 *   Erik Vold <erikvvold@gmail.com>
 *   Nils Maier <maierman@web.de>
 *   Anthony Lieuallen <arantius@gmail.com>
 *
 * Alternatively, the contents of this file may be used under the terms of
 * either the GNU General Public License Version 2 or later (the "GPL"), or
 * the GNU Lesser General Public License Version 2.1 or later (the "LGPL"),
 * in which case the provisions of the GPL or the LGPL are applicable instead
 * of those above. If you wish to allow use of your version of this file only
 * under the terms of either the GPL or the LGPL, and not to allow others to
 * use your version of this file under the terms of the MPL, indicate your
 * decision by deleting the provisions above and replace them with the notice
 * and other provisions required by the GPL or the LGPL. If you do not delete
 * the provisions above, a recipient may use your version of this file under
 * the terms of any one of the MPL, the GPL or the LGPL.
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = ["MatchPattern"];

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
Cu.import("chrome://greasemonkey-modules/content/util.js");


// Firefox 41+
// http://bugzil.la/1171248
//
// Cu.import("resource://gre/modules/MatchPattern.jsm");
// let match = new MatchPattern("*://www.domain.org/");
// let uri = ...;
// match.matches(uri); // true/false
//
// Cu.import("resource://gre/modules/MatchPattern.jsm");
// let match = new MatchPattern("*://www.domain.org/");
// let uri = ...;
// match.matches(uri); // true/false
//
// // Not solved:
// //  GM_convertToRegexp()
// //  *.tld
// this.getHostMatcher = function (aUri, aHost) {
//   // This code ignores the port.
//   if (aHost == "*") {
//     return true;
//   }
//   if (aHost.startsWith("*.")) {
//     let suffix = aHost.substr(2);
//     let dotSuffix = "." + suffix;
//
//     return (aUri.host === suffix) || aUri.host.endsWith(dotSuffix);
//   }
//
//   return aUri.host === aHost;
// }
//
// // This function converts a glob pattern
// // (containing * and possibly ? as wildcards) to a regular expression.
// function globToRegexp(aPat, aAllowQuestion) {
//   // Escape everything except ? and *.
//   aPat = aPat.replace(/[.+^${}()|[\]\\]/g, "\\$&");
//
//   if (aAllowQuestion) {
//     aPat = aPat.replace(/\?/g, ".");
//   } else {
//     aPat = aPat.replace(/\?/g, "\\?");
//   }
//   aPat = aPat.replace(/\*/g, ".*");
//
//   return new RegExp("^" + aPat + "$");
// }

const SCHEMES_VALID = ["file", "ftp", "http", "https"];
// const SCHEMES_VALID_REGEXP = SCHEMES_VALID.join("|");
const SCHEMES_ALL_VALID = ["http", "https"];
// const SCHEMES_ALL_VALID_REGEXP = SCHEMES_ALL_VALID.join("|");

const HOST_REGEXP = /^(?:\*\.)?[^*\/]+$|^\*$|^$/;

var gPartsRegexp = null;
if (GM_prefRoot.getValue("api.@match.better")) {
  // MatchPattern.jsm
  gPartsRegexp = new RegExp(`^([a-z]+|\\*)://(\\*|\\*\\.[^*/]+|[^*/]+|)(/.*)$`, "");
} else {
  gPartsRegexp = new RegExp("^([a-z*]+)://([^/]+)(?:(/.*))$", "");
}

// For the format of "pattern".
// http://code.google.com/chrome/extensions/match_patterns.html
/**
 * Constructs a MatchPattern that can test URLs against a Chrome-style match pattern.
 * @param {string} aPattern - A match pattern string such as "*://example.com/*" or "<all_urls>".
 * @throws {Error} If aPattern cannot be parsed or contains an invalid scheme, host, or path.
 */
function MatchPattern(aPattern) {
  this._pattern = aPattern;

  // Special case "<all_urls>".
  if (aPattern == "<all_urls>") {
    this._all = true;
    this._scheme = "all_urls";
    return undefined;
  } else {
    this._all = false;
  }

  let match = aPattern.match(gPartsRegexp);
  // We allow the host to be empty for file URLs.
  let _match = match;
  if (GM_prefRoot.getValue("api.@match.better")) {
    if (!match || ((match[1] != "file") && (match[2] == ""))) {
      _match = false;
    }
  } else {
    if (!match) {
      _match = false;
    }
  }
  if (!_match) {
    aPattern = "[" + (typeof aPattern) + "] " + aPattern;
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.matchPattern.parse")
            .replace("%1", aPattern));
  }
  let scheme = match[1];
  this._scheme = scheme;
  let host = match[2];
  let path = match[3];

  if ((scheme != "*") && (SCHEMES_VALID.indexOf(scheme) == -1)) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.matchPattern.scheme")
            .replace("%1", scheme));
  }

  if (!HOST_REGEXP.test(host)) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.matchPattern.host")
            .replace("%1", host));
  }

  if (path[0] !== "/") {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.matchPattern.path")
            .replace("%1", path));
  }

  // MatchPattern.jsm
  //
  // this._host = host;
  // let pathMatch = globToRegexp(path, false);
  // this._pathMatch = pathMatch.test.bind(pathMatch);

  if (host) {
    // We have to manually create the hostname regexp (instead of using
    // GM_convertToRegexp) to properly handle *.example.tld, which should match
    // example.tld and any of its subdomains, but not anotherexample.tld.
    this._hostRegexp = new RegExp("^" +
        // Two characters in the host portion need special treatment:
        //   - "." should not be treated as a wildcard, so we escape it to \.
        //   - if the hostname only consists of "*" (i.e. full wildcard),
        //     replace it with .*
        host.replace(/\./g, "\\.").replace(/^\*$/, ".*")
        // Then, handle the special case of "*." (any or no subdomain)
        // for match patterns. "*." has been escaped to "*\."
        // by the replace above.
            .replace("*\\.", "(.*\\.)?") + "$", "i");
  } else {
    // If omitted, then it means "",
    // used for file: scheme (or an alias for localhost).
    this._hostRegexp = /^$/;
  }
  this._pathRegexp = GM_convertToRegexp(path, false, true);
}

Object.defineProperty(MatchPattern.prototype, "pattern", {
  "get": function MatchPattern_getPattern() {
    return "" + this._pattern;
  },
  "enumerable": true,
});

/**
 * Tests whether a URL string matches this pattern.
 * @param {string} aUriSpec - The URL string to test.
 * @returns {boolean} True if the URL matches the pattern's scheme, host, and path.
 */
MatchPattern.prototype.doMatch = function (aUriSpec) {
  let matchURI = GM_util.getUriFromUrl(aUriSpec);

  if (SCHEMES_VALID.indexOf(matchURI.scheme) == -1) {
    return false;
  }

  if (this._all) {
    return true;
  }

  if ((this._scheme == "*")
      && (SCHEMES_ALL_VALID.indexOf(matchURI.scheme) == -1)) {
    return false;
  }
  if ((this._scheme != "*") && (this._scheme != matchURI.scheme)) {
    return false;
  }

  // MatchPattern.jsm
  //
  // return this.getHostMatcher(matchURI, this._host)
  //     && this._pathMatch(matchURI.path);
  // [or]
  // return this.getHostMatcher(matchURI, this._host)
  //     && this._pathMatch(matchURI.cloneIgnoringRef().path);

  return this._hostRegexp.test(matchURI.host)
      && this._pathRegexp.test(matchURI.path);
};
