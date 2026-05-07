// ==UserScript==
// @name        GM Smoke 12 — GM_registerMenuCommand
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves GM_registerMenuCommand adds an entry to the GM
//              toolbar context menu.  Click the toolbar icon after load:
//              the menu should contain "Smoke Test 12".  Click it; the
//              console should log "[GM-SMOKE-12] invoked".
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       GM_registerMenuCommand
// @run-at      document-end
// ==/UserScript==

GM_registerMenuCommand("Smoke Test 12", function () {
    console.log("[GM-SMOKE-12] invoked — menu callback fired");
});
console.log("[GM-SMOKE-12] PASS — registered (click GM toolbar to verify entry)");
