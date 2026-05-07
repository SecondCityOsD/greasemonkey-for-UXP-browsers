// ==UserScript==
// @name        GM Smoke 02 — @match glob
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @match wildcard URL pattern matching.  Should run
//              ONLY on runner.html.  Should NOT run on runner-other.html
//              or runner-excluded.html (they don't match the pattern).
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       none
// @run-at      document-end
// ==/UserScript==

console.log("[GM-SMOKE-02] PASS — @match wildcard matched on " + location.pathname);
