// ==UserScript==
// @name        GM Smoke 03 — @include glob
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @include URL-pattern matching (the original
//              Greasemonkey style).  The trailing wildcard differentiates
//              this from a strict @match — @include is more permissive.
// @include     *runner.html*
// @grant       none
// @run-at      document-end
// ==/UserScript==

console.log("[GM-SMOKE-03] PASS — @include matched on " + location.href);
