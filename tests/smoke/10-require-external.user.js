// ==UserScript==
// @name        GM Smoke 10 — @require external
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @require fetches an external library at install
//              time and concatenates it ahead of the script body.  The
//              library is then on disk; reloads do NOT re-fetch.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @require     https://code.jquery.com/jquery-3.7.1.slim.min.js
// @grant       none
// @run-at      document-end
// ==/UserScript==

// jQuery is loaded into the sandbox scope by @require, so $ and jQuery
// are available as locals (NOT on window — sandbox is content-isolated).
var typeofDollar = typeof $;
var typeofJQuery = typeof jQuery;
var verdict = (typeofDollar === "function" && typeofJQuery === "function") ? "PASS" : "FAIL";
console.log("[GM-SMOKE-10] " + verdict + " — $: " + typeofDollar
    + " jQuery: " + typeofJQuery + " (both should be 'function')");
