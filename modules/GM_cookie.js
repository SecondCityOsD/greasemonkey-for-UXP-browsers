/**
 * @file GM_cookie.js
 * @overview Native chrome-side GM_cookie / GM.cookie implementation.
 *
 * Exposes three operations on the page's cookies.  Operations default to
 * the script's own page host; cross-domain access is permitted only for
 * hosts the script names explicitly in @connect (see hostAllowed()):
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


// Cross-domain cookie access is gated per script by its @connect list (see
// hostAllowed() in createGMCookieAPI); the page's own host is always
// allowed.  There is no global host-lock constant anymore.

/**
 * The expiry add() is given for a session cookie, which ends with the
 * session anyway (add() needs one, and checks it).  Far off, so it never
 * expires first.
 */
const SESSION_COOKIE_EXPIRY_SEC = Math.pow(2, 52);


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
 * Normalizes a script-supplied sameSite value to the nsICookie sameSite
 * integer (0 = unset/none, 1 = lax, 2 = strict).  Accepts the string forms
 * ("lax" / "strict" / "none") or a number.  Returns null when unspecified,
 * so set() can skip the sameSite argument entirely on builds whose add()
 * signature does not accept it.
 *
 * @param {string|number|undefined} aValue
 * @returns {number|null}
 */
function sameSiteToInt(aValue) {
  if ((aValue === undefined) || (aValue === null) || (aValue === "")) {
    return null;
  }
  if (typeof aValue === "number") {
    return aValue;
  }
  switch (String(aValue).toLowerCase()) {
    case "lax":
      return 1;
    case "strict":
      return 2;
    case "none":
    case "no_restriction":
    case "unspecified":
      return 0;
    default:
      return null;
  }
}

/**
 * A cookie's SameSite as chrome.cookies names it (Violentmonkey and
 * Tampermonkey give these): nsICookie2's 1 / 2 are "lax" / "strict";
 * unset (0, or a build without the field) is "unspecified".
 *
 * @param {number|undefined} aValue
 * @returns {string}
 */
function sameSiteName(aValue) {
  switch (aValue) {
    case 1:
      return "lax";
    case 2:
      return "strict";
    default:
      return "unspecified";
  }
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
 * directly).  The optional callback is invoked as in Violentmonkey and
 * Tampermonkey: list's with (cookies, error), set's and delete's with
 * (error), undefined when there's none; with a callback, errors go to it
 * instead of being thrown (see fail()).  buildGMObject wraps each method
 * in a Promise for the GM4 `await GM.cookie.X(...)` form, without a
 * callback.
 *
 * @param {Window}  aWrappedContentWin - X-ray wrapped content window
 *   (used for Error construction in sandbox scope and originAttributes).
 * @param {Sandbox} aSandbox    - The script's sandbox; result objects
 *                                 are cloned into it before return.
 * @param {string}  aFileURL    - Script file URL (for Error attribution).
 * @param {string}  aPageUrl    - Page URL (used to derive the host scope).
 * @param {string[]} aConnects  - The script's @connect hosts.
 * @param {boolean} aHttpOnlyCookies - The script's own Options-window
 *   choice to reach HTTP-only cookies (see httpOnlyAllowed()).
 * @returns {object} Sandbox-side cookie API object with list/set/delete.
 */
function createGMCookieAPI(
    aWrappedContentWin, aSandbox, aFileURL, aPageUrl, aConnects,
    aHttpOnlyCookies) {
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
  let connects = aConnects || [];

  /**
   * Whether the script may read, set, overwrite or delete HTTP-only
   * cookies, which pages' own JavaScript can't reach (an XSS defence; they
   * often hold the session, finding S13).  Only with both switches on, as
   * in Violentmonkey: the script's Options window and Preferences
   * (api.GM_cookie.exposeHttpOnly, read live).
   *
   * @returns {boolean}
   */
  function httpOnlyAllowed() {
    return !!aHttpOnlyCookies
        && GM_prefRoot.getValue("api.GM_cookie.exposeHttpOnly", false);
  }

  /**
   * Whether the script may touch cookies for aHost.  The page's own host is
   * always allowed.  Cross-domain access is gated by @connect and is
   * deliberately STRICTER than GM_xmlhttpRequest: only hosts named
   * explicitly (exact, subdomain, *.domain, or localhost) qualify --
   * "@connect *" and "@connect self" do NOT grant blanket access to other
   * sites' cookies, since cookies routinely carry credentials.
   *
   * @param {string|null} aHost
   * @returns {boolean}
   */
  function hostAllowed(aHost) {
    let host = sanitizeHost(aHost);
    if (!host) {
      return false;
    }
    if (pageHost && (host === pageHost)) {
      return true;
    }
    for (let i = 0; i < connects.length; i++) {
      let entry = String(connects[i]).toLowerCase();
      if ((entry === "*") || (entry === "self")) {
        continue;
      }
      if (entry === "localhost") {
        if ((host === "localhost") || (host === "127.0.0.1")) {
          return true;
        }
        continue;
      }
      if (entry.startsWith("*.")) {
        let bare = entry.substr(2);
        if ((host === bare) || host.endsWith("." + bare)) {
          return true;
        }
        continue;
      }
      if ((host === entry) || host.endsWith("." + entry)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Resolves the target host for an operation from its details: an explicit
   * .host, .domain (leading dot stripped), or .url field, else the page's
   * own host.  Returns null when a named cross-domain host is not permitted
   * by @connect (callers turn that into a thrown Error).
   *
   * @param {object} aDetails
   * @returns {string|null}
   */
  function resolveHost(aDetails) {
    let want = null;
    if (aDetails) {
      if (aDetails.host) {
        want = sanitizeHost(String(aDetails.host));
      } else if (aDetails.domain) {
        want = sanitizeHost(String(aDetails.domain).replace(/^\./, ""));
      } else if (aDetails.url) {
        want = sanitizeHost(getHostFromUrl(String(aDetails.url)));
      }
    }
    if (!want || (want === pageHost)) {
      return pageHost;
    }
    return hostAllowed(want) ? want : null;
  }

  /**
   * Whether set() may make a domain cookie for aDomain (".example.com",
   * sent to every subdomain): for the page's own host or a host @connect
   * allows, and for a parent domain of the page, as the page's own
   * document.cookie may.  Never for a public suffix ("com", "co.uk",
   * "github.io") or an IP address.
   *
   * @param {string} aDomain - Without the leading dot, lowercase.
   * @returns {boolean}
   */
  function domainCookieAllowed(aDomain) {
    if (!aDomain) {
      return false;
    }
    try {
      if (Services.eTLD.getPublicSuffixFromHost(aDomain) === aDomain) {
        return false;
      }
    } catch (e) {
      // An IP address or a one-label name: no domain cookies.
      return false;
    }
    if ((aDomain === pageHost) || hostAllowed(aDomain)) {
      return true;
    }
    return !!pageHost && pageHost.endsWith("." + aDomain);
  }

  /**
   * Calls a script callback, never letting its throw escape back into the
   * chrome implementation.
   *
   * @param {Function} aCallback
   * @param {Array}    aArgs
   */
  function safeCall(aCallback, aArgs) {
    if (typeof aCallback !== "function") {
      return undefined;
    }
    try {
      aCallback.apply(null, aArgs);
    } catch (e) {
      // Script callback threw; log but don't propagate.
      GM_util.logError(e, false, aFileURL, e.lineNumber || 0);
    }
  }

  /**
   * Reports a failure as Violentmonkey and Tampermonkey do: to the
   * callback when there is one, with (undefined, error) for list and
   * (error) for set and delete; otherwise as a throw, which GM.cookie's
   * promise turns into a rejection.  It used to call the callback with
   * (null, error) and throw as well.
   *
   * @param {Function} aCallback
   * @param {boolean}  aIsList
   * @param {Error}    aError
   * @returns {undefined}
   */
  function fail(aCallback, aIsList, aError) {
    if (typeof aCallback !== "function") {
      throw aError;
    }
    safeCall(aCallback, aIsList ? [undefined, aError] : [aError]);
    return undefined;
  }

  /**
   * @param {string} aCookiePath  - A cookie's path.
   * @param {string} aRequestPath - A URL's path.
   * @returns {boolean} Whether a request to aRequestPath gets the cookie
   *   (RFC 6265 path-match).
   */
  function pathMatches(aCookiePath, aRequestPath) {
    if (aCookiePath === aRequestPath) {
      return true;
    }
    return aRequestPath.startsWith(aCookiePath)
        && (aCookiePath.endsWith("/")
            || (aRequestPath.charAt(aCookiePath.length) === "/"));
  }

  /**
   * GM_cookie.list(filter, callback)
   *
   * Returns an array of cookie records (cloned into the sandbox).  The
   * target host defaults to the page's own host; a filter.domain /
   * filter.url / filter.host naming a different host is honored only when
   * that host is permitted by the script's @connect.  As chrome.cookies
   * does (Violentmonkey, Tampermonkey), filter.name and filter.path pick
   * cookies with exactly that name / path, filter.secure and
   * filter.session by those flags, and filter.url only the cookies a
   * request to it would send.  The optional callback is invoked with
   * (cookies, undefined) or (undefined, error).
   *
   * Each record has the chrome.cookies fields (domain, expirationDate,
   * hostOnly, httpOnly, name, path, sameSite, secure, session, value) and,
   * as before, Gecko's own (host, isDomain, isHttpOnly, ...).
   */
  function listImpl(aFilter, aCallback) {
    let filter = (aFilter && (typeof aFilter === "object")) ? aFilter : {};
    let host = resolveHost(filter);
    if (host === null) {
      return fail(aCallback, true, new aWrappedContentWin.Error(
          "GM_cookie.list: cross-domain access to that host is not "
          + "permitted by the script's @connect.", aFileURL, null));
    }
    let byUrl = null;
    if (filter.url) {
      try {
        byUrl = new URL(String(filter.url));
      } catch (e) {
        byUrl = null;
      }
    }
    // Without leave to reach HTTP-only cookies, the list leaves them out,
    // as Violentmonkey's does.
    let allowed = httpOnlyAllowed();
    let raw = listCookiesForHost(aWrappedContentWin, host)
        .filter(function (aCookie) {
          if (!allowed && aCookie.isHttpOnly) {
            return false;
          }
          if ((filter.name != null) && (aCookie.name !== String(filter.name))) {
            return false;
          }
          if ((filter.path != null) && (aCookie.path !== String(filter.path))) {
            return false;
          }
          if ((typeof filter.secure === "boolean")
              && (aCookie.isSecure !== filter.secure)) {
            return false;
          }
          if ((typeof filter.session === "boolean")
              && (aCookie.isSession !== filter.session)) {
            return false;
          }
          if (byUrl && (!pathMatches(aCookie.path, byUrl.pathname)
              || (aCookie.isSecure && (byUrl.protocol !== "https:")))) {
            return false;
          }
          return true;
        });
    let cookies = raw.map(function (aCookie) {
      return {
        // chrome.cookies, as Violentmonkey and Tampermonkey give them.
        "domain":         aCookie.host,
        "expirationDate": aCookie.isSession ? undefined : aCookie.expiry,
        "hostOnly":       !aCookie.isDomain,
        "httpOnly":       aCookie.isHttpOnly,
        "name":           aCookie.name,
        "path":           aCookie.path,
        "sameSite":       sameSiteName(aCookie.sameSite),
        "secure":         aCookie.isSecure,
        "session":        aCookie.isSession,
        "value":          aCookie.value,
        // Gecko's own (nsICookie2), as before.
        "creationTime": aCookie.creationTime,
        "expires":      aCookie.expires,
        "expiry":       aCookie.expiry,
        "host":         aCookie.host,
        "isDomain":     aCookie.isDomain,
        "isHttpOnly":   aCookie.isHttpOnly,
        "isSecure":     aCookie.isSecure,
        "isSession":    aCookie.isSession,
        "lastAccessed": aCookie.lastAccessed,
        "policy":       aCookie.policy,
        "rawHost":      aCookie.rawHost,
        "status":       aCookie.status,
      };
    });
    let cloned = Cu.cloneInto(cookies, aSandbox);
    safeCall(aCallback, [cloned, undefined]);
    return cloned;
  }

  /**
   * @param {string} aFunction - "set" or "delete".
   * @param {string} aKey      - The greasemonkey.properties key.
   * @param {*}      aValue    - What the script gave.
   * @returns {Error} A sandbox Error for a bad argument.
   */
  function argumentError(aFunction, aKey, aValue) {
    return new aWrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName(aKey)
              .replace("%1", aFunction)
              .replace("%2", typeof aValue),
        aFileURL, null);
  }

  /**
   * GM_cookie.set(details, callback)
   *
   * Creates or updates a cookie, as chrome.cookies.set does (Violentmonkey,
   * Tampermonkey).  details fields:
   *   name (required), value (required; "" is a value), path ("/"),
   *   domain (a domain cookie, sent to subdomains too; see
   *   domainCookieAllowed), url / host (whose host-only cookie; default the
   *   page's), secure, httpOnly, expirationDate / expiration (seconds since
   *   epoch; without one the cookie lasts for the session, as in
   *   chrome.cookies, not until 2038), session (overrides that),
   *   sameSite ("lax" / "strict" / "none" or 0/1/2; applied when the
   *   platform's cookie add() accepts it, otherwise ignored).
   * Callback receives (undefined) on success or (error) on failure; without
   * one, returns true or throws.
   */
  function setImpl(aDetails, aCallback) {
    if (!aDetails || typeof aDetails !== "object") {
      return fail(aCallback, false,
          argumentError("set", "error.cookie.argument", aDetails));
    }

    let host;
    let cookieHost;
    if (aDetails.domain) {
      let domain = String(aDetails.domain).trim().toLowerCase()
          .replace(/^\./, "");
      if (!domainCookieAllowed(domain)) {
        return fail(aCallback, false, new aWrappedContentWin.Error(
            "GM_cookie.set: a cookie for the domain " + domain + " needs "
            + "the page to be on it, or @connect to name it.",
            aFileURL, null));
      }
      host = domain;
      cookieHost = "." + domain;
    } else {
      host = resolveHost(aDetails);
      cookieHost = host;
    }
    if (host === null) {
      return fail(aCallback, false, new aWrappedContentWin.Error(
          "GM_cookie.set: cross-domain access to that host is not "
          + "permitted by the script's @connect.", aFileURL, null));
    }
    let path     = aDetails.path ? String(aDetails.path) : "/";
    let name     = (aDetails.name == null) ? undefined : String(aDetails.name);
    let value    = (aDetails.value == null)
        ? undefined : String(aDetails.value);
    let secure   = !!aDetails.secure;
    let httpOnly = !!aDetails.httpOnly;
    let expiresAt = (aDetails.expirationDate != null)
        ? aDetails.expirationDate : aDetails.expiration;
    let session  = (aDetails.session != null)
        ? !!aDetails.session : (expiresAt == null);
    let expiry   = (!session && (expiresAt != null))
        ? Math.floor(Number(expiresAt)) : SESSION_COOKIE_EXPIRY_SEC;

    if (typeof name === "undefined") {
      return fail(aCallback, false,
          argumentError("set", "error.cookie.argument.name", name));
    }
    if (typeof value === "undefined") {
      return fail(aCallback, false,
          argumentError("set", "error.cookie.argument.value", value));
    }

    // An HTTP-only cookie, new or one this would overwrite, needs leave.
    if (!httpOnlyAllowed() && (httpOnly
        || listCookiesForHost(aWrappedContentWin, host).some(function (aC) {
          return aC.isHttpOnly && (aC.host === cookieHost)
              && (aC.name === name) && (aC.path === path);
        }))) {
      return fail(aCallback, false, new aWrappedContentWin.Error(
          "GM_cookie.set: HTTP-only cookies need both Greasemonkey "
          + "Preferences and this script's Options window to allow them.",
          aFileURL, null));
    }

    let sameSite = sameSiteToInt(aDetails.sameSite);
    try {
      let oa = aWrappedContentWin.document.nodePrincipal.originAttributes;
      let added = false;
      // Newer nsICookieManager2.add() signatures take sameSite after the
      // originAttributes argument.  Try that first when the script asked
      // for a sameSite, and fall back to the classic 9-arg form if this
      // build's add() rejects the extra argument (the cookie is still set,
      // just without the SameSite flag).
      if (sameSite !== null) {
        try {
          cookiesService.add(
              cookieHost, path, name, value,
              secure, httpOnly, session, expiry, oa, sameSite);
          added = true;
        } catch (eSameSite) {
          added = false;
        }
      }
      if (!added) {
        cookiesService.add(
            cookieHost, path, name, value,
            secure, httpOnly, session, expiry, oa);
      }
    } catch (e) {
      return fail(aCallback, false, new aWrappedContentWin.Error(
          "GM_cookie.set: " + e.message, aFileURL, null));
    }
    safeCall(aCallback, [undefined]);
    return true;
  }

  /**
   * GM_cookie.delete(details, callback)
   *
   * Removes one or more cookies matching details.name (and optional .path).
   * Defaults to the page's own host; a details.domain / .url / .host naming
   * a different host is honored only when permitted by @connect.  Callback
   * receives (undefined) on success or (error) on failure; without one,
   * returns the number of cookies removed or throws.
   */
  function deleteImpl(aDetails, aCallback) {
    let name = (aDetails && (aDetails.name != null))
        ? String(aDetails.name) : undefined;
    let path = (aDetails && aDetails.path) ? String(aDetails.path) : undefined;

    if (typeof name === "undefined") {
      return fail(aCallback, false,
          argumentError("delete", "error.cookie.argument.name", name));
    }

    let host = resolveHost(aDetails);
    if (host === null) {
      return fail(aCallback, false, new aWrappedContentWin.Error(
          "GM_cookie.delete: cross-domain access to that host is not "
          + "permitted by the script's @connect.", aFileURL, null));
    }

    let count = 0;
    // HTTP-only cookies are left alone without leave (not counted).
    let allowed = httpOnlyAllowed();
    try {
      let raw = listCookiesForHost(aWrappedContentWin, host);
      for (let i = 0; i < raw.length; i++) {
        let cookie = raw[i];
        if (cookie.name !== name) continue;
        if (path && cookie.path !== path) continue;
        if (cookie.isHttpOnly && !allowed) continue;
        cookiesService.remove(
            cookie.host, cookie.name, cookie.path, false,
            cookie.originAttributes);
        count++;
      }
    } catch (e) {
      return fail(aCallback, false, new aWrappedContentWin.Error(
          "GM_cookie.delete: " + e.message, aFileURL, null));
    }
    safeCall(aCallback, [undefined]);
    return count;
  }

  // Build the sandbox-side object and export each method.
  let cookieObj = Cu.createObjectIn(aSandbox);
  Cu.exportFunction(listImpl,   cookieObj, { "defineAs": "list" });
  Cu.exportFunction(setImpl,    cookieObj, { "defineAs": "set" });
  Cu.exportFunction(deleteImpl, cookieObj, { "defineAs": "delete" });
  return cookieObj;
};
