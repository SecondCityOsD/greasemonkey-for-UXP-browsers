/* ***** BEGIN LICENSE BLOCK *****
 * Version: MPL 1.1
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
 * The Original Code is AdBlock for Mozilla.
 *
 * The Initial Developer of the Original Code is
 * Henrik Aasted Sorensen.
 * Portions created by the Initial Developer are Copyright (C) 2002
 * the Initial Developer. All Rights Reserved.
 *
 * Contributor(s):
 *   Henrik Aasted Sorensen <henrik@aasted.org>
 *   Stefan Kinitz <mcmurmel.blah@gmx.de>
 *   Rue <quill@ethereal.net>
 *
 * ***** END LICENSE BLOCK ***** */

const EXPORTED_SYMBOLS = ["GM_convertToRegexp"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/util.js");


const TLD_REGEXP = /^([^:]+:\/\/[^\/]+)\.tld(\/.*)?$/;

// Exposed outer method takes regex as string, and handles the magic TLD.
// (Can't memoize a URI object, yet we want to do URL->URI outside this method,
// once for efficiency. Compromise: memoize just the internal string handling.)
/**
 * Converts a glob or regex pattern string to a RegExp, substituting .tld with the
 * actual public suffix of aUri when the pattern uses the magic ".tld" token.
 * @param {string} aPattern - A glob pattern or /regex/ string to convert.
 * @param {nsIURI} [aUri] - The URI used to resolve ".tld" placeholders in the pattern.
 * @param {boolean} [aForceGlob] - If true, treat the pattern as a glob even if it looks like a /regex/.
 * @returns {RegExp} A compiled regular expression for matching URLs against the pattern.
 */
function GM_convertToRegexp(aPattern, aUri, aForceGlob) {
  let strRegexp = GM_convertToRegexpInner(aPattern, aForceGlob);

  // Inner returns a RegExp, not str, for input regex (not glob) patterns.
  // Use those directly without magic TLD modifications.
  if (strRegexp instanceof RegExp) {
    return strRegexp;
  }

  if (aUri && strRegexp.match(TLD_REGEXP)) {
    let tld = null;
    try {
      tld = Cc["@mozilla.org/network/effective-tld-service;1"]
          .getService(Ci.nsIEffectiveTLDService)
          .getPublicSuffix(aUri);
    } catch (e) {
      // There are expected failure modes, i.e. bare hostname
      // - like http://localhost/ - has no TLD.
    }
    if (tld) {
      strRegexp = strRegexp.replace(TLD_REGEXP, "$1." + tld + "$2");
    }
  }

  return new RegExp(strRegexp, "i");
}

// Memoized internal implementation just does glob -> regex translation.
function GM_convertToRegexpInner(aPattern, aForceGlob) {
  let str = new String(aPattern);

  if (!aForceGlob && (str.substr(0, 1) == "/") && (str.substr(-1, 1) == "/")) {
    // Leading and trailing slash means raw regex.
    return new RegExp(str.substring(1, str.length - 1), "i");
  }

  let res = "^";

  for (let i = 0, iLen = str.length; i < iLen; i++) {
    switch(str[i]) {
      case "*" :
        res += ".*";
        break;
      case "." :
      case "?" :
      case "^" :
      case "$" :
      case "+" :
      case "{" :
      case "}" :
      case "[" :
      case "]" :
      case "|" :
      case "(" :
      case ")" :
      case "\\" :
        res += "\\" + str[i];
        break;
      case " " :
        // Remove spaces from URLs.
        break;
      default :
        res += str[i];
        break;
    }
  }

  return res + "$";
}
GM_convertToRegexpInner = GM_util.memoize(GM_convertToRegexpInner);
