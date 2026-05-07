// ==UserScript==
// @name        GM Smoke 11 — @resource
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves @resource fetches at install time and is
//              retrievable via GM_getResourceText at run time.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @resource    smokebin https://httpbin.org/robots.txt
// @grant       GM_getResourceText
// @run-at      document-end
// ==/UserScript==

try {
    var text = GM_getResourceText("smokebin");
    var bytes = text ? text.length : 0;
    console.log("[GM-SMOKE-11] " + (bytes > 0 ? "PASS" : "FAIL")
        + " — resource bytes=" + bytes);
} catch (e) {
    console.log("[GM-SMOKE-11] FAIL — exception: " + e);
}
