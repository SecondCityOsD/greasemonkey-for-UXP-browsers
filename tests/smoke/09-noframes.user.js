// ==UserScript==
// @name        GM Smoke 09 — @noframes
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @noframes skips iframe execution.  Should log ONCE
//              (top-level runner.html), not twice (iframe).  If you see
//              two log lines and one of them shows inFrame=true,
//              @noframes is broken.
// @match       *://*/runner.html
// @match       *://*/runner-frame.html
// @match       file:///*runner.html*
// @match       file:///*runner-frame.html*
// @noframes
// @grant       none
// @run-at      document-end
// ==/UserScript==

var inFrame = (window.top !== window);
console.log("[GM-SMOKE-09] " + (inFrame ? "FAIL" : "PASS")
    + " — running, inFrame=" + inFrame
    + " (expect: ONE PASS line, no FAIL line)");
