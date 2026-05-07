// ==UserScript==
// @name        GM Smoke 14 — GM.* polyfill (GM4 promise-based)
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves the GM.* Promise wrapper works.  Same operation
//              as test 05, but via the GM4 async surface.  Today this
//              is built by string-eval (sandbox.js evalAPI2Polyfill).
//              Phase 7 replaces it with a real chrome-side GM object —
//              this test should keep passing across that change.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       GM_setValue
// @grant       GM_getValue
// @run-at      document-end
// ==/UserScript==

(async function () {
    try {
        var stamp = Date.now();
        await GM.setValue("polyfill_test", stamp);
        var got = await GM.getValue("polyfill_test");
        var verdict = (got === stamp) ? "PASS" : "FAIL";
        console.log("[GM-SMOKE-14] " + verdict
            + " — GM.* polyfill set/get round-trip: wrote=" + stamp
            + " read=" + got);
    } catch (e) {
        console.log("[GM-SMOKE-14] FAIL — exception: " + e);
    }
})();
