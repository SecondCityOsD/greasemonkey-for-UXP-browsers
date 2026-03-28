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
 *   - Cookie forwarding (aDetails.cookies) is reserved for future use
 *     (see bug #2236).
 *   - Basic-Auth header injection (aDetails.user/password) partial support
 *     is commented out pending resolution of bugs #1945 and #2008.
 *   - mozAnon on Pale Moon < 27.2 is emulated via LOAD_ANONYMOUS flag
 *     (see Pale Moon PR #968).
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

Cu.import("chrome://greasemonkey-modules/content/util.js");


// Cookies - reserved for possible future use (see also #2236) - part 1/2.
/*
const COOKIES_SERVICE = Cc["@mozilla.org/cookieService;1"].getService()
    .QueryInterface(Ci.nsICookieService);
*/

// See #1945, #2008 - part 1/3.
/*
const AUTHORIZATION_USER_PASSWORD_REGEXP = new RegExp(
    "^([^:]+):([^:]+)$", "");
*/

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
 * Checks whether a request URL is allowed by the script's @connect whitelist.
 *
 * Rules (Violentmonkey-compatible):
 *   - No @connect declared → same-origin only
 *   - @connect *           → allow all
 *   - @connect self        → same-origin
 *   - @connect example.com → example.com and *.example.com
 *   - @connect localhost   → localhost and 127.0.0.1
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
    requestHost = aRequestUri.host;
  } catch (e) {
    // URIs without a host (e.g. malformed) — block.
    return false;
  }

  // Determine the page's origin hostname for same-origin checks.
  let originHost = "";
  try {
    originHost = GM_util.getUriFromUrl(this.originUrl).host;
  } catch (e) {
    // Ignore — originHost stays empty, so same-origin checks will fail
    // gracefully (only explicit @connect entries will match).
  }

  // No @connect declared → allow all (backwards compatible).
  // Scripts that don't declare @connect should not be restricted,
  // since most existing scripts predate @connect support.
  if (this.connects.length == 0) {
    return true;
  }

  for (let i = 0; i < this.connects.length; i++) {
    let entry = this.connects[i];
    // Wildcard — allow everything.
    if (entry == "*") {
      return true;
    }
    // Same-origin.
    if (entry == "self") {
      if (requestHost == originHost) {
        return true;
      }
      continue;
    }
    // localhost also matches 127.0.0.1.
    if (entry == "localhost") {
      if (requestHost == "localhost" || requestHost == "127.0.0.1") {
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
 * @throws {Error} If aDetails is missing, URL is invalid, or scheme is disallowed.
 */
GM_xmlHttpRequester.prototype.contentStartRequest = function (aDetails) {
  if (!aDetails || (typeof aDetails != "object")) {
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.xmlhttpRequest.noDetails"),
        this.fileURL, null);
  }

  let uri = null;
  let url = null;

  try {
    // Validate and parse the (possibly relative) given URL.
    uri = GM_util.getUriFromUrl(aDetails.url, this.originUrl);
    url = uri.spec;
  } catch (e) {
    // A malformed URL won't be parsed properly.
    throw new this.wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.invalidUrl")
            .replace("%1", aDetails.url),
        this.fileURL, null);
  }

  // Enforce @connect whitelist.
  if (!this._isConnectAllowed(uri)) {
    throw new this.wrappedContentWin.Error(
        "GM_xmlhttpRequest: request to " + uri.host
        + " is not allowed by @connect.",
        this.fileURL, null);
  }

  // This is important - without it, GM_xmlhttpRequest can be used
  // to get access to things like files and chrome.
  // Careful.
  switch (uri.scheme) {
    case "blob":
    case "data":
    case "ftp":
    case "http":
    case "https":
      var req = new XMLHttpRequest(
          // Firefox 41+
          // http://bugzil.la/1163898
          (aDetails.mozAnon || aDetails.anonymous)
          ? {
            "mozAnon": true,
          }
          : {});
      GM_util.hitch(this, "chromeStartRequest", url, aDetails, req)();
      break;
    default:
      throw new this.wrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.disallowedScheme")
              .replace("%1", aDetails.url),
          this.fileURL, null);
  }

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
    rv.finalUrl = req.finalUrl;
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
  let setupRequestEvent = GM_util.hitch(
      this, "setupRequestEvent", this.wrappedContentWin, this.sandbox,
      this.fileURL);

  setupRequestEvent(aReq, "abort", aDetails);
  setupRequestEvent(aReq, "error", aDetails);
  setupRequestEvent(aReq, "load", aDetails);
  setupRequestEvent(aReq, "loadend", aDetails);
  setupRequestEvent(aReq, "loadstart", aDetails);
  setupRequestEvent(aReq, "progress", aDetails);
  setupRequestEvent(aReq, "readystatechange", aDetails);
  setupRequestEvent(aReq, "timeout", aDetails);
  if (aDetails.upload) {
    setupRequestEvent(aReq.upload, "abort", aDetails.upload);
    setupRequestEvent(aReq.upload, "error", aDetails.upload);
    setupRequestEvent(aReq.upload, "load", aDetails.upload);
    setupRequestEvent(aReq.upload, "loadend", aDetails.upload);
    setupRequestEvent(aReq.upload, "progress", aDetails.upload);
    setupRequestEvent(aReq.upload, "timeout", aDetails.upload);
  }

  aReq.mozBackgroundRequest = !!aDetails.mozBackgroundRequest;

  // See #1945, #2008 - part 2/3.
  /*
  let safeUrlTmp = new this.wrappedContentWin.URL(aSafeUrl);
  var headersArr = [];
  var authorization = {
    "contrains": false,
    "method": "Basic",
    "password": "",
    "string": "Authorization",
    "user": "",
  };
  let authenticationComponent = Cc["@mozilla.org/network/http-auth-manager;1"]
      .getService(Ci.nsIHttpAuthManager);
  var authorizationRegexp = new RegExp(
      "^\\s*" + authorization.method + "\\s*([^\\s]+)\\s*$", "i");

  if (aDetails.headers) {
    var headers = aDetails.headers;

    for (var prop in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, prop)) {
        headersArr.push({
          "prop": prop,
          "value": headers[prop],
        });
        if (prop.toString().toLowerCase()
            == authorization.string.toLowerCase()) {
          let authorizationValue = headers[prop].match(authorizationRegexp);
          if (authorizationValue) {
            authorizationValue = atob(authorizationValue[1]);
            let authorizationUserPassword = authorizationValue.match(
                AUTHORIZATION_USER_PASSWORD_REGEXP);
            if (authorizationUserPassword) {
              authorization.contrains = true;
              authorization.user = authorizationUserPassword[1];
              authorization.password = authorizationUserPassword[2];
            }
          }
        }
      }
    }
  }

  if ((authorization.user || authorization.password)
      || (aDetails.user || aDetails.password)) {
    authenticationComponent.setAuthIdentity(
        safeUrlTmp.protocol,
        safeUrlTmp.hostname,
        (safeUrlTmp.port || ""),
        ((authorization.contrains)
          ? authorization.method : ""),
        "",
        "",
        "",
        (authorization.user
          || aDetails.user || ""),
        (authorization.password
          || aDetails.password || ""));
  } else {
    let authorizationDomain = {};
    let authorizationUser = {};
    let authorizationPassword = {};
    try {
      authenticationComponent.getAuthIdentity(
          safeUrlTmp.protocol,
          safeUrlTmp.hostname,
          (safeUrlTmp.port || ""),
          "",
          "",
          "",
          authorizationDomain,
          authorizationUser,
          authorizationPassword);
      aDetails.user = authorizationUser.value || "";
      aDetails.password = authorizationPassword.value || "";
    } catch (e) {
      // Ignore.
    }
  }
  */

  // See #2423.
  // http://bugzil.la/1275746
  try {
    aReq.open(aDetails.method, aSafeUrl,
        !aDetails.synchronous, aDetails.user || "", aDetails.password || "");
  } catch (e) {
    throw new this.wrappedContentWin.Error(
        "GM_xmlhttpRequest():"
        + "\n" + aDetails.url + "\n" + e,
        this.fileURL, null);
  }

  // Pale Moon 27.2.x-
  // https://github.com/MoonchildProductions/Pale-Moon/pull/968
  if ((aDetails.mozAnon || aDetails.anonymous) && !aReq.mozAnon) {
    aReq.channel.loadFlags |= Ci.nsIRequest.LOAD_ANONYMOUS;
  }

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
    channel.forceAllowThirdPartyCookie = true;
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

  // Cookies - reserved for possible future use (see also #2236) - part 2/2.
  /*
  if (aDetails.cookies) {
    try {
      let _cookiesOrig = COOKIES_SERVICE.getCookieString(
          GM_util.getUriFromUrl(this.originUrl), aReq.channel);

      let _cookies = (_cookiesOrig === null) ? "" : _cookiesOrig;

      COOKIES_SERVICE.setCookieString(
          GM_util.getUriFromUrl(aSafeUrl), null, _cookies, aReq.channel);
    } catch (e) {
      throw new this.wrappedContentWin.Error(
          "GM_xmlhttpRequest():"
          + "\n" + e,
          this.fileURL, null);
    }
  }
  */

  // See #1945, #2008 - part 3/3.
  /*
  for (let i = 0, iLen = headersArr.length; i < iLen; i++) {
    aReq.setRequestHeader(headersArr[i].prop, headersArr[i].value);
  }
  */
  if (aDetails.headers) {
    let headers = aDetails.headers;

    for (let prop in headers) {
      if (Object.prototype.hasOwnProperty.call(headers, prop)) {
        aReq.setRequestHeader(prop, headers[prop]);
      }
    }
  }

  let body = aDetails.data ? aDetails.data : null;
  // See #2423.
  // http://bugzil.la/918751
  try {
    if (aDetails.binary && (body !== null)) {
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
 * Attaches a DOM event listener to aReq (or aReq.upload) for the given event
 * type, wired to call the corresponding "on<event>" callback from aDetails in
 * the content security context.
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
 *
 * responseXML is cloned into a new content-scoped Document so the script can
 * use DOM APIs on it.
 *
 * @param {Window}       aWrappedContentWin - Content window (for setTimeout/Error).
 * @param {Sandbox}      aSandbox           - Script sandbox (for Cu.cloneInto).
 * @param {string}       aFileURL           - Script URL (for Error objects).
 * @param {XMLHttpRequest|XMLHttpRequestUpload} aReq
 *   - The XHR (or upload object) to add the listener to.
 * @param {string}       aEvent             - Event name (e.g. "load", "progress").
 * @param {object}       aDetails           - GM_xmlhttpRequest details object.
 */
GM_xmlHttpRequester.prototype.setupRequestEvent = function (
    aWrappedContentWin, aSandbox, aFileURL, aReq, aEvent, aDetails) {
  // Waive Xrays so that we can read callback function properties...
  aDetails = Cu.waiveXrays(aDetails);
  var eventCallback = aDetails["on" + aEvent];
  if (!eventCallback) {
    return undefined;
  }
  if (typeof eventCallback != "function") {
    throw new aWrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.xmlhttpRequest.callbackIsNotFunction")
            .replace("%1", aDetails.url)
            .replace("%2", "on" + aEvent),
        aFileURL, null);
  }

  // ...but ensure that the callback came from a script, not content,
  // by checking that its principal equals that of the sandbox.
  let callbackPrincipal = Cu.getObjectPrincipal(eventCallback);
  if (!this.sandboxPrincipal.equals(callbackPrincipal)) {
    return undefined;
  }

  aReq.addEventListener(aEvent, function (aEvt) {
    var responseState = {
      "context": aDetails.context || null,
      "finalUrl": null,
      "lengthComputable": null,
      "loaded": null,
      "readyState": aReq.readyState,
      "response": aReq.response,
      "responseHeaders": null,
      "responseText": null,
      "responseXML": null,
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

    var responseXML = null;
    try {
      responseXML = aReq.responseXML;
    } catch (e) {
      // At least in responseType blob case, this access fails.
      // Ignore.
    }
    if (responseXML) {
      // Clone the XML object into a content-window-scoped document.
      let xmlDoc;
      try {
        xmlDoc = new aWrappedContentWin.Document();
      } catch (e) {
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
      let clone = xmlDoc.importNode(responseXML.documentElement, true);
      xmlDoc.appendChild(clone);
      responseState.responseXML = xmlDoc;
    }

    switch (aEvent) {
      case "progress":
        responseState.lengthComputable = aEvt.lengthComputable;
        responseState.loaded = aEvt.loaded;
        responseState.total = aEvt.total;
        break;
      case "error":
        break;
      default:
        if (2 > aReq.readyState) {
          break;
        }
        responseState.finalUrl = aReq.channel.URI.spec;
        responseState.responseHeaders = aReq.getAllResponseHeaders();
        responseState.status = aReq.status;
        responseState.statusText = aReq.statusText;
        break;
    }

    responseState = Cu.cloneInto({
      "context": responseState.context,
      "finalUrl": responseState.finalUrl,
      "lengthComputable": responseState.lengthComputable,
      "loaded": responseState.loaded,
      "readyState": responseState.readyState,
      "response": responseState.response,
      "responseHeaders": responseState.responseHeaders,
      "responseText": responseState.responseText,
      "responseXML": responseState.responseXML,
      "status": responseState.status,
      "statusText": responseState.statusText,
      "total": responseState.total,
    }, aSandbox, {
      "cloneFunctions": true,
      "wrapReflectors": true,
    });

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
        eventCallback.call(aDetails, responseState);
      }, 0);
  }, false);
};
