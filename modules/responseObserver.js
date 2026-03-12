/**
 * @file responseObserver.js
 * @overview Optional CORS/CSP response-header override for Greasemonkey.
 *
 * When Greasemonkey is enabled and the user has turned on the cors_override or
 * csp_override preferences, this module intercepts HTTP responses and rewrites
 * (or removes) selected security headers so that userscripts can make
 * cross-origin XHR requests and eval content that would otherwise be blocked.
 *
 * Two integration modes are supported transparently:
 *
 *   1. XPCOM nsIObserver (UXP / Pale Moon) — registers an observer on the
 *      "http-on-examine-response", "http-on-examine-cached-response", and
 *      "http-on-examine-merged-response" topics.  The channel's response
 *      headers are mutated directly via nsIHttpChannel.setResponseHeader().
 *
 *   2. WebExtension webRequest.onHeadersReceived (fallback) — if the XPCOM
 *      observer registration fails, the module falls back to
 *      chrome.webRequest.onHeadersReceived with "blocking" mode.
 *
 * Headers handled:
 *   CORS: access-control-allow-headers, access-control-allow-methods,
 *         access-control-allow-origin, access-control-expose-headers,
 *         x-content-type-options, x-frame-options
 *   CSP:  content-security-policy, x-content-security-policy
 *
 * Preferences (all under the GM "greasemonkey." branch):
 *   cors_override            — enable CORS header rewriting
 *   csp_override             — enable CSP header rewriting
 *   cors_override.excludes, cors_override.includes, cors_override.matches
 *                            — URL filters for which sites to affect
 *
 * Override rules are fully configurable via preferences; see _corsOverride()
 * and _cspOverride() for the per-header rule lookup logic.
 */

"use strict";

const EXPORTED_SYMBOLS = [];

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

// try {
Cu.import("resource://gre/modules/Services.jsm");
// } catch (e) {
//   // Ignore.
// }

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/convertToRegexp.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/matchPattern.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


var gCorsCspName = GM_CONSTANTS.info.scriptHandler + " CORS/CSP";

var gCorsCspObservers = [
  {
    "allow": true,
    "value": "http-on-examine-response",
  },
  {
    "allow": true,
    "value": "http-on-examine-cached-response",
  },
  {
    "allow": true,
    "value": "http-on-examine-merged-response",
  },
];

var gCorsCspListener = {
  "value": "onHeadersReceived",
};

var gCorsCspMessages = {
  "notDefined": {
    "content": "not defined",
    "value": "[" + "not defined" + "]",
  },
};

var gCorsCspType = "cors_csp";
var gCorsType = "cors";
var gCspType = "csp";
var gCorsCspOverridePrefSeparator = "_";
var gCorsCspOverridePrefSuffix = "override";
var gCorsCspOverridePrefItemsSeparator = ".";
var gCorsCspOverridePrefItemsValue = "value";
var gCorsCspOverrideExcludes = "excludes";
var gCorsCspOverrideIncludes = "includes";
var gCorsCspOverrideMatches = "matches";
var gCorsCspOverrideAll = "[all]";
var gCorsCspOverrideAllAllow = "[all-allow]";
var gCorsCspOverridePrefBase = gCorsCspType
    + gCorsCspOverridePrefSeparator + gCorsCspOverridePrefSuffix;
var gCorsOverridePrefBase = gCorsType
    + gCorsCspOverridePrefSeparator + gCorsCspOverridePrefSuffix;
var gCspOverridePrefBase = gCspType
    + gCorsCspOverridePrefSeparator + gCorsCspOverridePrefSuffix;
var gCorsCspOverrideDumpPrefix = "corsCspOverride";

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Tests whether CORS/CSP overrides should be applied to the given URL.
 *
 * Reads the cors_override.excludes / .includes / .matches preferences to build
 * a filter: the URL must pass isGreasemonkeyable(), must not match any exclude
 * glob, and must match at least one include glob or @match pattern.
 *
 * @param {string} aUrl - The response URL to test.
 * @returns {boolean} True if the URL should have its headers overridden.
 */
function _corsCspTestUrl(aUrl) {
  var _internalSeparator = "_";

  var values = {};
  var valueDefault = "[\"\"]";

  values[gCorsCspOverrideExcludes] = valueDefault;
  values[gCorsCspOverrideIncludes] = valueDefault;
  values[gCorsCspOverrideMatches] = valueDefault;

  var _pref = "";
  Object.getOwnPropertyNames(values).forEach(function (aProp) {
    _pref = gCorsCspOverridePrefBase
        + gCorsCspOverridePrefItemsSeparator + aProp;
    if (GM_prefRoot.exists(_pref) && GM_prefRoot.getValue(_pref)) {
      _pref = gCorsCspOverridePrefBase
          + gCorsCspOverridePrefItemsSeparator + aProp
          + gCorsCspOverridePrefItemsSeparator + gCorsCspOverridePrefItemsValue;
      if (GM_prefRoot.exists(_pref)) {
        values[aProp] = GM_prefRoot.getValue(_pref);
      }
    }
  });

  var _error = false;
  Object.getOwnPropertyNames(values).forEach(function (aProp) {
    try {
      values[_internalSeparator + aProp] = JSON.parse(values[aProp]);
    } catch (e) {
      dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - "
          + aProp + ": " + values[aProp]
          + " - e:" + "\n" + e + "\n");
      _error = true;
      return false;
    }
    if (!Array.isArray(values[_internalSeparator + aProp])) {
      dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - "
          + aProp + ": " + values[aProp]
          + " - isArray: false" + "\n");
      _error = true;
      return false;
    }
    values[aProp + _internalSeparator] = false;
  });
  if (_error) {
    return false;
  }

  var uri = GM_util.getUriFromUrl(aUrl);

  function testClude(aGlob) {
    return GM_convertToRegexp(aGlob, uri).test(aUrl);
  }

  function testMatch(aMatchPattern) {
    if (typeof aMatchPattern == "string") {
      try {
        aMatchPattern = new MatchPattern(aMatchPattern);
      } catch (e) {
        dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + "): "
            + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.parse.ignoringMatch")
            .replace("%1", aMatchPattern).replace("%2", e) + "\n");
        return false;
      }
    }

    let _url = aUrl;
    if (!GM_prefRoot.getValue("api.@match.hash")) {
      if (uri) {
        _url = uri.specIgnoringRef;
      } else {
        dump(gCorsCspOverrideDumpPrefix + ": "
            + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.invalidUrl")
            .replace("%1", aUrl) + "\n");
      }
    }

    return aMatchPattern.doMatch(_url);
  }

  if (!GM_util.isGreasemonkeyable(aUrl)) {
    // dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - isGreasemonkeyable: false" + "\n");
    return false;
  }

  values[gCorsCspOverrideExcludes + _internalSeparator] = (
      (values[_internalSeparator + gCorsCspOverrideExcludes]
          .join("").trim() != "")
      && values[_internalSeparator + gCorsCspOverrideExcludes]
          .some(testClude));
  // dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - " + gCorsCspOverrideExcludes + ": " + values[gCorsCspOverrideExcludes] + " => " + values[gCorsCspOverrideExcludes + _internalSeparator].toString() + "\n");

  if (values[gCorsCspOverrideExcludes + _internalSeparator]) {
    return false;
  }

  values[gCorsCspOverrideIncludes + _internalSeparator] = (
      (values[_internalSeparator + gCorsCspOverrideIncludes]
          .join("").trim() != "")
      && values[_internalSeparator + gCorsCspOverrideIncludes]
          .some(testClude));
  // dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - " + gCorsCspOverrideIncludes + ": " + values[gCorsCspOverrideIncludes] + " => " + values[gCorsCspOverrideIncludes + _internalSeparator].toString() + "\n");

  values[gCorsCspOverrideMatches + _internalSeparator] = (
      (values[_internalSeparator + gCorsCspOverrideMatches]
          .join("").trim() != "")
      && values[_internalSeparator + gCorsCspOverrideMatches]
          .some(testMatch));
  // dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + ") - " + gCorsCspOverrideMatches + ": " + values[gCorsCspOverrideMatches] + " => " + values[gCorsCspOverrideMatches + _internalSeparator].toString() + "\n");

  var _return = values[gCorsCspOverrideIncludes + _internalSeparator]
      || values[gCorsCspOverrideMatches + _internalSeparator];
  return _return;
}

/**
 * Dispatches a single header's override logic based on its type.
 *
 * @param {string} aRules  - The current header value string.
 * @param {object} aHeader - Header descriptor with .type ("cors" or "csp").
 * @returns {string} The (possibly rewritten) header value string.
 */
function _corsCspRulesOverride(aRules, aHeader) {
  switch (aHeader.type) {
    case gCorsType:
      aRules = _corsOverride(aRules, aHeader);
      break;
    case gCspType:  
      aRules = _cspOverride(aRules);
      break;
  }
  return aRules;
}

/**
 * Array filter predicate: keeps header objects whose value is non-empty.
 *
 * @param {object} aObj - Header descriptor with a .value string.
 * @returns {boolean} True if the header value is non-empty.
 */
function _corsCspRulesEmpty(aObj) {
  return aObj.value !== "";
}

/**
 * Main CORS/CSP override entry point.  Called either as an XPCOM nsIObserver
 * "observe" callback or as a WebExtension onHeadersReceived listener.
 *
 * Determines which integration mode is active by checking whether aSubject has
 * a responseHeaders property (WebExtension) or is an nsIChannel (XPCOM).
 * Only acts on HTTP 200 responses that pass _corsCspTestUrl().
 *
 * In XPCOM mode returns null (channel headers are mutated in place).
 * In WebExtension mode returns a modified responseHeaders array.
 *
 * @param {nsISupports|object} aSubject - XPCOM subject (nsIHttpChannel) or
 *   WebExtension request details object (has .responseHeaders, .url, etc.).
 * @param {string} aTopic - XPCOM observer topic, or ignored in WE mode.
 * @param {string} aData  - XPCOM extra data (unused).
 * @returns {null|object} null in XPCOM mode; modified details in WE mode.
 */
function corsCspOverride(aSubject, aTopic, aData) {
  var aDetailsIn = aSubject;
  var aDetailsOut = {};

  var addonType = 0;
  if ((aDetailsIn != null)
      && (typeof aDetailsIn == "object")
      && aDetailsIn.hasOwnProperty("responseHeaders")) {
    addonType = 1;
    aTopic = gCorsCspListener.value;
  }

  if (!GM_util.getEnabled()) {
    return (addonType == 0) ? null : aDetailsIn.responseHeaders;
  }

  var corsOverride = GM_prefRoot.getValue(gCorsOverridePrefBase);
  var cspOverride = GM_prefRoot.getValue(gCspOverridePrefBase);

  if (!corsOverride && !cspOverride) {
    return (addonType == 0) ? null : aDetailsIn.responseHeaders;
  }

  var _info = {
    "status": 0,
    "url": "",
  };

  if (addonType == 0) {
    var _observer = {
      "allow": false,
      "unknown": true,
    };
    for (var observer in gCorsCspObservers) {
      if (gCorsCspObservers[observer].value == aTopic) {
        _observer.allow = gCorsCspObservers[observer].allow;
        _observer.unknown = false;
        break;
      }
    }
    if (!_observer.allow) {
      dump(gCorsCspOverrideDumpPrefix + " - forbidden topic: " + aTopic + "\n");
      return null;
    }
    if (_observer.unknown) {
      dump(gCorsCspOverrideDumpPrefix + " - unknown topic: " + aTopic + "\n");
      return null;
    }

    var channel = aSubject.QueryInterface(Ci.nsIChannel);
    if (!channel) {
      return null;
    }

    _info.url = channel.URI.spec;
  } else {
    _info.url = aDetailsIn.url;
  }
  // dump(gCorsCspOverrideDumpPrefix + " - topic (" + aTopic + ") - url: " + _info.url + "\n");

  if (addonType == 0) {
    try {
      var httpChannel = channel.QueryInterface(Ci.nsIHttpChannel);
      _info.status = httpChannel.responseStatus;
    } catch (e) {
      // dump(gCorsCspOverrideDumpPrefix + " - http - file:// ? - e:" + "\n" + e + "\n");
      return null;
    }
  } else {
    _info.status = aDetailsIn.statusCode;
  }
  // dump(gCorsCspOverrideDumpPrefix + " - http - status: " + _info.status + "\n");

  if (_info.status != 200) {
    return (addonType == 0) ? null : aDetailsIn.responseHeaders;
  }

  if (!_corsCspTestUrl(_info.url)) {
    // dump(gCorsCspOverrideDumpPrefix + " - testUrl (" + aUrl + "): false" + "\n");
    return (addonType == 0) ? null : aDetailsIn.responseHeaders;
  }

  var corsHeaders = [
    {
      "rewrite": 0,
      "type": gCorsType,
      "value": "access-control-allow-headers",
    },
    {
      "rewrite": 0,
      "type": gCorsType,
      "value": "access-control-allow-methods",
    },
    {
      "rewrite": 0,
      "type": gCorsType,
      "value": "access-control-allow-origin",
    },
    {
      "rewrite": 0,
      "type": gCorsType,
      "value": "access-control-expose-headers",
    },
    {
      "rewrite": 2,
      "type": gCorsType,
      "value": "x-content-type-options",
    },
    {
      "rewrite": 1,
      "type": gCorsType,
      "value": "x-frame-options",
    },
  ];

  var cspHeaders = [
    {
      "type": gCspType,
      "value": "content-security-policy",
    },
    {
      "type": gCspType,
      "value": "x-content-security-policy",
    },
  ];

  var corsCspRules = null;
  var corsCspRulesMy = null;
  var _corsCspOverride = false;

  var corsCspHeaders = corsHeaders.concat(cspHeaders);

  if (addonType != 0) {
    // dump(gCorsCspOverrideDumpPrefix + " - headers - details: " + JSON.stringify(aDetailsIn) + "\n");
    var inHeaders = aDetailsIn.responseHeaders;
    var corsCspRulesIn = {
      "index": [],
      "value": [],
    };
    var corsCspRulesOut = {
      "index": [],
      "value": [],
    };
    // dump(gCorsCspOverrideDumpPrefix + " - headers - details - responseHeaders - before: " + JSON.stringify(inHeaders) + "\n");
  }

  for (var i = 0, iLen = corsCspHeaders.length; i < iLen; i++) {
    if ((corsOverride && (corsCspHeaders[i].type == gCorsType))
        || (cspOverride && (corsCspHeaders[i].type == gCspType))) {
      try {    
        if (addonType == 0) {
          corsCspRules = channel.getResponseHeader(corsCspHeaders[i].value);
        } else {
          corsCspRulesIn = {
            "index": [],
            "value": [],
          };
          for (var j = 0, jLen = inHeaders.length;
              j < jLen; j++) {
            if (inHeaders[j].name.toLowerCase()
                == corsCspHeaders[i].value) {
              corsCspRulesIn.index.push(j);
              corsCspRulesIn.value.push(inHeaders[j].value);
              // break;
            }
          }
          if (corsCspRulesIn.index.length == 0) {
            throw gCorsCspMessages.notDefined.value;
          }
          corsCspRules = JSON.stringify(corsCspRulesIn);
        }
        // dump(gCorsCspOverrideDumpPrefix + " - header (" + corsCspHeaders[i].type + " / " + corsCspHeaders[i].value + ") - before: " + corsCspRules + "\n");
        _corsCspOverride = false;
        if (corsOverride && (corsCspHeaders[i].type == gCorsType)) {
          _corsCspOverride = true;
        }
        if (cspOverride && (corsCspHeaders[i].type == gCspType)) {
          _corsCspOverride = true;
        }
        if (addonType == 0) {
          if (_corsCspOverride) {
            corsCspRulesMy = _corsCspRulesOverride(
                corsCspRules, corsCspHeaders[i]);
            channel.setResponseHeader(
                corsCspHeaders[i].value, corsCspRulesMy, false);
          }
        } else {
          for (var j = 0, jLen = corsCspRulesIn.index.length;
              j < jLen; j++) {
            if (_corsCspOverride) {
              corsCspRulesMy = _corsCspRulesOverride(
                  corsCspRulesIn.value[j], corsCspHeaders[i]);
              inHeaders[corsCspRulesIn.index[j]].value
                  = corsCspRulesMy;
            }
          }
        }
        try {
          if (addonType == 0) {
            corsCspRules = channel.getResponseHeader(corsCspHeaders[i].value);
          } else {
            corsCspRulesOut = {
              "index": [],
              "value": [],
            };
            for (var j = 0, jLen = corsCspRulesIn.index.length;
                j < jLen; j++) {
              if (corsCspRulesIn.value[j].toLowerCase()
                  == corsCspHeaders[i].value) {
                corsCspRulesOut.index.push(j);
                corsCspRulesOut.value.push(corsCspRulesIn.value[j]);
                // break;
              }
            }
            if ((corsCspRulesOut.index.length == 0)
                || (corsCspRulesOut.value.filter(_corsCspRulesEmpty)
                  .length == 0)) {
              throw gCorsCspMessages.notDefined.value;
            }
            corsCspRules = JSON.stringify(corsCspRulesOut);
          }
        } catch (e) {
          // dump(gCorsCspOverrideDumpPrefix + " - header (" + corsCspHeaders[i].type + " / " + corsCspHeaders[i].value + ") - after - " + gCorsCspMessages.notDefined.content + "? - e:" + "\n" + e + "\n");
          continue;
        }
        // dump(gCorsCspOverrideDumpPrefix + " - header (" + corsCspHeaders[i].type + " / " + corsCspHeaders[i].value + ") - after: " + corsCspRules + "\n");
      } catch (e) {
        // dump(gCorsCspOverrideDumpPrefix + " - header (" + corsCspHeaders[i].type + " / " + corsCspHeaders[i].value + ") - " + gCorsCspMessages.notDefined.content + "? - e:" + "\n" + e + "\n");
        continue;
      }
    }
  }

  if (addonType != 0) {
    aDetailsOut.responseHeaders = inHeaders.filter(_corsCspRulesEmpty);
    // dump(gCorsCspOverrideDumpPrefix + " - headers - details - responseHeaders - after: " + JSON.stringify(aDetailsOut.responseHeaders) + "\n");
    return aDetailsOut;
  }
}

/**
 * Applies CORS header override rules for a single header.
 *
 * Checks per-header preferences to determine the target value, then
 * rewrites the header string if it does not already match.
 *
 * @param {string} aCorsRules  - The current header value.
 * @param {object} aCorsHeader - Descriptor with .value (header name) and
 *   .rewrite (index into the default value array).
 * @returns {string} The (possibly rewritten) header value.
 */
function _corsOverride(aCorsRules, aCorsHeader) {
  var rules = aCorsRules.trim();

  var rulesMyDefault = {
    "override": GM_prefRoot.getValue(
        gCorsOverridePrefBase
        + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll),
    "value": [
      "*",
      "ALLOW-FROM *",
      "",
    ],
  };

  // JSON.clone = JSON.parse(JSON.stringify(...))
  var rulesMy = {
    "value": JSON.parse(JSON.stringify(rulesMyDefault)),
  };

  // dump(gCorsCspOverrideDumpPrefix + " - cors - rules - my (" + aCorsHeader.value + ") - preset - before: " + JSON.stringify(rulesMy) + "\n");
  var _pref = "";
  if (rulesMyDefault.override) {
    rulesMy.value.override = true;
  } else {
    _pref = gCorsOverridePrefBase
        + gCorsCspOverridePrefItemsSeparator + aCorsHeader.value;
    if (GM_prefRoot.exists(_pref)) {
      rulesMy.value.override = GM_prefRoot.getValue(_pref);
    }
  }
  // dump(gCorsCspOverrideDumpPrefix + " - cors - rules - my (" + aCorsHeader.value + ") - preset - after: " + JSON.stringify(rulesMy) + "\n");

  // dump(gCorsCspOverrideDumpPrefix + " - cors - rules - my (" + aCorsHeader.value + ") - before: " + rules + "\n");
  if (rulesMy.value.override
      && (rules != rulesMy.value.value[aCorsHeader.rewrite])) {
    // dump(gCorsCspOverrideDumpPrefix + " - cors - rules - my (" + aCorsHeader.value + ") - rewrite: " + rulesMy.value.value[aCorsHeader.rewrite] + "\n");
    rules = rulesMy.value.value[aCorsHeader.rewrite];
  }
  // dump(gCorsCspOverrideDumpPrefix + " - cors - rules - my (" + aCorsHeader.value + ") - after: " + rules + "\n");

  return rules;
}

/**
 * Applies CSP header override rules to a full CSP policy string.
 *
 * Splits the policy on ";" to get individual directives, then for each
 * directive that has an override enabled:
 *   - Rewrites the directive's value list (adding sources, removing 'none').
 *   - Optionally strips hash-source ('sha256-…', etc.) tokens.
 *   - Optionally strips nonce-source ('nonce-…') tokens.
 *
 * The resulting directives are rejoined with ";" and empty directives are
 * filtered out.
 *
 * @param {string} aCspRules - The raw CSP header value (may contain multiple
 *   ";"-separated directives).
 * @returns {string} The rewritten CSP policy string.
 */
function _cspOverride(aCspRules) {
  var rulesSeparator = ";";
  var rulesValuesSeparator = " ";

  var rules = aCspRules.split(rulesSeparator);

  var cspOverrideSourceList = "[source-list]";
  var cspOverrideSourceListValue = cspOverrideSourceList
      + gCorsCspOverridePrefItemsSeparator + gCorsCspOverridePrefItemsValue;

  var rulesSpec = [
    {
      "name": "default-src",
      "value": {
        "name": "strict-dynamic",
        "value": "'strict-dynamic'",
      },
    },
    {
      "name": "sandbox",
      "value": {
        "name": "allow-forms",
        "value": "allow-forms",
      },
    },
    {
      "name": "sandbox",
      "value": {
        "name": "allow-pointer-lock",
        "value": "allow-pointer-lock",
      },
    },
    {
      "name": "sandbox",
      "value": {
        "name": "allow-popups",
        "value": "allow-popups",
      },
    },
    {
      "name": "sandbox",
      "value": {
        "name": "allow-same-origin",
        "value": "allow-same-origin",
      },
    },
    {
      "name": "sandbox",
      "value": {
          "name": "allow-scripts",
          "value": "allow-scripts",
      },
    },
    {
      "name": "sandbox",
      "value": {
        "name": "allow-top-navigation",
        "value": "allow-top-navigation",
      },
     },
    {
      "name": "script-src",
      "value": {
        "name": "strict-dynamic",
        "value": "'strict-dynamic'",
      },
    },
  ];

  var rulesMySpec = [
    {
      "delete": {
        "hash": true,
        "nonce": false,
      },
      "name": "unsafe-eval",
      "value": "'unsafe-eval'",
    },
    {
      "delete": {
        "hash": true,
        "nonce": true,
      },
      "name": "unsafe-inline",
      "value": "'unsafe-inline'",
    },
  ];

  // "*" - http://bugzil.la/1086999

  var rulesMyDefault = [
    {
      "name": gCorsCspOverrideAllAllow,
      "override": GM_prefRoot.getValue(
          gCspOverridePrefBase
          + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
          + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
      "value": "* blob: data: 'unsafe-eval' 'unsafe-inline'",
    },
    {
      "name": cspOverrideSourceList,
      "override": GM_prefRoot.getValue(
          gCspOverridePrefBase
          + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
          + gCorsCspOverridePrefItemsSeparator + cspOverrideSourceList),
      "value": GM_prefRoot.getValue(
          gCspOverridePrefBase
          + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
          + gCorsCspOverridePrefItemsSeparator + cspOverrideSourceListValue),
    },
  ];
  for (var item in rulesMySpec) {
    rulesMyDefault.push(
      {
        "name": rulesMySpec[item].name,
        "override": GM_prefRoot.getValue(
            gCspOverridePrefBase
            + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
            + gCorsCspOverridePrefItemsSeparator + rulesMySpec[item].name),
        "value": rulesMySpec[item].value,
      }
    );
  }

  // base-uri, block-all-mixed-content, child-src, connect-src,
  // font-src, form-action, frame-ancestors, frame-src, img-src,
  // manifest-src, media-src, object-src, plugin-types,
  // referrer, reflected-xss, report-uri, require-sri-for,
  // sandbox, script-src, strict-dynamic, style-src, upgrade-insecure-requests,
  // worker-src
  // JSON.clone = JSON.parse(JSON.stringify(...))
  var rulesMy = [
    {
      "name": "base-uri",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "block-all-mixed-content",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "",
        },
      ],
    },
    {
      "name": "child-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "connect-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "default-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "font-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "form-action",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "frame-ancestors",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "frame-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "img-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "manifest-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "media-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "object-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "plugin-types",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "*",
        },
      ],
    },
    {
      "name": "refferer",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "'unsafe-url'",
        },
      ],
    },
    {
      "name": "reflected-xss",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "allow",
        },
      ],
    },
    {
      "name": "report-uri",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "",
        },
      ],
    },
    {
      "name": "require-sri-for",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "",
        },
      ],
    },
    {
      "name": "sandbox",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "",
        },
      ],
    },
    {
      "name": "script-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "style-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
    {
      "name": "upgrade-insecure-requests",
      "value": [
        {
          "name": gCorsCspOverrideAllAllow,
          "override": GM_prefRoot.getValue(
              gCspOverridePrefBase
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
              + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAllAllow),
          "value": "",
        },
      ],
    },
    {
      "name": "worker-src",
      "value": JSON.parse(JSON.stringify(rulesMyDefault)),
    },
  ];
  for (var i = 0, iLen = rulesSpec.length; i < iLen; i++) {
    for (var j = 0, jLen = rulesMy.length; j < jLen; j++) {
      if (rulesSpec[i].name == rulesMy[j].name) {
        rulesMy[j].value.push(
          {
            "name": rulesSpec[i].value.name,
            "override": GM_prefRoot.getValue(
                gCspOverridePrefBase
                + gCorsCspOverridePrefItemsSeparator + gCorsCspOverrideAll
                + gCorsCspOverridePrefItemsSeparator + rulesSpec[i].value.name),
            "value": rulesSpec[i].value.value,
          }
        );
        break;
      }
    }
  }

  // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my - preset - before: " + JSON.stringify(rulesMy) + "\n");
  var _pref = "";
  for (var i = 0, iLen = rulesMy.length; i < iLen; i++) {
    labelCspOverride1:
    for (var j = 0, jLen = rulesMy[i].value.length; j < jLen; j++) {
      for (var k = 0, kLen = rulesMyDefault.length; k < kLen; k++) {
        if (rulesMyDefault[k].override
            && (rulesMyDefault[k].name == rulesMy[i].value[j].name)) {
          continue labelCspOverride1;
        }
      }
      _pref = gCspOverridePrefBase
          + gCorsCspOverridePrefItemsSeparator + rulesMy[i].name
          + gCorsCspOverridePrefItemsSeparator + rulesMy[i].value[j].name;
      if (GM_prefRoot.exists(_pref)) {
        rulesMy[i].value[j].override = GM_prefRoot.getValue(_pref);
        _pref = gCspOverridePrefBase
            + gCorsCspOverridePrefItemsSeparator + rulesMy[i].name
            + gCorsCspOverridePrefItemsSeparator + rulesMy[i].value[j].name
            + gCorsCspOverridePrefItemsSeparator
            + gCorsCspOverridePrefItemsValue;
        if (GM_prefRoot.exists(_pref)) {
          rulesMy[i].value[j].value = GM_prefRoot.getValue(_pref);
        }
      }
    }
  }
  // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my - preset - after: " + JSON.stringify(rulesMy) + "\n");

  // http://www.w3.org/TR/CSP2/#directive-script-src
  // http://www.w3.org/TR/CSP2/#source-list-syntax
  // http://bugzil.la/1004703, http://bugzil.la/1026520, etc.
  // - Content Security Policy: Ignoring “'unsafe-inline'”
  //   within script-src or style-src: nonce-source or hash-source specified
  // e.g.: https://twitter.com/
  var rulesDelete = {
    "flags": "gim",
    "prefix": "\\s?'",
    "suffix": "'",
  };
  var rulesDeleteHashRegex = {
    "override": true,
    "value": new RegExp(rulesDelete.prefix
        + "(sha256|sha384|sha512)-[^']+"
        + rulesDelete.suffix, rulesDelete.flags),
  };
  var rulesDeleteNonceRegex = {
    "override": true,
    "value": new RegExp(rulesDelete.prefix
        + "nonce-[^']+"
        + rulesDelete.suffix, rulesDelete.flags),
  };
  var rulesDeleteNoneRegex = {
    "override": true,
    "value": new RegExp(rulesDelete.prefix
        + "none"
        + rulesDelete.suffix, rulesDelete.flags),
  };

  // - Content Security Policy: Duplicate ... directives detected.
  //   All but the first instance will be ignored.
  // But... All directives. We will not count on it...
  var ruleName = "";
  var ruleValue = "";
  var ruleValues = [];
  var ruleRewriteHash = false;
  var ruleRewriteNonce = false;
  var ruleRewriteNone = false;
  var ruleRewriteValue = "";
  var ruleSourceListValue = "";
  var ruleSourceListValues = [];
  var ruleSourceListRewriteValue = "";
    for (var i = 0, iLen = rules.length; i < iLen; i++) {
    if (rules[i].trim() != "") {
      // dump(gCorsCspOverrideDumpPrefix + " - csp - rules: " + rules[i].trim() + "\n");
      for (var j = 0, jLen = rulesMy.length; j < jLen; j++) {
        if (rules[i].toLowerCase().trim().indexOf(rulesMy[j].name) == 0) {
          // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - before: " + rules[i] + "\n");
          ruleRewriteHash = false;
          ruleRewriteNonce = false;
          ruleRewriteNone = false;
          ruleName = rules[i].substring(
              0, rules[i].toLowerCase().indexOf(rulesMy[j].name)
              + rulesMy[j].name.length);
          ruleValue = rules[i].slice(rules[i].toLowerCase()
              .indexOf(rulesMy[j].name) + rulesMy[j].name.length);
          for (var k = 0, kLen = rulesMy[j].value.length; k < kLen; k++) {
            if (rulesMy[j].value[k].override) {
              if (rulesMy[j].value[k].name == gCorsCspOverrideAllAllow) {
                // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - rewrite (" + rulesMy[j].value[k].name + "): " + rulesMy[j].value[k].value + "\n");
                ruleValue = rulesMy[j].value[k].value;
                ruleValues = ruleValue.split(rulesValuesSeparator);
              } else {
                ruleValues = ruleValue.split(rulesValuesSeparator);
                if (rulesMy[j].value[k].name == cspOverrideSourceList) {
                  ruleRewriteNone = true;
                  ruleRewriteValue = "";
                  ruleSourceListValue = rulesMy[j].value[k].value;
                  ruleSourceListValues = ruleSourceListValue.split(
                      rulesValuesSeparator);
                  for (var l = 0, lLen = ruleSourceListValues.length;
                      l < lLen; l++) {
                    ruleSourceListRewriteValue = ruleSourceListValues[l];
                    for (var m = 0, mLen = ruleValues.length;
                        m < mLen; m++) {
                      if (ruleValues[m].toLowerCase().trim()
                          == ruleSourceListValues[l]) {
                        // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - rewrite (" + rulesMy[j].value[k].name + ") - they are identical: " + ruleValues[m].toLowerCase().trim() + " / " + ruleSourceListValues[l] + "\n");
                        ruleSourceListRewriteValue = "";
                        break;
                      }
                    }
                    ruleRewriteValue = (ruleRewriteValue + rulesValuesSeparator
                        + ruleSourceListRewriteValue).trim();
                  }
                } else {
                  for (var l = 0, lLen = rulesMySpec.length;
                      l < lLen; l++) {
                    if (rulesMySpec[l].value == rulesMy[j].value[k].value) {
                      if (rulesMySpec[l].delete.hash) {
                        ruleRewriteHash = true;
                      }
                      if (rulesMySpec[l].delete.nonce) {
                        ruleRewriteNonce = true;
                      }
                      break;
                    }
                  }
                  ruleRewriteNone = true;
                  ruleRewriteValue = rulesMy[j].value[k].value;
                  for (var l = 0, lLen = ruleValues.length;
                      l < lLen; l++) {
                    if (ruleValues[l].toLowerCase().trim()
                        == rulesMy[j].value[k].value) {
                      // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - rewrite (" + rulesMy[j].value[k].name + ") - they are identical: " + ruleValues[l].toLowerCase().trim() + " / " + rulesMy[j].value[k].value + "\n");
                      ruleRewriteValue = "";
                      break;
                    }
                  }
                }
                // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - rewrite (" + rulesMy[j].value[k].name + "): " + ruleRewriteValue + "\n");
                ruleValue = (ruleValue + rulesValuesSeparator
                    + ruleRewriteValue).trim();
                ruleValues = ruleValue.split(rulesValuesSeparator);
              }
              // the empty string => delete this rule
              rules[i] = (
                  (ruleValues.join(rulesValuesSeparator).trim() != "")
                  ? ruleName + rulesValuesSeparator
                    + ruleValues.join(rulesValuesSeparator).trim()
                  : "");
            }
          }
          if (ruleRewriteHash) {
            if (rulesDeleteHashRegex.override
                && rulesDeleteHashRegex.value.test(rules[i])) {
              // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - delete (hash)" + "\n");
              rules[i] = rules[i].replace(rulesDeleteHashRegex.value, "");
            }
          }
          if (ruleRewriteNonce) {
            if (rulesDeleteNonceRegex.override
                && rulesDeleteNonceRegex.value.test(rules[i])) {
              // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - delete (nonce)" + "\n");
              rules[i] = rules[i].replace(rulesDeleteNonceRegex.value, "");
            }
          }
          if (ruleRewriteNone) {
            if (rulesDeleteNoneRegex.override
                && rulesDeleteNoneRegex.value.test(rules[i])) {
              // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - delete (none)" + "\n");
              rules[i] = rules[i].replace(rulesDeleteNoneRegex.value, "");
            }
          }
          // dump(gCorsCspOverrideDumpPrefix + " - csp - rules - my (" + rulesMy[j].name + ") - after: " + rules[i] + "\n");
          break;
        }
      }
    }
  }

  // remove empty strings => array.filter(Boolean)
  return rules.filter(Boolean).join(rulesSeparator).trim();
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

try {
  for (var observer in gCorsCspObservers) {
    Services.obs.addObserver({
      "observe": function (aSubject, aTopic, aData) {
        try {
          corsCspOverride(aSubject, aTopic, aData);
        } catch (e) {
          dump(gCorsCspName + " observer failed:" + "\n" + e + "\n");
        }
      }
    }, gCorsCspObservers[observer].value, false);
  }
} catch (e) {
  try {
    chrome.webRequest[gCorsCspListener.value].addListener(
      corsCspOverride,
      {"urls": ["<all_urls>"]},
      ["responseHeaders", "blocking"]
    );
  } catch (e) {
    dump(gCorsCspName + " listener failed:" + "\n" + e + "\n");
  }
}
