// ==UserScript==
// @name        GM Smoke 01 — trivial injection
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves the sandbox creates and executes basic JS.
// @match       *://*/runner.html
// @match       *://*/runner-frame.html
// @match       file:///*runner.html*
// @match       file:///*runner-frame.html*
// @grant       none
// @run-at      document-end
// ==/UserScript==

console.log("[GM-SMOKE-01] PASS — sandbox executes basic JS");
