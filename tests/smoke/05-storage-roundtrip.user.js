// ==UserScript==
// @name        GM Smoke 05 — storage round-trip
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves GM_setValue / GM_getValue persist across reloads.
//              The counter increments on each load.  After 3 reloads the
//              console should show: 1, 2, 3.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-end
// ==/UserScript==

var n = GM_getValue("counter", 0);
GM_setValue("counter", n + 1);
console.log("[GM-SMOKE-05] PASS — counter=" + (n + 1) + " (reload to verify increment)");
