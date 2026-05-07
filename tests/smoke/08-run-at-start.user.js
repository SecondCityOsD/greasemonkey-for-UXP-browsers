// ==UserScript==
// @name        GM Smoke 08 — @run-at document-start
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @run-at document-start fires before the document
//              is parsed.  document.readyState should be "loading"
//              (or occasionally "interactive" on very fast loads).
//              Anything else means document-start didn't fire early
//              enough.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       none
// @run-at      document-start
// ==/UserScript==

var state = document.readyState;
var verdict = (state === "loading" || state === "interactive") ? "PASS" : "FAIL";
console.log("[GM-SMOKE-08] " + verdict + " — readyState=" + state
    + " (expect loading or interactive)");
