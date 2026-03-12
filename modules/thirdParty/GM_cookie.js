/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

"use strict";

const EXPORTED_SYMBOLS = ["GM_cookie"];

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

Cu.importGlobalProperties(["URL"]);

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


const CURRENT_HOST_ONLY = true;

function getHostFromUrl(aUrl) {
  try {
    return new URL(aUrl).host;
  } catch (e) {
    return null;
  }
}

function getSanitizeHost(aHost) {
  if ((aHost == null) || (aHost == "")) {
    return null;
  }

  return aHost.split(":")[0];
}

function isCookieAtHost(aCookie, aHost) {
  if (aCookie.host == null) {
    return aHost == null;
  }
  if (aCookie.host.startsWith(".")) {
    return ("." + aHost).endsWith(aCookie.host);
  }
  if (aCookie.host === "") {
    return aHost.startsWith("file://" + aCookie.path);
  }

  return aCookie.host == aHost;
}

/**
 * Implements the GM_cookie API (list, set, delete) for scripts running in the sandbox.
 * Dispatches to internal _list, _set, or _delete helpers based on aWhat.
 * @param {object} aWrappedContentWin - The wrapped content window (used to construct Error objects in sandbox scope).
 * @param {object} aSandbox - The script sandbox (used to clone returned cookie objects into).
 * @param {string} aFileURL - The script file URL, used as the source location in thrown errors.
 * @param {string} aUrl - The page URL from which the host is extracted for cookie scope.
 * @param {string} aWhat - The operation: "list", "set", or "delete".
 * @param {object} [aDetails] - Operation-specific options (host, name, value, path, etc.).
 * @returns {Array|boolean|number} For "list": a sandbox-cloned cookie array; for "set": true on success;
 *   for "delete": the count of deleted cookies.
 * @throws {Error} If the cookies service is unavailable, aWhat is unsupported, or required details are missing.
 */
function GM_cookie(
    aWrappedContentWin, aSandbox, aFileURL, aUrl, aWhat, aDetails) {
  let what = aWhat.toLowerCase();

  var cookiesService = null;
  try {
    // http://bugzil.la/1221488
    cookiesService = Services.cookies;
  } catch (e) {
    throw new aWrappedContentWin.Error(
        'GM_cookie("' + what + '"): '
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.environment.unsupported.e10s"),
        aFileURL, null);
  }

  let host = getHostFromUrl(aUrl);
  // let sandboxPrincipal = Cu.getObjectPrincipal(aSandbox);
  let sanitizeHost = getSanitizeHost(host);

  function _delete(aWhat, aWrappedContentWin, aFileURL, aHost, aDetails) {
    let details = {
      "host": aHost,
      "name": undefined,
      "path": undefined,
    };

    if (typeof aDetails == "object") {
      if (!CURRENT_HOST_ONLY) {
        details.host = aDetails.host ? String(aDetails.host) : details.host;
      }
      details.name = aDetails.name ? String(aDetails.name) : details.name;
      details.path = aDetails.path ? String(aDetails.path) : details.path;
    }

    if (typeof details.name == "undefined") {
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.cookie.argument.name")
              .replace("%1", aWhat)
              .replace("%2", typeof details.name),
          aFileURL, null);
    }

    let result = 0;

    let enm;
    // Firefox 49+
    // http://bugzil.la/1267910
    try {
      let { originAttributes } = aWrappedContentWin.document.nodePrincipal;
      enm = cookiesService.getCookiesFromHost(details.host, originAttributes);
    } catch (e) {
      enm = cookiesService.getCookiesFromHost(details.host);
    }

    while (enm.hasMoreElements()) {
      let cookie = enm.getNext().QueryInterface(Ci.nsICookie2);
      if (isCookieAtHost(cookie, details.host)) {
        if ((cookie.name == details.name)
            && (!details.path || (cookie.path == details.path))) {
          try {
            // Firefox 49+
            // http://bugzil.la/1267910
            try {
              cookiesService.remove(
                  cookie.host, cookie.name, cookie.path, false,
                  cookie.originAttributes);
            } catch (e) {
              cookiesService.remove(
                  cookie.host, cookie.name, cookie.path, false);
            }
          } catch (e) {
            throw new aWrappedContentWin.Error(
                'GM_cookie("' + aWhat + '"):'
                + "\n" + e.message,
                aFileURL, null);
          }
          result++;
        }
      }
    }

    return result;
  }

  function _list(aWhat, aWrappedContentWin, aSandbox, aHost, aDetails) {
    let details = {
      "host": aHost,
    };

    if (typeof aDetails == "object") {
      if (!CURRENT_HOST_ONLY) {
        details.host = aDetails.host ? String(aDetails.host) : details.host;
      }
    }

    let enm;
    // Firefox 49+
    // http://bugzil.la/1267910
    try {
      let { originAttributes } = aWrappedContentWin.document.nodePrincipal;
      enm = cookiesService.getCookiesFromHost(details.host, originAttributes);
    } catch (e) {
      enm = cookiesService.getCookiesFromHost(details.host);
    }

    let cookies = [];
    while (enm.hasMoreElements()) {
      let cookie = enm.getNext().QueryInterface(Ci.nsICookie2);
      if (isCookieAtHost(cookie, details.host)) {
        cookies.push({
          "creationTime": cookie.creationTime,
          "expires": cookie.expires,
          "expiry": cookie.expiry,
          "host": cookie.host,
          "isDomain": cookie.isDomain,
          "isHttpOnly": cookie.isHttpOnly,
          "isSecure": cookie.isSecure,
          "isSession": cookie.isSession,
          "lastAccessed": cookie.lastAccessed,
          "name": cookie.name,
          "path": cookie.path,
          "policy": cookie.policy,
          "rawHost": cookie.rawHost,
          "sameSite": cookie.sameSite,
          "status": cookie.status,
          "value": cookie.value,
        });
      }
    }

    return Cu.cloneInto(cookies, aSandbox);
  }

  function _set(aWhat, aWrappedContentWin, aFileURL, aHost, aDetails) {
    let details = {
      "domain": aHost,
      "name": undefined,
      "value": undefined,
    };

    if (typeof aDetails == "object") {
      if (!CURRENT_HOST_ONLY) {
        details.domain = aDetails.domain
            ? "." + String(aDetails.domain)
            : details.domain;
      }
      details.path = aDetails.path ? String(aDetails.path) : "/";
      details.name = aDetails.name ? String(aDetails.name) : details.name;
      details.value = aDetails.value ? String(aDetails.value) : details.value;
      details.secure = !!aDetails.secure;
      details.httpOnly = !!aDetails.httpOnly;
      details.session = !!aDetails.session;
      details.expiration = aDetails.expiration
          ? Number(aDetails.expiration)
          : Date.parse("Jan 17, 2038") / 1000;
      details.sameSite = aDetails.sameSite ? String(aDetails.sameSite) : null;
    } else {
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.cookie.argument")
              .replace("%1", aWhat)
              .replace("%2", typeof aDetails),
          aFileURL, null);
    }

    if (typeof details.name == "undefined") {
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.cookie.argument.name")
              .replace("%1", aWhat)
              .replace("%2", typeof details.name),
          aFileURL, null);
    }
    if (typeof details.value == "undefined") {
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.cookie.argument.value")
              .replace("%1", aWhat)
              .replace("%2", typeof details.value),
          aFileURL, null);
    }

    try {
      // Firefox 49+
      // http://bugzil.la/1267910
      try {
        cookiesService.add(
            details.domain,
            details.path,
            details.name,
            details.value,
            details.secure,
            details.httpOnly,
            details.session,
            details.expiration,
            aWrappedContentWin.document.nodePrincipal.originAttributes);
            /*
            aWrappedContentWin.document.nodePrincipal.originAttributes,
            details.sameSite);
            */
      } catch (e) {
        cookiesService.add(
            details.domain,
            details.path,
            details.name,
            details.value,
            details.secure,
            details.httpOnly,
            details.session,
            details.expiration);
            /*
            details.expiration,
            details.sameSite);
            */
      }

      return true;
    } catch (e) {
      throw new aWrappedContentWin.Error(
          'GM_cookie("' + aWhat + '"):'
          + "\n" + e.message,
          aFileURL, null);
    }
  }

  switch (what) {
    case "delete":
      return _delete(
          what, aWrappedContentWin, aFileURL, sanitizeHost,
          aDetails);
      // break;
    case "list":
      return _list(
          what, aWrappedContentWin, aSandbox, sanitizeHost,
          aDetails);
      // break;
    case "set":
      return _set(
          what, aWrappedContentWin, aFileURL, sanitizeHost,
          aDetails);                          
      // break;
    default:
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.cookie.unsupportedType")
              .replace("%1", aWhat),
          aFileURL, null);
      break;
  }
};
