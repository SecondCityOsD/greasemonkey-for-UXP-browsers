/**
 * @file cspNonce.js
 * @overview Extracts CSP `script-src 'nonce-…'` values from HTTP
 *   document responses so the page-mode script injector can attach a
 *   matching nonce to its injected `<script>` elements — letting
 *   userscripts run in page context on sites with strict nonce-based
 *   CSPs (GitHub, Google search results, most modern news sites).
 *
 * Why nonce extraction:
 *   Without it, `injectScriptIntoPage()` falls back to sandbox mode on
 *   any CSP-blocked page (detected via the test-element probe).  For
 *   scripts that EXPLICITLY want page context (@inject-into page or
 *   @grant none), the sandbox fallback changes semantics and often
 *   breaks the script silently.  Mirroring Violentmonkey's
 *   src/background/utils/preinject.js CSP_RE pattern extracts the
 *   nonce the page already authorised and lets our `<script>` slip
 *   through the same gate.
 *
 * How it works:
 *   1. Subscribe to "http-on-examine-response" /
 *      "-cached-response" / "-merged-response" topics — same ones
 *      responseObserver.js uses for its CSP-override path, but here
 *      we *read* the header rather than mutate it.
 *   2. Filter to TYPE_DOCUMENT / TYPE_SUBDOCUMENT loads (subresource
 *      responses don't carry the document-level CSP).
 *   3. Parse the Content-Security-Policy header for the first
 *      script-src / script-src-elem / default-src directive that
 *      contains a `'nonce-XYZ'` source expression, and store XYZ
 *      keyed by the response's nsILoadInfo.innerWindowID.
 *   4. Clean up the entry on the "inner-window-destroyed" topic so
 *      the map can't grow without bound across long sessions.
 *
 * The exported `getNonceForWindow()` is the single accessor —
 * scriptInjector.js calls it just before constructing each `<script>`
 * element and sets the nonce attribute when a value is returned.
 *
 * Limitations:
 *   - `<meta http-equiv="Content-Security-Policy">` nonces aren't
 *     extracted.  The meta-equiv form rarely uses nonces (nonces are
 *     typically header-only because they need to be unpredictable per
 *     response), so the coverage gap is small in practice.
 *   - CSPs added mid-load via dynamic `<meta>` injection aren't tracked.
 */

"use strict";

const EXPORTED_SYMBOLS = ["getNonceForWindow"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");


/**
 * The CSP header names UXP browsers may emit.  Standards-compliant
 * builds use `content-security-policy`; some older Pale Moon / Firefox
 * fork versions also recognise the legacy `x-` prefixed variant.
 */
const CSP_HEADER_NAMES = [
  "content-security-policy",
  "x-content-security-policy",
];

/**
 * Matches each script-source directive that could carry a nonce.
 * `script-src` is the canonical one; `script-src-elem` overrides it
 * for element-injected scripts (and is what we actually care about);
 * `default-src` is the fallback when neither of the above is set.
 *
 * Implemented as a global flag regex so we can iterate every match
 * via exec() / lastIndex.
 */
const SCRIPT_SRC_DIRECTIVE_REGEXP =
    /(?:^|[;,])\s*(?:script-src(?:-elem)?|default-src)\s+([^;,]+)/gi;

/**
 * Captures the nonce value inside `'nonce-…'`.  The CSP grammar
 * restricts nonces to base64-url-safe characters, but we accept any
 * non-quote run defensively (the platform will validate the actual
 * match when it enforces CSP).
 */
const NONCE_VALUE_REGEXP = /'nonce-([^']+)'/i;

/**
 * Map<innerWindowID, nonce>.  Populated by the response observer;
 * read by scriptInjector via getNonceForWindow().  Entries are dropped
 * when their inner window is destroyed.
 *
 * Inner-window IDs are 64-bit but JS Numbers handle them fine here
 * — they're only used as Map keys, never arithmetic.
 *
 * @type {Map<number, string>}
 */
var gNonceByWindowId = new Map();


/**
 * Extracts the first nonce value from a CSP header string, or null
 * if no script-source directive carries one.  Walks every relevant
 * directive so that a header like `default-src 'self'; script-src
 * 'nonce-abc'` returns "abc" rather than stopping at default-src.
 *
 * @param {string} aCspHeader
 * @returns {string|null}
 */
function extractNonce(aCspHeader) {
  if (typeof aCspHeader !== "string" || aCspHeader.length === 0) {
    return null;
  }
  // Reset the regex's lastIndex — the regex is module-scoped and may
  // have been left mid-iteration by a previous call.
  SCRIPT_SRC_DIRECTIVE_REGEXP.lastIndex = 0;
  let m;
  while ((m = SCRIPT_SRC_DIRECTIVE_REGEXP.exec(aCspHeader))) {
    let directiveValue = m[1];
    let nonceMatch = NONCE_VALUE_REGEXP.exec(directiveValue);
    if (nonceMatch) {
      return nonceMatch[1];
    }
  }
  return null;
}


/**
 * Per-response handler: pulls the CSP header off the channel,
 * extracts any nonce, and caches it under the load's inner-window ID.
 * Silent on every error path — a missing header / unsupported channel
 * type is the common case and should not produce console noise.
 *
 * @param {nsISupports} aSubject - The nsIHttpChannel being observed.
 */
function onExamineResponse(aSubject) {
  let channel;
  try {
    channel = aSubject.QueryInterface(Ci.nsIHttpChannel);
  } catch (e) {
    return;
  }
  let loadInfo = channel.loadInfo;
  if (!loadInfo) {
    return;
  }
  let type = loadInfo.externalContentPolicyType
      ? loadInfo.externalContentPolicyType
      : loadInfo.contentPolicyType;
  if (type !== Ci.nsIContentPolicy.TYPE_DOCUMENT
      && type !== Ci.nsIContentPolicy.TYPE_SUBDOCUMENT) {
    return;
  }
  let innerWindowId = loadInfo.innerWindowID;
  if (!innerWindowId) {
    return;
  }

  let nonce = null;
  for (let i = 0; i < CSP_HEADER_NAMES.length; i++) {
    let value;
    try {
      value = channel.getResponseHeader(CSP_HEADER_NAMES[i]);
    } catch (e) {
      // Header not present — try the next variant.
      continue;
    }
    nonce = extractNonce(value);
    if (nonce) {
      break;
    }
  }

  if (nonce) {
    gNonceByWindowId.set(innerWindowId, nonce);
  }
}

/**
 * Cleanup handler for the "inner-window-destroyed" topic.  Drops the
 * cached nonce for the destroyed window so the map stays bounded.
 *
 * @param {nsISupports} aSubject - nsISupportsPRUint64 carrying the ID.
 */
function onInnerWindowDestroyed(aSubject) {
  try {
    let innerWindowId = aSubject
        .QueryInterface(Ci.nsISupportsPRUint64).data;
    gNonceByWindowId["delete"](innerWindowId);
  } catch (e) {
    // Subject didn't carry an ID — nothing to do.
  }
}


const cspObserver = {
  "observe": function (aSubject, aTopic, aData) {
    switch (aTopic) {
      case "http-on-examine-response":
      case "http-on-examine-cached-response":
      case "http-on-examine-merged-response":
        onExamineResponse(aSubject);
        break;
      case "inner-window-destroyed":
        onInnerWindowDestroyed(aSubject);
        break;
    }
  },
};

Services.obs.addObserver(cspObserver, "http-on-examine-response", false);
Services.obs.addObserver(cspObserver, "http-on-examine-cached-response", false);
Services.obs.addObserver(cspObserver, "http-on-examine-merged-response", false);
Services.obs.addObserver(cspObserver, "inner-window-destroyed", false);


/**
 * Returns the cached CSP nonce for the given content window's current
 * inner-document, or null if the document's response carried no
 * script-source nonce.  Safe to call at any point after document
 * creation; will simply return null on torn-down windows.
 *
 * @param {Window} aContentWin
 * @returns {string|null}
 */
function getNonceForWindow(aContentWin) {
  if (!aContentWin) {
    return null;
  }
  let innerWindowId;
  try {
    let winUtils = aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils);
    innerWindowId = winUtils.currentInnerWindowID;
  } catch (e) {
    return null;
  }
  if (!innerWindowId) {
    return null;
  }
  return gNonceByWindowId.get(innerWindowId) || null;
}
