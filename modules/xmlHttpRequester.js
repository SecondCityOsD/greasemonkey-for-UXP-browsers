/**
 * @file xmlHttpRequester.js
 * @overview Implements GM_xmlhttpRequest() — the cross-domain HTTP request API
 *   for userscripts.
 *
 * Security model:
 *   - URL scheme must be one of: blob, data, ftp, http, https.
 *     All other schemes (file://, chrome://, etc.) are rejected to prevent
 *     scripts from reading local files or chrome resources.
 *   - Callbacks read from the script-supplied details object are Xray-waived
 *     and then verified against the sandbox principal to ensure they came from
 *     the script and not from the page.
 *   - Callbacks are always invoked via XPCNativeWrapper + setTimeout(…, 0)
 *     to prevent privilege escalation through a replaced window.setTimeout.
 *
 * Supported details properties (mirrors GM4 spec):
 *   url, method, headers, data, binary, overrideMimeType, responseType,
 *   timeout, synchronous, mozAnon/anonymous, mozBackgroundRequest,
 *   redirectionLimit, upload (with its own event callbacks), context,
 *   onabort, onerror, onload, onloadend, onloadstart, onprogress,
 *   onreadystatechange, ontimeout.
 *
 * Private browsing / container tabs are respected: the request channel
 * inherits the content window's privacy mode and userContextId.
 *
 * Notes:
 *   - Per-request cookies (aDetails.cookies) are sent verbatim as a Cookie
 *     request header for this one request; the destination is already
 *     @connect-gated and the browser cookie store is not modified.
 *   - Basic-Auth uses aDetails.user / aDetails.password (passed to open())
 *     or a script-supplied Authorization header; no browser-wide auth cache
 *     is touched.
 *   - The minimum supported platform is Pale Moon 28+ / Basilisk current.
 *     The mozAnon constructor option is honoured directly, so no
 *     LOAD_ANONYMOUS channel-flag fallback is needed.
 */

const EXPORTED_SYMBOLS = ["GM_xmlHttpRequester"];

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

Cu.importGlobalProperties(["Blob"]);
Cu.importGlobalProperties(["XMLHttpRequest"]);

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


/** The schemes a request (and each of its redirects) may use.  Anything
 *  else (file:, chrome:...) would let a script read local files. */
const REQUEST_SCHEMES = ["blob", "data", "ftp", "http", "https"];

/** Per request (XMLHttpRequest), its response as a document of the page;
 *  see responseDocument(). */
var gResponseDocuments = new WeakMap();


/**
 * Per-request helper that bridges the content security context (script) and
 * the chrome security context (where cross-domain XHR is allowed).
 *
 * @constructor
 * @param {Window}  aWrappedContentWin - X-ray wrapped content window.
 *   Used as the context for Error objects and setTimeout.
 * @param {Sandbox} aSandbox           - Script's sandbox; response state is
 *   cloned into this before being passed to callbacks.
 * @param {string}  aFileURL           - Script file URL (for Error objects).
 * @param {string}  aOriginUrl         - Page URL; used to resolve relative
 *   URLs in aDetails.url.
 * @param {Array}   [aConnects]        - @connect whitelist from the script's
 *   metadata.  If empty/absent, only same-origin requests are allowed.
 *   "*" allows all hosts; "self" explicitly allows same-origin.
 */
function GM_xmlHttpRequester(
    aWrappedContentWin, aSandbox, aFileURL, aOriginUrl, aConnects) {
  this.connects = aConnects || [];
  this.fileURL = aFileURL;
  this.originUrl = aOriginUrl;
  this.sandbox = aSandbox;
  this.sandboxPrincipal = Cu.getObjectPrincipal(aSandbox);
  this.wrappedContentWin = aWrappedContentWin;
}

/**
 * A request host as compared with @connect entries: lowercase, without
 * IPv6 brackets or trailing dots ("localhost." is localhost).
 *
 * @param {string} aHost - nsIURI.host or a @connect entry.
 * @returns {string}
 */
function normalizeHost(aHost) {
  let host = String(aHost || "").trim().toLowerCase();
  if ((host.charAt(0) == "[") && (host.charAt(host.length - 1) == "]")) {
    host = host.substring(1, host.length - 1);
  }
  return host.replace(/\.+$/, "");
}

/**
 * Reads an IPv4 address the way URL parsers do: one to four parts, each
 * decimal, 0x hex or 0-led octal, the last one filling the remaining
 * bytes.  "127.1", "2130706433", "0x7f000001" and "0177.0.0.1" are all
 * 127.0.0.1, and a check of dotted quads alone let them through.
 *
 * @param {string} aHost - A normalized host.
 * @returns {?number[]} Its four bytes, or null when it isn't an address.
 */
function parseIPv4(aHost) {
  let parts = aHost.split(".");
  if (parts.length > 4) {
    return null;
  }
  let numbers = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i];
    if (/^0x[0-9a-f]*$/i.test(part)) {
      numbers.push((part.length == 2) ? 0 : parseInt(part.substring(2), 16));
    } else if (/^0[0-7]+$/.test(part)) {
      numbers.push(parseInt(part, 8));
    } else if (/^(?:0|[1-9][0-9]*)$/.test(part)) {
      numbers.push(parseInt(part, 10));
    } else {
      return null;
    }
  }
  let last = numbers.pop();
  if (numbers.some(function (aNumber) { return aNumber > 255; })
      || (last >= Math.pow(256, 4 - numbers.length))) {
    return null;
  }
  let tail = [];
  for (let i = 4 - numbers.length; i > 0; i--) {
    tail.unshift(last % 256);
    last = Math.floor(last / 256);
  }
  return numbers.concat(tail);
}

/**
 * Reads an IPv6 address, "::" shorthand and a dotted IPv4 tail included.
 *
 * @param {string} aHost - A normalized host (no brackets).
 * @returns {?number[]} Its eight 16-bit groups, or null.
 */
function parseIPv6(aHost) {
  let host = aHost.replace(/%.*$/, "");
  if (host.indexOf(":") == -1) {
    return null;
  }
  let ipv4 = null;
  let dotted = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(host);
  if (dotted) {
    ipv4 = parseIPv4(dotted[2]);
    if (!ipv4) {
      return null;
    }
    host = dotted[1] + "0:0";
  }
  let halves = host.split("::");
  if (halves.length > 2) {
    return null;
  }
  let groupsOf = function (aText) {
    return (aText === "") ? [] : aText.split(":").map(function (aGroup) {
      return /^[0-9a-f]{1,4}$/.test(aGroup) ? parseInt(aGroup, 16) : NaN;
    });
  };
  let head = groupsOf(halves[0]);
  let rest = (halves.length == 2) ? groupsOf(halves[1]) : [];
  if (head.concat(rest).some(isNaN)) {
    return null;
  }
  let groups;
  if (halves.length == 2) {
    let missing = 8 - head.length - rest.length;
    if (missing < 1) {
      return null;
    }
    groups = head.concat(new Array(missing).fill(0), rest);
  } else if (head.length == 8) {
    groups = head;
  } else {
    return null;
  }
  if (ipv4) {
    groups[6] = (ipv4[0] * 256) + ipv4[1];
    groups[7] = (ipv4[2] * 256) + ipv4[3];
  }
  return groups;
}

/**
 * @param {number[]} aBytes - An IPv4 address.
 * @returns {boolean} Loopback, "this network", private (RFC 1918) or
 *   link-local.
 */
function isInternalIPv4(aBytes) {
  let a = aBytes[0];
  let b = aBytes[1];
  return (a == 127) || (a == 10) || (a == 0)
      || ((a == 169) && (b == 254))
      || ((a == 192) && (b == 168))
      || ((a == 172) && (b >= 16) && (b <= 31));
}

/**
 * @param {number[]} aBytes - An IPv4 address.
 * @returns {boolean} Whether it's a loopback address (127.0.0.0/8).
 */
function isLoopbackIPv4(aBytes) {
  return aBytes[0] == 127;
}

/**
 * @param {number[]} aGroups - An IPv6 address.
 * @returns {?number[]} The IPv4 address it carries (IPv4-mapped
 *   ::ffff:a.b.c.d, IPv4-compatible ::a.b.c.d, NAT64 64:ff9b::a.b.c.d),
 *   or null.
 */
function embeddedIPv4(aGroups) {
  let zeros = function (aFrom, aTo) {
    return aGroups.slice(aFrom, aTo).every(function (aGroup) {
      return aGroup == 0;
    });
  };
  let carries = (zeros(0, 5) && (aGroups[5] == 0xffff))
      || (zeros(0, 6) && ((aGroups[6] != 0) || (aGroups[7] > 1)))
      || ((aGroups[0] == 0x64) && (aGroups[1] == 0xff9b) && zeros(2, 6));
  if (!carries) {
    return null;
  }
  return [aGroups[6] >> 8, aGroups[6] & 0xff, aGroups[7] >> 8,
    aGroups[7] & 0xff];
}

/**
 * Returns true if a host is a loopback, link-local, private or unique-local
 * address (or a *.localhost / *.local name), in any of the forms a URL
 * accepts for one.  Such hosts are reachable only via an explicit @connect
 * entry, never via "@connect *" or the legacy allow-all default, to blunt
 * SSRF into intranet / loopback services (finding S11).  Address forms
 * only; hostnames that resolve to internal IPs (DNS rebinding) are out of
 * scope at this layer.
 *
 * @param {string} aHost - Request host.
 * @returns {boolean}
 */
GM_xmlHttpRequester.prototype._isInternalHost = function (aHost) {
  let host = normalizeHost(aHost);
  if (!host) {
    return false;
  }
  if ((host == "localhost") || host.endsWith(".localhost")
      || host.endsWith(".local")) {
    return true;
  }
  let ipv6 = parseIPv6(host);
  if (ipv6) {
    let ipv4 = embeddedIPv4(ipv6);
    if (ipv4) {
      return isInternalIPv4(ipv4);
    }
    let allZero = ipv6.slice(0, 7).every(function (aGroup) {
      return aGroup == 0;
    });
    // :: and ::1; fc00::/7 (unique local); fe80::/10 (link-local);
    // fec0::/10 (the old site-local).
    return (allZero && (ipv6[7] <= 1))
        || ((ipv6[0] & 0xfe00) == 0xfc00)
        || ((ipv6[0] & 0xffc0) == 0xfe80)
        || ((ipv6[0] & 0xffc0) == 0xfec0);
  }
  let ipv4 = parseIPv4(host);
  return !!ipv4 && isInternalIPv4(ipv4);
};

/**
 * @param {string} aHost - Request host.
 * @returns {boolean} Whether it is this computer: localhost, or a loopback
 *   address in any form (what "@connect localhost" allows).
 */
GM_xmlHttpRequester.prototype._isLoopbackHost = function (aHost) {
  let host = normalizeHost(aHost);
  if ((host == "localhost") || host.endsWith(".localhost")) {
    return true;
  }
  let ipv6 = parseIPv6(host);
  if (ipv6) {
    let ipv4 = embeddedIPv4(ipv6);
    return ipv4 ? isLoopbackIPv4(ipv4)
        : (ipv6.slice(0, 7).every(function (aGroup) {
          return aGroup == 0;
        }) && (ipv6[7] == 1));
  }
  let ipv4 = parseIPv4(host);
  return !!ipv4 && isLoopbackIPv4(ipv4);
};

/**
 * Checks whether a request URL is allowed by the script's @connect whitelist.
 *
 * Rules (Violentmonkey-compatible; entries are case-insensitive):
 *   - No @connect declared → same-origin only
 *   - @connect *           → any host but internal ones (_isInternalHost),
 *                            which need their own entry, before or after
 *   - @connect self        → same-origin
 *   - @connect example.com → example.com and *.example.com
 *   - @connect localhost   → localhost and loopback addresses
 *
 * Checked for the request's address and again for every redirect
 * (_guardRedirects).
 *
 * @param {nsIURI} aRequestUri - Parsed URI of the request target.
 * @returns {boolean} True if the request is allowed.
 */
GM_xmlHttpRequester.prototype._isConnectAllowed = function (aRequestUri) {
  // data: and blob: URIs are always allowed (local resources).
  if (aRequestUri.scheme == "data" || aRequestUri.scheme == "blob") {
    return true;
  }

  let requestHost;
  try {
    requestHost = normalizeHost(aRequestUri.host);
  } catch (e) {
    // URIs without a host (e.g. malformed) — block.
    return false;
  }
  if (!requestHost) {
    return false;
  }

  // Determine the page's origin hostname for same-origin checks.
  let originHost = "";
  try {
    originHost = normalizeHost(GM_util.getUriFromUrl(this.originUrl).host);
  } catch (e) {
    // Ignore — originHost stays empty, so same-origin checks will fail
    // gracefully (only explicit @connect entries will match).
  }

  // Same-origin requests are always allowed: a script can reach its own
  // page's origin without declaring @connect (matches Violentmonkey /
  // Tampermonkey).
  if (originHost && (requestHost == originHost)) {
    return true;
  }

  // No @connect declared → same-origin only (allowed above).  Historically
  // this returned true (allow ALL hosts), which contradicted both this
  // function's own documented contract and every other userscript manager,
  // and let any script silently read authenticated cross-origin resources
  // (security finding S2).  A default-off pref restores the old permissive
  // behavior for legacy script collections that relied on it.
  if (this.connects.length == 0) {
    // Even the legacy "allow all" pref must not expose internal hosts
    // (loopback / RFC1918); those require an explicit @connect (S11).
    return (!this._isInternalHost(requestHost)) && GM_prefRoot.getValue(
        "xmlhttprequest.allowAllHostsWithoutConnect", false);
  }

  for (let i = 0; i < this.connects.length; i++) {
    // Host names are case-insensitive; nsIURI.host is lowercase.
    let entry = normalizeHost(this.connects[i]);
    if (!entry) {
      continue;
    }
    // Wildcard: allow any external host, but never internal hosts —
    // those require an explicit @connect entry (finding S11), which may
    // come after this one, so keep looking.
    if (entry == "*") {
      if (!this._isInternalHost(requestHost)) {
        return true;
      }
      continue;
    }
    // Same-origin.
    if (entry == "self") {
      if (requestHost == originHost) {
        return true;
      }
      continue;
    }
    // localhost: this computer, by name or loopback address.
    if (entry == "localhost") {
      if (this._isLoopbackHost(requestHost)) {
        return true;
      }
      continue;
    }
    // Tampermonkey-compatible `*.domain.tld` wildcard.  Matches the
    // bare host (`domain.tld`) and any subdomain of it.  Without this,
    // scripts written for TM that do `// @connect *.googleapis.com`
    // would silently get every request rejected even though the same
    // bare-host form `// @connect googleapis.com` works.
    if (entry.startsWith("*.")) {
      let bare = entry.substr(2);
      if (requestHost == bare || requestHost.endsWith("." + bare)) {
        return true;
      }
      continue;
    }
    // Exact match or subdomain match.
    // "example.com" matches "example.com" and "sub.example.com".
    if (requestHost == entry
        || requestHost.endsWith("." + entry)) {
      return true;
    }
  }

  return false;
};

/**
 * Entry point called from the userscript (content security context).
 * Validates the request URL and scheme, creates an XMLHttpRequest object,
 * then delegates to chromeStartRequest() in the chrome context.
 *
 * @param {object} aDetails - GM_xmlhttpRequest details object (see file header).
 * @returns {object} Response handle cloned into sandbox scope:
 *   { abort(), finalUrl, readyState, responseHeaders, responseText,
 *     status, statusText }.  For synchronous requests, the response fields are
 *   populated before returning.
 * @throws {Error} If aDetails is missing; or the URL is invalid, its scheme
 *   disallowed or its host not allowed by @connect and there is no onerror
 *   to call (see _refuse).
 */
GM_xmlHttpRequester.prototype.contentStartRequest = function (aDetails) {
  if (!aDetails || (typeof aDetails != "object")) {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.xmlhttpRequest.noDetails"),
        this.fileURL, null);
  }

  let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGreasemonkeyProperties);

  // A URL object (or anything else) as its text, as Violentmonkey takes
  // it.  Passed as an object, every one reached the memoized URL parser
  // with the same cache key, so all went to the first one's address.
  let rawUrl;
  try {
    rawUrl = (aDetails.url == null) ? "" : String(aDetails.url);
  } catch (e) {
    rawUrl = "";
  }

  let uri = null;
  let url = null;

  try {
    // Validate and parse the (possibly relative) given URL.
    uri = GM_util.getUriFromUrl(rawUrl, this.originUrl);
    url = uri.spec;
  } catch (e) {
    // A malformed URL won't be parsed properly.
    // Functions, so a "$" in the address is taken literally.
    return this._refuse(aDetails, rawUrl, bundle
        .GetStringFromName("error.invalidUrl").replace("%1", function () {
          return rawUrl;
        }));
  }

  // This is important - without it, GM_xmlhttpRequest can be used
  // to get access to things like files and chrome.
  // Careful.
  if (REQUEST_SCHEMES.indexOf(uri.scheme) == -1) {
    return this._refuse(aDetails, url, bundle
        .GetStringFromName("error.disallowedScheme").replace("%1", function () {
          return rawUrl;
        }));
  }

  // Enforce @connect whitelist.
  if (!this._isConnectAllowed(uri)) {
    return this._refuse(aDetails, url, "GM_xmlhttpRequest: request to "
        + uri.host + " is not allowed by @connect.");
  }

  var req = new XMLHttpRequest(
      // Firefox 41+
      // http://bugzil.la/1163898
      (aDetails.mozAnon || aDetails.anonymous)
      ? {
        "mozAnon": true,
      }
      : {});
  this.chromeStartRequest(url, aDetails, req);

  var rv = {
    "abort": function () {
      return req.abort();
    },
    "finalUrl": null,
    "readyState": null,
    "responseHeaders": null,
    "responseText": null,
    "status": null,
    "statusText": null,
  };

  if (!!aDetails.synchronous) {
    // XMLHttpRequest has no finalUrl; this was always undefined.
    rv.finalUrl = req.responseURL || (req.channel ? req.channel.URI.spec : url);
    rv.readyState = req.readyState;
    rv.responseHeaders = req.getAllResponseHeaders();
    try {
      rv.responseText = req.responseText;
    } catch (e) {
      // Some response types don't have .responseText
      // (but do have e.g. blob .response).
      // Ignore.
    }
    rv.status = req.status;
    rv.statusText = req.statusText;
  }

  rv = Cu.cloneInto({
    "abort": rv.abort.bind(rv),
    "finalUrl": rv.finalUrl,
    "readyState": rv.readyState,
    "responseHeaders": rv.responseHeaders,
    "responseText": rv.responseText,
    "status": rv.status,
    "statusText": rv.statusText,
  }, this.sandbox, {
    "cloneFunctions": true,
  });

  return rv;
};

/**
 * A request that can't be made (a bad address or scheme, or a host
 * @connect doesn't allow) goes to its onerror, as Violentmonkey and
 * Tampermonkey do, with the reason as `error`; it is thrown only when
 * there is no onerror.  Throwing used to stop the script's own code after
 * the GM_xmlhttpRequest() call even when it had an onerror.
 *
 * @param {object} aDetails - The script's details object.
 * @param {string} aUrl     - The request's address, as far as known.
 * @param {string} aMessage - Why it can't be made.
 * @returns {object} A request handle (abort() does nothing).
 * @throws {Error} aMessage, when the details have no onerror of the
 *   script's own.
 */
GM_xmlHttpRequester.prototype._refuse = function (aDetails, aUrl, aMessage) {
  let waived = Cu.waiveXrays(aDetails);
  let onerror = waived.onerror;
  if ((typeof onerror != "function")
      || !this.sandboxPrincipal.equals(Cu.getObjectPrincipal(onerror))) {
    throw new this.wrappedContentWin.Error(aMessage, this.fileURL, null);
  }

  let response = Cu.cloneInto({
    "error": aMessage,
    "finalUrl": aUrl,
    "readyState": 4,
    "response": null,
    "responseHeaders": "",
    "responseText": "",
    "status": 0,
    "statusText": "",
  }, this.sandbox);
  Cu.waiveXrays(response).context = waived.context;
  // As the request's own events are: later, via the page's setTimeout.
  new XPCNativeWrapper(this.wrappedContentWin, "setTimeout()")
    .setTimeout(function () {
      onerror.call(waived, response);
    }, 0);

  return Cu.cloneInto({
    "abort": function () {},
    "finalUrl": aUrl,
    "readyState": 4,
    "responseHeaders": "",
    "responseText": "",
    "status": 0,
    "statusText": "",
  }, this.sandbox, {
    "cloneFunctions": true,
  });
};

/**
 * Re-checks every redirect of the request: its target must have an allowed
 * scheme and be allowed by @connect, internal hosts included.  Only the
 * first address used to be checked, so a public page redirecting to
 * http://127.0.0.1/ (or, with no @connect, an open redirect on the script's
 * own site) reached what @connect should have blocked.  A refused redirect
 * ends the request with its error event, and says why in the Browser
 * Console.
 *
 * Installed as the channel's notification callbacks before send(): the XHR
 * then passes each redirect to it.  Other interfaces go to the callbacks
 * the channel had.
 *
 * @param {XMLHttpRequest} aReq - The opened request.
 * @returns {void}
 */
GM_xmlHttpRequester.prototype._guardRedirects = function (aReq) {
  let channel = aReq.channel;
  if (!channel) {
    return undefined;
  }
  let requester = this;
  let previous = channel.notificationCallbacks;
  let previousSink = function () {
    try {
      return previous ? previous.getInterface(Ci.nsIChannelEventSink) : null;
    } catch (e) {
      return null;
    }
  };

  channel.notificationCallbacks = {
    "asyncOnChannelRedirect": function (
        aOldChannel, aNewChannel, aFlags, aCallback) {
      let uri = aNewChannel.URI;
      if ((REQUEST_SCHEMES.indexOf(uri.scheme) == -1)
          || !requester._isConnectAllowed(uri)) {
        GM_util.logError("GM_xmlhttpRequest: the redirect to " + uri.spec
            + " is not allowed by @connect.", true, requester.fileURL, null);
        aCallback.onRedirectVerifyCallback(
            Components.results.NS_ERROR_ABORT);
        return undefined;
      }
      let sink = previousSink();
      if (sink) {
        sink.asyncOnChannelRedirect(
            aOldChannel, aNewChannel, aFlags, aCallback);
      } else {
        aCallback.onRedirectVerifyCallback(Components.results.NS_OK);
      }
    },
    "getInterface": function (aIID) {
      if (aIID.equals(Ci.nsIChannelEventSink)) {
        return this;
      }
      if (previous) {
        return previous.getInterface(aIID);
      }
      throw Components.results.NS_ERROR_NO_INTERFACE;
    },
    "QueryInterface": XPCOMUtils.generateQI(
        [Ci.nsIChannelEventSink, Ci.nsIInterfaceRequestor]),
  };
};

/**
 * Called in the chrome security context to configure and send the XHR.
 * Sets up event listeners, request headers, body, timeout, privacy mode,
 * container identity, and MIME type override before calling aReq.send().
 *
 * @param {string}       aSafeUrl  - Validated absolute URL string.
 * @param {object}       aDetails  - Original GM_xmlhttpRequest details object.
 * @param {XMLHttpRequest} aReq    - The XHR object to configure and send.
 * @throws {Error} If aReq.open() or aReq.send() throws.
 */
GM_xmlHttpRequester.prototype.chromeStartRequest =
function (aSafeUrl, aDetails, aReq) {
  let setupRequestEvent = this.setupRequestEvent.bind(
      this, this.wrappedContentWin, this.sandbox,
      this.fileURL);

  // Waive X-rays once per details object rather than per event setup.
  // setupRequestEvent was previously calling Cu.waiveXrays(aDetails)
  // on every entry, so the same wrapper-chain walk ran 8x for the
  // main XHR and 6x for the upload — ~5-10µs each, ~70-140µs wasted
  // per request.  Hoisted out; setupRequestEvent now skips the waive
  // when it sees the already-waived form.
  let waivedDetails = Cu.waiveXrays(aDetails);
  let waivedUpload = aDetails.upload
      ? Cu.waiveXrays(aDetails.upload) : null;

  setupRequestEvent(aReq, "abort", waivedDetails);
  setupRequestEvent(aReq, "error", waivedDetails);
  setupRequestEvent(aReq, "load", waivedDetails);
  setupRequestEvent(aReq, "loadend", waivedDetails);
  setupRequestEvent(aReq, "loadstart", waivedDetails);
  setupRequestEvent(aReq, "progress", waivedDetails);
  setupRequestEvent(aReq, "readystatechange", waivedDetails);
  setupRequestEvent(aReq, "timeout", waivedDetails);
  if (waivedUpload) {
    setupRequestEvent(aReq, "abort", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "error", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "load", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "loadend", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "loadstart", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "progress", waivedDetails, waivedUpload);
    setupRequestEvent(aReq, "timeout", waivedDetails, waivedUpload);
  }

  aReq.mozBackgroundRequest = !!aDetails.mozBackgroundRequest;

  // Basic-Auth is handled by the open() user / password arguments below (a
  // script may also set its own Authorization header).  The former
  // nsIHttpAuthManager path was removed: it wrote into the browser-wide
  // HTTP auth cache, leaking the script's credentials to other requests to
  // that origin and persisting them (bugs #1945 / #2008).

  // See #2423.
  // http://bugzil.la/1275746
  //
  // Default the method to GET per the GM4 / TM / VM spec.  The XHR
  // open() argument is required and must be a valid HTTP method
  // token, so passing `undefined` (which happens whenever a script
  // calls `GM_xmlhttpRequest({url, onload})` without specifying a
  // method) throws NS_ERROR_INVALID_ARG and the script sees a
  // synthetic XHR failure instead of a successful fetch.
  try {
    aReq.open(aDetails.method || "GET", aSafeUrl,
        !aDetails.synchronous, aDetails.user || "", aDetails.password || "");
  } catch (e) {
    throw new this.wrappedContentWin.Error(
        "GM_xmlhttpRequest():"
        + "\n" + aDetails.url + "\n" + e,
        this.fileURL, null);
  }

  // @connect applies to every redirect, not just the first address.
  this._guardRedirects(aReq);

  let channel;

  // Private Browsing, Containers (Firefox 42+).
  let privateMode = false;
  if (GM_util.windowIsPrivate(this.wrappedContentWin)) {
    privateMode = true;
  }
  let userContextId = null;
  if (this.wrappedContentWin.document
      && this.wrappedContentWin.document.nodePrincipal
      && this.wrappedContentWin.document.nodePrincipal.originAttributes
      && this.wrappedContentWin.document.nodePrincipal.originAttributes
          .userContextId) {
    userContextId = this.wrappedContentWin.document.nodePrincipal
        .originAttributes.userContextId;
  }
  if (userContextId === null) {
    if (aReq.channel instanceof Ci.nsIPrivateBrowsingChannel) {
      if (privateMode) {
        channel = aReq.channel.QueryInterface(Ci.nsIPrivateBrowsingChannel);
        channel.setPrivate(true);
      }
    }
  } else {
    aReq.setOriginAttributes({
      "privateBrowsingId": privateMode ? 1 : 0,
      "userContextId": userContextId,
    });
  }
  /*
  dump("GM_xmlhttpRequest - url:" + "\n" + aSafeUrl + "\n"
      + "Private Browsing mode: " + aReq.channel.isChannelPrivate + "\n");
  */

  try {
    channel = aReq.channel.QueryInterface(Ci.nsIHttpChannelInternal);
    // Forcing third-party cookies lets a cross-origin GM_xmlhttpRequest
    // send the user's cookies even when the browser is set to block
    // third-party cookies (finding S3).  Left on by default for
    // backwards compatibility; set this pref false to respect the
    // browser's own third-party-cookie policy.  (Anonymous / mozAnon
    // requests never send cookies regardless of this setting.)
    channel.forceAllowThirdPartyCookie = GM_prefRoot.getValue(
        "xmlhttprequest.forceThirdPartyCookies", true);
  } catch (e) {
    // Ignore.
    // e.g. ftp://
  }

  if (aDetails.overrideMimeType) {
    aReq.overrideMimeType(aDetails.overrideMimeType);
  }
  if (aDetails.responseType) {
    aReq.responseType = aDetails.responseType;
  }

  if (aDetails.timeout) {
    aReq.timeout = aDetails.timeout;
  }

  let httpChannel;
  // Not use: aDetails.redirectionLimit
  // (may have the value: 0 or 1 - a "boolean")
  if ("redirectionLimit" in aDetails) {
    try {
      httpChannel = aReq.channel.QueryInterface(Ci.nsIHttpChannel);
      httpChannel.redirectionLimit = aDetails.redirectionLimit;
    } catch (e) {
      // Ignore.
    }
  }

  // Per-request cookies: send the script-supplied cookie string verbatim
  // as a Cookie request header (Violentmonkey / Tampermonkey semantics).
  // The destination is already @connect-gated (contentStartRequest), this
  // affects only THIS request, and it does NOT write to the browser cookie
  // store.  Use mozAnon/anonymous to suppress the user's own cookies.
  if (aDetails.cookies) {
    try {
      aReq.setRequestHeader("Cookie", String(aDetails.cookies));
    } catch (e) {
      // Some builds may treat Cookie as a forbidden header; ignore so the
      // request still proceeds without the override.
    }
  }

  let body = aDetails.data ? aDetails.data : null;

  // Identify the body shape once so both the header loop (below) and
  // the send() switch (further down) can react to it.  The
  // Object.prototype.toString @@toStringTag survives X-ray wrappers
  // on DOM-defined types, so we can reliably distinguish FormData /
  // URLSearchParams / Blob / ArrayBuffer / File from a plain string
  // even when `body` is a sandbox-side reference passed in by the
  // userscript.  Mirrors Violentmonkey's web/requests.js getFormData()
  // detection, but done chrome-side so the platform XHR consumes the
  // native object directly without any intermediate serialisation.
  let bodyTag = (body !== null && typeof body === "object")
      ? Object.prototype.toString.call(body)
      : "";
  let bodyIsNativeInit = (
      bodyTag === "[object FormData]"
      || bodyTag === "[object URLSearchParams]"
      || bodyTag === "[object Blob]"
      || bodyTag === "[object File]"
      || bodyTag === "[object ArrayBuffer]");

  if (aDetails.headers) {
    let headers = aDetails.headers;

    for (let prop in headers) {
      if (!Object.prototype.hasOwnProperty.call(headers, prop)) {
        continue;
      }
      // For FormData, skip a script-supplied Content-Type so the
      // platform XHR can auto-generate the multipart boundary string
      // (the boundary is part of the wire format, and a hand-set CT
      // would lack it — server-side parsing then fails silently).
      // URLSearchParams / Blob have unambiguous defaults; only
      // FormData needs this protection.
      if (bodyTag === "[object FormData]"
          && prop.toLowerCase() === "content-type") {
        continue;
      }
      aReq.setRequestHeader(prop, headers[prop]);
    }
  }

  // See #2423.
  // http://bugzil.la/918751
  try {
    if (bodyIsNativeInit) {
      // FormData / URLSearchParams / Blob / File / ArrayBuffer go
      // straight to the platform XHR — it knows how to encode each
      // shape, including the multipart boundary for FormData and the
      // x-www-form-urlencoded encoding for URLSearchParams.  Bypass
      // the binary-encoding path entirely so we don't try to read
      // .charCodeAt on a non-string.
      aReq.send(body);
    } else if (aDetails.binary && (body !== null)) {
      let bodyLength = body.length;
      let bodyData = new Uint8Array(bodyLength);
      for (let i = 0; i < bodyLength; i++) {
        bodyData[i] = body.charCodeAt(i) & 0xff;
      }
      aReq.send(new Blob([bodyData]));
    } else {
      aReq.send(body);
    }
  } catch (e) {
    throw new this.wrappedContentWin.Error(
        "GM_xmlhttpRequest():"
        + "\n" + aDetails.url + "\n" + e,
        this.fileURL, null);
  }
};

/**
 * @param {XMLHttpRequest} aReq     - A finished request.
 * @param {object}         aDetails - The script's details (pre-waived).
 * @returns {?string} The type DOMParser should read its text as, when it
 *   is HTML or XML (the override MIME type first, then Content-Type).
 */
function documentTypeOf(aReq, aDetails) {
  let type = aDetails.overrideMimeType ? String(aDetails.overrideMimeType) : "";
  if (!type) {
    try {
      type = aReq.getResponseHeader("Content-Type") || "";
    } catch (e) {
      type = "";
    }
  }
  type = type.split(";")[0].trim().toLowerCase();
  switch (type) {
    case "application/xhtml+xml":
    case "application/xml":
    case "image/svg+xml":
    case "text/html":
    case "text/xml":
      return type;
  }
  return /\+xml$/.test(type) ? "application/xml" : null;
}

/**
 * The response as a document the script can use: made once per request,
 * when it has finished (null before then, and for responses that aren't
 * HTML or XML).
 *
 * The request runs here, in chrome, so its own responseXML / document
 * response belongs to the response's origin: the script got "Permission
 * denied" using it.  The copy belongs to the page:
 *   - the XHR's own document (XML with responseType "", or responseType
 *     "document"), imported into a new document of the page, an HTML one
 *     for HTML;
 *   - otherwise HTML or XML text, parsed with the page's DOMParser: the
 *     XHR leaves responseXML null for HTML, which Violentmonkey parses.
 *
 * @param {XMLHttpRequest} aReq     - The request.
 * @param {Window}         aWin     - The page (X-ray wrapped).
 * @param {string}         aFileURL - The script, for the console.
 * @param {object}         aDetails - The script's details (pre-waived).
 * @returns {?Document}
 */
function responseDocument(aReq, aWin, aFileURL, aDetails) {
  if (aReq.readyState != 4) {
    return null;
  }
  if (gResponseDocuments.has(aReq)) {
    return gResponseDocuments.get(aReq);
  }

  let doc = null;
  try {
    let type = aReq.responseType;
    if ((type == "") || (type == "document")) {
      let source = null;
      try {
        source = aReq.responseXML;
      } catch (e) {
        // None for this response.
      }
      let implementation = aWin.document.implementation;
      if (source && source.documentElement) {
        let html = (source.contentType == "text/html");
        doc = html ? implementation.createHTMLDocument("")
            : implementation.createDocument(null, null, null);
        let root = doc.importNode(source.documentElement, true);
        if (doc.documentElement) {
          doc.replaceChild(root, doc.documentElement);
        } else {
          doc.appendChild(root);
        }
      } else if (type == "") {
        let parseAs = documentTypeOf(aReq, aDetails);
        if (parseAs) {
          doc = new aWin.DOMParser().parseFromString(
              aReq.responseText, parseAs);
        }
      }
    }
  } catch (e) {
    // The page may be gone (navigated away mid-request).  The rest of the
    // response still reaches the script.
    GM_util.logError("GM_xmlhttpRequest - the response as a document:"
        + "\n" + '"' + aDetails.url + '":' + "\n" + e, true, aFileURL, null);
    doc = null;
  }
  gResponseDocuments.set(aReq, doc);

  return doc;
}

/**
 * Attaches a DOM event listener to aReq (or aReq.upload) for the given event
 * type, wired to call the corresponding "on<event>" callback from aDetails
 * (or aUpload) in the content security context.
 *
 * Security:
 *   - Xray wrappers are waived to read callback properties from aDetails.
 *   - The callback's principal is verified against the sandbox principal to
 *     ensure it came from the script rather than the page.
 *   - Callback is invoked via XPCNativeWrapper + setTimeout(…, 0) to return
 *     to the browser thread and prevent privilege escalation.
 *
 * The responseState object passed to the callback mirrors the GM4 spec:
 *   { context, finalUrl, lengthComputable, loaded, readyState, response,
 *     responseHeaders, responseText, responseXML, status, statusText, total }
 * It always describes the request itself (aReq), also for upload events,
 * which additionally carry lengthComputable / loaded / total.
 *
 * responseXML (and response, for responseType "document") is a getter for
 * a document of the page's own, made once (responseDocument), so the
 * script can use DOM APIs on it.
 *
 * @param {Window}       aWrappedContentWin - Content window (for setTimeout/Error).
 * @param {Sandbox}      aSandbox           - Script sandbox (for Cu.cloneInto).
 * @param {string}       aFileURL           - Script URL (for Error objects).
 * @param {XMLHttpRequest} aReq             - The request.  The listener goes on
 *   aReq.upload when aUpload is given.
 * @param {string}       aEvent             - Event name (e.g. "load", "progress").
 * @param {object}       aDetails           - GM_xmlhttpRequest details object
 *   (pre-waived): url, context, and the request's callbacks.
 * @param {object}       [aUpload]          - details.upload (pre-waived), for
 *   an upload event; its callback is used instead of aDetails'.
 */
GM_xmlHttpRequester.prototype.setupRequestEvent = function (
    aWrappedContentWin, aSandbox, aFileURL, aReq, aEvent, aDetails, aUpload) {
  // aDetails / aUpload arrive pre-waived from chromeStartRequest's call
  // site; the redundant waive that used to live here ran once per event-
  // type setup (8x for the main XHR, 7x for upload).  Hoisted out.
  let callbacks = aUpload || aDetails;
  let callbackName = (aUpload ? "upload.on" : "on") + aEvent;
  var eventCallback = callbacks["on" + aEvent];
  if (!eventCallback) {
    return undefined;
  }
  if (typeof eventCallback != "function") {
    throw new aWrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.xmlhttpRequest.callbackIsNotFunction")
            .replace("%1", aDetails.url)
            .replace("%2", callbackName),
        aFileURL, null);
  }

  // ...but ensure that the callback came from a script, not content,
  // by checking that its principal equals that of the sandbox.
  let callbackPrincipal = Cu.getObjectPrincipal(eventCallback);
  if (!this.sandboxPrincipal.equals(callbackPrincipal)) {
    return undefined;
  }

  // Handed back by reference, as Tampermonkey / Violentmonkey (and GM
  // 4.14) do: identity, class instances and falsy values survive.  The
  // structured clone used before lost them, and threw on a Promise, so
  // the callback never ran.
  let context = aDetails.context;

  (aUpload ? aReq.upload : aReq).addEventListener(aEvent, function (aEvt) {
    let isDocument = (aReq.responseType == "document");
    var responseState = {
      "finalUrl": null,
      "lengthComputable": null,
      "loaded": null,
      "readyState": aReq.readyState,
      // A document response is a getter below (see responseDocument).
      "response": isDocument ? null : aReq.response,
      "responseHeaders": null,
      "responseText": null,
      "status": null,
      "statusText": null,
      "total": null,
    };

    try {
      responseState.responseText = aReq.responseText;
    } catch (e) {
      // Some response types don't have .responseText
      // (but do have e.g. blob .response).
      // Ignore.
    }

    if (aUpload || (aEvent == "progress")) {
      // Every upload event is a ProgressEvent, as is the request's own
      // "progress".
      responseState.lengthComputable = aEvt.lengthComputable;
      responseState.loaded = aEvt.loaded;
      responseState.total = aEvt.total;
    } else if ((aEvent != "error") && (aReq.readyState >= 2)) {
      responseState.finalUrl = aReq.channel.URI.spec;
      responseState.responseHeaders = aReq.getAllResponseHeaders();
      responseState.status = aReq.status;
      responseState.statusText = aReq.statusText;
    }

    responseState = Cu.cloneInto(responseState, aSandbox, {
      "wrapReflectors": true,
    });
    let waivedState = Cu.waiveXrays(responseState);
    // Set after the clone, through the waiver, so the script gets its own
    // object back rather than a copy (see `context` above).
    waivedState.context = context;
    // responseXML, and the response of responseType "document": the page's
    // own copy of the response as a document, made when first read.
    let documentGetter = Cu.exportFunction(function () {
      return responseDocument(aReq, aWrappedContentWin, aFileURL, aDetails);
    }, aSandbox);
    Object.defineProperty(waivedState, "responseXML", {
      "configurable": true,
      "enumerable": true,
      "get": documentGetter,
    });
    if (isDocument) {
      Object.defineProperty(waivedState, "response", {
        "configurable": true,
        "enumerable": true,
        "get": documentGetter,
      });
    }

    if (GM_util.windowIsClosed(aWrappedContentWin)) {
      try {
        aReq.abort();
      } catch (e) {
        GM_util.logError(
            "GM_xmlHttpRequester.setupRequestEvent - url:"
            + "\n" + '"' + aDetails.url + '":' + "\n" + e, true,
            aFileURL, null);
      }
      return undefined;
    }

    // Pop back onto browser thread and call event handler.
    // Have to use nested function here instead of GM_util.hitch
    // because otherwise aDetails[aEvent].apply can point to window.setTimeout,
    // which can be abused to get increased privileges.
    new XPCNativeWrapper(aWrappedContentWin, "setTimeout()")
      .setTimeout(function () {
        eventCallback.call(callbacks, responseState);
      }, 0);
  }, false);
};
