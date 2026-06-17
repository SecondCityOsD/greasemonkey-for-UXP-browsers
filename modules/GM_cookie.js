/**
 * @file GM_cookie.js
 * @overview Native chrome-side GM_cookie / GM.cookie implementation.
 *
 * Exposes three operations on the page's cookies, scoped to the script's
 * page host (CURRENT_HOST_ONLY):
 *
 *   GM_cookie.list({}, callback)        — synchronous result + optional callback
 *   GM_cookie.set(details, callback)
 *   GM_cookie.delete(details, callback)
 *
 *   await GM.cookie.list({})            — Promise wrapper added by buildGMObject
 *   await GM.cookie.set(details)
 *   await GM.cookie.delete(details)
 *
 * The factory createGMCookieAPI() returns a sandbox-side object with the
 * three methods, each chrome-implemented and exported via Cu.exportFunction.
 *
 * The .list / .set / .delete object shape matches Tampermonkey, Violent-
 * monkey, and modern Greasemonkey 4, and lets buildGMObject's GM4 wrapping
 * apply uniformly.  UXP browsers (Pale Moon ≥28, Basilisk) always support
 * the modern nsICookieManager2.getCookiesFromHost / add signatures used
 * below, so no version-fallback path is required.
 */

const EXPORTED_SYMBOLS = ["createGMCookieAPI"];

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
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


/**
 * Security default: every operation is scoped to the page's own host.
 * Setting/deleting cookies on third-party domains is gated off; flip
 * this only after a real audit of the implications.
 */
const CURRENT_HOST_ONLY = true;

/**
 * Default expiration for set() when no `expirationDate` / `expiration` is
 * supplied.  2038-01-17 is just before the Unix-time-2^31 cliff.
 */
const DEFAULT_EXPIRATION_SEC = Date.parse("Jan 17, 2038") / 1000;


/**
 * Extracts the host portion of a URL string, or null on malformed input.
 *
 * @param {string} aUrl
 * @returns {string|null}
 */
function getHostFromUrl(aUrl) {
  try {
    return new URL(aUrl).host;
  } catch (e) {
    return null;
  }
}

/**
 * Strips a port suffix (":1234") off a host string, leaving the bare hostname.
 * Returns null for empty / null inputs so callers can short-circuit cleanly.
 *
 * @param {string|null} aHost
 * @returns {string|null}
 */
function sanitizeHost(aHost) {
  if (!aHost) {
    return null;
  }
  return aHost.split(":")[0];
}

/**
 * Tests whether an nsICookie2 record applies to a given page host.
 * Mirrors the matching the platform performs internally:
 *   - dot-prefixed cookie host ".example.com" matches sub.example.com
 *   - empty cookie host applies to the same file:// path
 *   - everything else requires exact host equality
 *
 * @param {nsICookie2} aCookie
 * @param {string|null} aHost
 * @returns {boolean}
 */
function isCookieAtHost(aCookie, aHost) {
  if (aCookie.host == null) {
    return aHost == null;
  }
  if (aCookie.host.startsWith(".")) {
    return ("." + aHost).endsWith(aCookie.host);
  }
  if (aCookie.host === "") {
    return aHost && aHost.startsWith("file://" + aCookie.path);
  }
  return aCookie.host === aHost;
}

/**
 * Iterates every cookie scoped to aHost, respecting the page document's
 * originAttributes (private browsing, container tabs).  Returns an array
 * of nsICookie2 records that pass isCookieAtHost.
 *
 * @param {nsIDOMWindow} aContentWin - The page's content window.
 * @param {string} aHost
 * @returns {Array<nsICookie2>}
 */
function listCookiesForHost(aContentWin, aHost) {
  let cookiesService = Services.cookies;
  let originAttributes = aContentWin.document.nodePrincipal.originAttributes;
  let enm = cookiesService.getCookiesFromHost(aHost, originAttributes);
  let out = [];
  while (enm.hasMoreElements()) {
    let cookie = enm.getNext().QueryInterface(Ci.nsICookie2);
    if (isCookieAtHost(cookie, aHost)) {
      out.push(cookie);
    }
  }
  return out;
}


/**
 * Builds the script-facing GM_cookie API object.  Called from sandbox.js
 * once per sandbox; returns a sandbox-side object with `list` / `set` /
 * `delete` methods exported via Cu.exportFunction.
 *
 * Each method is synchronous from the chrome side (returns the result
 * directly).  The optional callback (TM/VM-style) is invoked with
 * (result, errorOrNull).  buildGMObject wraps each method in a Promise
 * for the GM4 `await GM.cookie.X(...)` form.
 *
 * @param {Window}  aWrappedContentWin - X-ray wrapped content window
 *   (used for Error construction in sandbox scope and originAttributes).
 * @param {Sandbox} aSandbox    - The script's sandbox; result objects
 *                                 are cloned into it before return.
 * @param {string}  aFileURL    - Script file URL (for Error attribution).
 * @param {string}  aPageUrl    - Page URL (used to derive the host scope).
 * @returns {object} Sandbox-side cookie API object with list/set/delete.
 */
function createGMCookieAPI(
    aWrappedContentWin, aSandbox, aFileURL, aPageUrl) {
  let cookiesService;
  try {
    cookiesService = Services.cookies;
  } catch (e) {
    // Cookies service unavailable — return an object whose methods
    // throw a sandbox-scoped Error when called.  Better than refusing
    // to attach the API at all (which would mask the failure).
    let unsupported = function () {
      throw new aWrappedContentWin.Error(
          "GM_cookie: "
          + GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.environment.unsupported.e10s"),
          aFileURL, null);
    };
    let stub = Cu.createObjectIn(aSandbox);
    Cu.exportFunction(unsupported, stub, { "defineAs": "list" });
    Cu.exportFunction(unsupported, stub, { "defineAs": "set" });
    Cu.exportFunction(unsupported, stub, { "defineAs": "delete" });
    return stub;
  }

  let pageHost = sanitizeHost(getHostFromUrl(aPageUrl));

  /**
   * Resolves a callback safely — never lets a script-side throw escape
   * back into the chrome implementation.
   */
  function safeCall(aCallback, aResult, aError) {
    if (typeof aCallback !== "function") {
      return undefined;
    }
    try {
      aCallback(aResult, aError);
    } catch (e) {
      // Script callback threw; log but don't propagate.
      GM_util.logError(e, false, aFileURL, e.lineNumber || 0);
    }
  }

  /**
   * GM_cookie.list(filter, callback)
   *
   * Returns an array of cookie records (cloned into the sandbox) for the
   * page's current host.  filter is currently ignored beyond the default
   * host-scope (CURRENT_HOST_ONLY).  The optional callback is invoked
   * with (cookies, null).
   */
  function listImpl(aFilter, aCallback) {
    let raw = listCookiesForHost(aWrappedContentWin, pageHost);
    // HttpOnly cookies are deliberately hidden from page JavaScript (an
    // XSS defense).  GM_cookie runs with elevated privilege and CAN read
    // them (matching Tampermonkey), but that exposes session-cookie VALUES
    // to any script granted GM_cookie (finding S13).  When the pref
    // api.GM_cookie.exposeHttpOnly is false, the cookie metadata is still
    // returned but the secret value is redacted.
    let exposeHttpOnly = GM_prefRoot.getValue(
        "api.GM_cookie.exposeHttpOnly", true);
    let cookies = raw.map(function (aCookie) {
      let redact = aCookie.isHttpOnly && !exposeHttpOnly;
      return {
        "creationTime": aCookie.creationTime,
        "expires":      aCookie.expires,
        "expiry":       aCookie.expiry,
        "host":         aCookie.host,
        "isDomain":     aCookie.isDomain,
        "isHttpOnly":   aCookie.isHttpOnly,
        "isSecure":     aCookie.isSecure,
        "isSession":    aCookie.isSession,
        "lastAccessed": aCookie.lastAccessed,
        "name":         aCookie.name,
        "path":         aCookie.path,
        "policy":       aCookie.policy,
        "rawHost":      aCookie.rawHost,
        "sameSite":     aCookie.sameSite,
        "status":       aCookie.status,
        "value":        redact ? "" : aCookie.value,
      };
    });
    let cloned = Cu.cloneInto(cookies, aSandbox);
    safeCall(aCallback, cloned, null);
    return cloned;
  }

  /**
   * GM_cookie.set(details, callback)
   *
   * Creates or updates a cookie on the page's current host.  details
   * fields:
   *   name (required), value (required), path, secure, httpOnly,
   *   session, expiration / expirationDate (seconds since epoch),
   *   sameSite (currently captured but not forwarded — see comment).
   * Callback receives (true, null) on success or (null, error) on failure.
   */
  function setImpl(aDetails, aCallback) {
    if (!aDetails || typeof aDetails !== "object") {
      let err = new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.cookie.argument")
                .replace("%1", "set")
                .replace("%2", typeof aDetails),
          aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }

    let host = pageHost;
    if (!CURRENT_HOST_ONLY && aDetails.domain) {
      host = "." + String(aDetails.domain);
    }
    let path     = aDetails.path     ? String(aDetails.path)  : "/";
    let name     = aDetails.name     ? String(aDetails.name)  : undefined;
    let value    = aDetails.value    ? String(aDetails.value) : undefined;
    let secure   = !!aDetails.secure;
    let httpOnly = !!aDetails.httpOnly;
    let session  = !!aDetails.session;
    let expiry   = aDetails.expirationDate
        ? Number(aDetails.expirationDate)
        : (aDetails.expiration
            ? Number(aDetails.expiration)
            : DEFAULT_EXPIRATION_SEC);

    if (typeof name === "undefined") {
      let err = new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.cookie.argument.name")
                .replace("%1", "set")
                .replace("%2", typeof name),
          aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }
    if (typeof value === "undefined") {
      let err = new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.cookie.argument.value")
                .replace("%1", "set")
                .replace("%2", typeof value),
          aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }

    try {
      // sameSite is captured into details above for forward-compat but
      // is not forwarded here — UXP's nsICookieManager2.add signature
      // varies by version on the trailing arg.  Adding it can be done
      // in a follow-up without breaking callers.
      cookiesService.add(
          host, path, name, value,
          secure, httpOnly, session, expiry,
          aWrappedContentWin.document.nodePrincipal.originAttributes);
      safeCall(aCallback, true, null);
      return true;
    } catch (e) {
      let err = new aWrappedContentWin.Error(
          'GM_cookie.set: ' + e.message, aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }
  }

  /**
   * GM_cookie.delete(details, callback)
   *
   * Removes one or more cookies matching details.name (and optional .path)
   * on the page's current host.  Callback receives (count, null) where
   * count is the number of cookies actually removed.
   */
  function deleteImpl(aDetails, aCallback) {
    let name = (aDetails && aDetails.name) ? String(aDetails.name) : undefined;
    let path = (aDetails && aDetails.path) ? String(aDetails.path) : undefined;

    if (typeof name === "undefined") {
      let err = new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.cookie.argument.name")
                .replace("%1", "delete")
                .replace("%2", typeof name),
          aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }

    let count = 0;
    try {
      let raw = listCookiesForHost(aWrappedContentWin, pageHost);
      for (let i = 0; i < raw.length; i++) {
        let cookie = raw[i];
        if (cookie.name !== name) continue;
        if (path && cookie.path !== path) continue;
        cookiesService.remove(
            cookie.host, cookie.name, cookie.path, false,
            cookie.originAttributes);
        count++;
      }
    } catch (e) {
      let err = new aWrappedContentWin.Error(
          'GM_cookie.delete: ' + e.message, aFileURL, null);
      safeCall(aCallback, null, err);
      throw err;
    }
    safeCall(aCallback, count, null);
    return count;
  }

  // Build the sandbox-side object and export each method.
  let cookieObj = Cu.createObjectIn(aSandbox);
  Cu.exportFunction(listImpl,   cookieObj, { "defineAs": "list" });
  Cu.exportFunction(setImpl,    cookieObj, { "defineAs": "set" });
  Cu.exportFunction(deleteImpl, cookieObj, { "defineAs": "delete" });
  return cookieObj;
};
