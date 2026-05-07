// ==UserScript==
// @name        GM Smoke 15 — GM_cookie / GM.cookie
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves GM.cookie.list returns the page's cookies.
//
//              EXPECTED RESULT TODAY: this test may FAIL or be a no-op,
//              because GM_cookie ships behind the
//              extensions.greasemonkey.api.GM_cookie pref (default
//              FALSE) and the implementation is a third-party polyfill
//              loaded via thirdParty/GM_cookie.js.  To exercise it,
//              flip the pref to true in about:config first.
//
//              EXPECTED RESULT POST-PHASE-7: this test should PASS by
//              default.  Phase 7 replaces the polyfill with a native
//              chrome-side implementation backed by Services.cookies
//              (nsICookieManager).
// @match       *://*/runner.html
// @grant       GM_cookie
// @run-at      document-end
// ==/UserScript==

try {
    if (typeof GM === "undefined" || !GM.cookie || typeof GM.cookie.list !== "function") {
        console.log("[GM-SMOKE-15] FAIL — GM.cookie.list not available"
            + " (set extensions.greasemonkey.api.GM_cookie=true in about:config,"
            + " or wait for Phase 7 native implementation)");
    } else {
        GM.cookie.list({}, function (cookies, error) {
            if (error) {
                console.log("[GM-SMOKE-15] FAIL — list error: " + error);
            } else {
                console.log("[GM-SMOKE-15] PASS — got "
                    + (cookies ? cookies.length : 0) + " cookies");
            }
        });
    }
} catch (e) {
    console.log("[GM-SMOKE-15] FAIL — exception: " + e);
}
