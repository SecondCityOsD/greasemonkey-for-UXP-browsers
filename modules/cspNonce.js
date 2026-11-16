/**
 * @file cspNonce.js
 * @overview Finds the CSP nonce a page allows for its <script> and <style>
 *   elements, so the page-mode script injector, GM_addStyle and
 *   GM_addElement can give their elements a matching nonce attribute on
 *   sites with nonce-based CSPs (GitHub, Google search results, most modern
 *   news sites).
 *
 * Why nonce extraction:
 *   Without it, `injectScriptIntoPage()` falls back to sandbox mode on
 *   any CSP-blocked page (detected via the test-element probe).  For
 *   scripts that EXPLICITLY want page context (@inject-into page), the
 *   sandbox fallback changes semantics and often breaks the script
 *   silently.  Mirroring Violentmonkey's
 *   src/background/utils/preinject.js CSP_RE pattern extracts the
 *   nonce the page already authorised and lets our element slip
 *   through the same gate.
 *
 * How it works:
 *   1. Subscribe to "http-on-examine-response" /
 *      "-cached-response" / "-merged-response" topics — same ones
 *      responseObserver.js uses for its CSP-override path, but here
 *      we *read* the header rather than mutate it.
 *   2. Filter to TYPE_DOCUMENT / TYPE_SUBDOCUMENT loads (subresource
 *      responses don't carry the document-level CSP).
 *   3. Parse the Content-Security-Policy header for the script and the
 *      style nonce (script-src-elem / script-src, else default-src; the
 *      same for style), and store them under the window the document
 *      loads into and its address.  That window is the load's
 *      outerWindowID for a page, its frameOuterWindowID for a frame.
 *      (The inner window id used before is 0 for a page, since its
 *      inner window doesn't exist yet, and the parent's for a frame, so
 *      no lookup ever found a nonce.)
 *   4. Drop the entry on "outer-window-destroyed", and replace it with
 *      each new document load in that window.
 *
 * `getNonceForWindow()` is the single accessor.  When the header gave
 * nothing for the document (a <meta> CSP, say), it takes the nonce from
 * the page's own nonce-carrying elements.
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


const CSP_HEADER_NAMES = [
  "content-security-policy",
  "x-content-security-policy",
];

/** The directives that govern each kind of element, most specific first. */
const NONCE_DIRECTIVES = {
  "script": ["script-src-elem", "script-src", "default-src"],
  "style": ["style-src-elem", "style-src", "default-src"],
};

/** A page's own elements that carry each kind's nonce. */
const NONCE_ELEMENT_SELECTORS = {
  "script": "script[nonce]",
  "style": "style[nonce], link[nonce]",
};

const NONCE_VALUE_REGEXP = /'nonce-([^']+)'/i;

/**
 * Outer window id -> {"url": the document's address without its #hash,
 * "script": nonce or null, "style": nonce or null}.
 *
 * @type {Map<number, object>}
 */
var gNoncesByWindowId = new Map();


/**
 * @param {string} aCspHeader - A Content-Security-Policy header (several
 *   policies may be joined with commas).
 * @param {string} aKind      - "script" or "style".
 * @returns {?string} The nonce the most specific directive for aKind
 *   allows, from the first policy that has one.
 */
function extractNonce(aCspHeader, aKind) {
  if ((typeof aCspHeader !== "string") || (aCspHeader.length === 0)) {
    return null;
  }
  let policies = aCspHeader.split(",");
  for (let i = 0; i < policies.length; i++) {
    let directives = {};
    policies[i].split(";").forEach(function (aDirective) {
      let parts = aDirective.trim().split(/\s+/);
      let name = parts.shift().toLowerCase();
      if (name && !(name in directives)) {
        directives[name] = parts.join(" ");
      }
    });
    let names = NONCE_DIRECTIVES[aKind];
    for (let j = 0; j < names.length; j++) {
      if (names[j] in directives) {
        // The first directive present governs; a nonce elsewhere doesn't
        // count for it.
        let match = NONCE_VALUE_REGEXP.exec(directives[names[j]]);
        if (match) {
          return match[1];
        }
        break;
      }
    }
  }
  return null;
}


/**
 * Records the nonces of a page or frame response under its window.
 *
 * @param {nsISupports} aSubject - The channel.
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
  let outerWindowId;
  if (type === Ci.nsIContentPolicy.TYPE_DOCUMENT) {
    outerWindowId = loadInfo.outerWindowID;
  } else if (type === Ci.nsIContentPolicy.TYPE_SUBDOCUMENT) {
    outerWindowId = loadInfo.frameOuterWindowID;
  } else {
    return;
  }
  if (!outerWindowId) {
    return;
  }

  let entry = {
    "script": null,
    "style": null,
    "url": channel.URI.specIgnoringRef,
  };
  for (let i = 0; i < CSP_HEADER_NAMES.length; i++) {
    let value;
    try {
      value = channel.getResponseHeader(CSP_HEADER_NAMES[i]);
    } catch (e) {
      // Header not present — try the next variant.
      continue;
    }
    entry.script = entry.script || extractNonce(value, "script");
    entry.style = entry.style || extractNonce(value, "style");
  }

  // Each document load replaces what an earlier one in the window left
  // (a redirect's last response is the one that counts).
  if (entry.script || entry.style) {
    gNoncesByWindowId.set(outerWindowId, entry);
  } else {
    gNoncesByWindowId["delete"](outerWindowId);
  }
}

function onOuterWindowDestroyed(aSubject) {
  try {
    let outerWindowId = aSubject
        .QueryInterface(Ci.nsISupportsPRUint64).data;
    gNoncesByWindowId["delete"](outerWindowId);
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
      case "outer-window-destroyed":
        onOuterWindowDestroyed(aSubject);
        break;
    }
  },
};

Services.obs.addObserver(cspObserver, "http-on-examine-response", false);
Services.obs.addObserver(cspObserver, "http-on-examine-cached-response", false);
Services.obs.addObserver(cspObserver, "http-on-examine-merged-response", false);
Services.obs.addObserver(cspObserver, "outer-window-destroyed", false);


/**
 * Returns the CSP nonce an element of aKind needs in aContentWin's
 * document, or null when its policy has none (or there is no policy).
 *
 * @param {Window} aContentWin
 * @param {string} [aKind="script"] - "script" or "style".
 * @returns {?string}
 */
function getNonceForWindow(aContentWin, aKind) {
  let kind = (aKind === "style") ? "style" : "script";
  if (!aContentWin) {
    return null;
  }
  let doc;
  let outerWindowId;
  try {
    doc = aContentWin.document;
    outerWindowId = aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils).outerWindowID;
  } catch (e) {
    return null;
  }
  if (!doc) {
    return null;
  }

  // The header's, when it was for this very document (not one this
  // window showed before).
  let entry = gNoncesByWindowId.get(outerWindowId);
  if (entry && (entry.url === String(doc.documentURI).replace(/#.*$/, ""))
      && entry[kind]) {
    return entry[kind];
  }

  // Otherwise the page's own: an element of that kind with a nonce.
  try {
    let element = doc.querySelector(NONCE_ELEMENT_SELECTORS[kind]);
    let nonce = element ? element.getAttribute("nonce") : null;
    return nonce || null;
  } catch (e) {
    return null;
  }
}
