// ==UserScript==
// @name        GM Smoke 13 — @grant none
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @grant none removes the GM_* surface from the
//              sandbox.  Without explicit grants, GM_* must NOT be
//              defined.  This is what scripts that just want page
//              access (no GM APIs) rely on.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       none
// @run-at      document-end
// ==/UserScript==

var hasGM      = (typeof GM_setValue !== "undefined");
var hasGMObj   = (typeof GM         !== "undefined");
var verdict    = (!hasGM && !hasGMObj) ? "PASS" : "FAIL";
console.log("[GM-SMOKE-13] " + verdict
    + " — @grant none; GM_setValue visible: " + hasGM
    + ", GM visible: " + hasGMObj
    + " (both should be false)");
