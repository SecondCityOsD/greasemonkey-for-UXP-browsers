// ==UserScript==
// @name        GM Smoke 04 — @exclude
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @exclude takes priority over @match / @include.
//              Should fire on runner.html.  Should NOT fire on
//              runner-excluded.html (matched by @match but excluded).
// @match       *://*/runner.html
// @match       *://*/runner-excluded.html
// @match       file:///*runner.html*
// @match       file:///*runner-excluded.html*
// @exclude     *runner-excluded.html*
// @grant       none
// @run-at      document-end
// ==/UserScript==

console.log("[GM-SMOKE-04] PASS — should NOT appear on runner-excluded.html (path: "
    + location.pathname + ")");
