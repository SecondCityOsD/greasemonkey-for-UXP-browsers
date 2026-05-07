// ==UserScript==
// @name        GM Smoke 07 — unsafeWindow
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves unsafeWindow exposes the page-context global so a
//              script can poke at things the page itself can see.
//              After load, open the *Web Console* (NOT Browser Console)
//              for runner.html and type:   __GM_SMOKE_07__
//              You should see "hello".
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       unsafeWindow
// @run-at      document-end
// ==/UserScript==

unsafeWindow.__GM_SMOKE_07__ = "hello";
console.log("[GM-SMOKE-07] PASS — set unsafeWindow.__GM_SMOKE_07__='hello'"
    + " (verify from Web Console: type __GM_SMOKE_07__)");
