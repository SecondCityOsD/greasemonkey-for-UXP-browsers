// ==UserScript==
// @name        GM Smoke 06 — GM_xmlhttpRequest
// @namespace   gm-uxp-smoke
// @version     1.0.0
// @description Proves GM_xmlhttpRequest can do a cross-origin request and
//              that @connect is honored.  Requires httpbin.org to be
//              reachable; if it's down on test day this test is moot.
// @match       *://*/runner.html
// @match       file:///*runner.html*
// @grant       GM_xmlhttpRequest
// @connect     httpbin.org
// @run-at      document-end
// ==/UserScript==

GM_xmlhttpRequest({
    method: "GET",
    url: "https://httpbin.org/get?gm-smoke=06",
    timeout: 15000,
    onload: function (response) {
        console.log("[GM-SMOKE-06] PASS — xhr status=" + response.status
            + " bytes=" + (response.responseText || "").length);
    },
    onerror: function (error) {
        console.log("[GM-SMOKE-06] FAIL — error", error);
    },
    ontimeout: function () {
        console.log("[GM-SMOKE-06] FAIL — timeout (httpbin.org reachable?)");
    },
});
