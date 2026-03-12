/**
 * @file constants.js
 * @overview Central constants and shared XPCOM service singletons for
 *   Greasemonkey.  Every other module imports this file to access the
 *   GM_CONSTANTS object rather than instantiating services on their own.
 *
 * Key sections of GM_CONSTANTS:
 *   addonAPI          - ordered list of all GM_* API names exposed to scripts
 *   addonAPIConversion - maps GM3-style names to their GM4/GM.* equivalents
 *   addonAPI*Prefix   - "GM_" (GM3) and "GM." (GM4) namespace prefixes
 *   browser IDs       - GUIDs for Firefox and Pale Moon used in compatibility checks
 *   directory/file    - paths, masks, and extensions for script storage
 *   installScript*    - HTTP status codes that affect the install flow
 *   XPCOM singletons  - pre-fetched service instances (ioService, versionChecker, …)
 */

"use strict";

const EXPORTED_SYMBOLS = ["GM_CONSTANTS"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Global constants object.  Imported as a singleton by every other module.
 * All XPCOM service references are resolved once at module-load time so that
 * callers never need to call getService() themselves.
 *
 * @namespace
 */
const GM_CONSTANTS = {
  /** All GM_* API names that can appear in a script's @grant list. */
  "addonAPI": [
    "GM_addStyle",
    "GM_cookie",
    "GM_deleteValue",
    "GM_download",
    "GM_getResourceText",
    "GM_getResourceURL",
    "GM_getValue",
    // This is a separate API:
    // "GM_info",
    "GM_listValues",
    "GM_log",
    "GM_notification",
    "GM_openInTab",
    "GM_registerMenuCommand",
    "GM_setClipboard",
    "GM_setValue",
    "GM_windowClose",
    "GM_windowFocus",
    "GM_xmlhttpRequest",
    "unsafeWindow",
  ],
  /**
   * Maps GM3 API names to their non-obvious GM4/GM.* counterparts.
   * Names that follow the simple GM_foo → GM.foo pattern are handled
   * automatically and do NOT need an entry here.
   */
  "addonAPIConversion": {
    "GM_getResourceURL": "getResourceUrl",
    "GM_xmlhttpRequest": "xmlHttpRequest",
  },
  /** Namespace prefix for the legacy GM3 API (e.g. "GM_getValue"). */
  "addonAPIPrefix1": "GM_",
  /** Namespace prefix for the modern GM4 Promise API (e.g. "GM.getValue"). */
  "addonAPIPrefix2": "GM.",
  "addonGUID": "greasemonkeyforpm@janekptacijarabaci",
  "addonInstallPolicyClassDescription": "Greasemonkey Script Install Policy",
  "addonInstallPolicyClassID": Components.ID(
      "c03c575c-e87e-4a0f-b88d-8be090116a0c"),
  "addonInstallPolicyContractID":
      "@greasemonkey.mozdev.org/greasemonkey-install-policy;1",
  "addonScriptProtocolClassDescription":
      'Protocol handler for "greasemonkey-script:"',
  "addonScriptProtocolClassID": Components.ID(
      "20d898f3-2fb8-4b3a-b8c7-7ad6c2c48598"),
  "addonScriptProtocolContractID":
      "@mozilla.org/network/protocol;1?name=greasemonkey-script",
  "addonScriptProtocolScheme": "greasemonkey-script",
  "addonScriptProtocolSeparator": "/",
  "addonServiceClassDescription": "GM_GreasemonkeyService",
  "addonServiceClassID": Components.ID(
      "{77bf3650-1cd6-11da-8cd6-0800200c9a66}"),
  "addonServiceContractID": "@greasemonkey.mozdev.org/greasemonkey-service;1",
  "addonVersionFirst": "0.0",
  /** Application GUID for Firefox — used in browser-type checks. */
  "browserIDFirefox": "{ec8030f7-c20a-464f-9b0e-13a3a9e97384}",
  /** Application GUID for Pale Moon — used in browser-type checks. */
  "browserIDPalemoon": "{8de7fcbb-c55c-4fbe-bfc5-fc555c87dbc4}",
  // "dataUserScriptHosting": "data:text/html;base64,PCFET0NUWVBFIGh0bWw+DQo8aHRtbCBsYW5nPSJlbiI+DQo8aGVhZD4NCjxtZXRhIGh0dHAtZXF1aXY9ImNvbnRlbnQtdHlwZSIgY29udGVudD0idGV4dC9odG1sO2NoYXJzZXQ9dXRmLTgiIC8+DQo8dGl0bGU+VXNlciBTY3JpcHQgSG9zdGluZzwvdGl0bGU+DQo8bWV0YSBuYW1lPSJyZXNvdXJjZS10eXBlIiBjb250ZW50PSJkb2N1bWVudCIgLz4NCjxzdHlsZSB0eXBlPSJ0ZXh0L2NzcyI+DQpib2R5IHsNCiAgYmFja2dyb3VuZC1jb2xvcjogI2ZmZmZmZjsNCiAgY29sb3I6ICMwMDAwMDA7DQp9DQpoMSwgaDIsIGgzLCBoNCwgaDUsIGg2IHsNCiAgYm9yZGVyLWJvdHRvbTogMXB4IHNvbGlkICNhYWFhYWE7DQogIGZvbnQtd2VpZ2h0OiBub3JtYWw7DQogIHBhZGRpbmc6IDA7DQp9DQpoMSB7DQogIG1hcmdpbjogMDsNCn0NCmgyLCBoMywgaDQsIGg1LCBoNiB7DQogIG1hcmdpbi1ib3R0b206IDA7DQogIG1hcmdpbi10b3A6IDFlbTsNCn0NCnAgew0KICBtYXJnaW4tYm90dG9tOiAwOw0KICBtYXJnaW4tdG9wOiAwLjVlbTsNCiAgcGFkZGluZzogMDsNCn0NCjwvc3R5bGU+DQo8L2hlYWQ+DQo8Ym9keT4NCjxoMT5Vc2VyIFNjcmlwdCBIb3N0aW5nPC9oMT4NCjxoMj5HaXN0PC9oMj4NCjxwPjxhIGhyZWY9Imh0dHBzOi8vZ2lzdC5naXRodWIuY29tLyI+aHR0cHM6Ly9naXN0LmdpdGh1Yi5jb20vPC9hPjwvcD4NCjxoMj5HcmVhc3kgRm9yazwvaDI+DQo8cD48YSBocmVmPSJodHRwczovL2dyZWFzeWZvcmsub3JnLyI+aHR0cHM6Ly9ncmVhc3lmb3JrLm9yZy88L2E+PC9wPg0KPGgyPk9wZW5Vc2VySlMub3JnPC9oMj4NCjxwPjxhIGhyZWY9Imh0dHBzOi8vb3BlbnVzZXJqcy5vcmcvIj5odHRwczovL29wZW51c2VyanMub3JnLzwvYT48L3A+DQo8L2JvZHk+DQo8L2h0bWw+DQo=",
  "directoryMask": parseInt("750", 8),
  "directoryScriptsName": "gm_scripts",
  "directoryService": Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties),
  "directoryServiceScriptName": "ProfD",
  "directoryServiceTempName": "TmpD",
  "directoryTempName": "gm-temp",
  "fileMask": parseInt("640", 8),
  "fileProtocolHandler": Cc["@mozilla.org/network/protocol;1?name=file"]
      .getService(Ci.nsIFileProtocolHandler),
  "fileMetaExtension": ".meta.js",
  "fileProtocolSchemeRegexp": "^file:\/\/",
  "fileScriptCharset": "UTF-8",
  "fileScriptContentTypeNoRegexp": "^text/(x|ht)ml",
  "fileScriptDBExtension": ".db",
  "fileScriptExtension": ".user.js",
  "fileScriptExtensionRegexp": "\\.user\\.js",
  "fileScriptName": "gm-script",
  /** Static data injected into GM_info.scriptHandler. */
  "info": {
    "scriptHandler": "Greasemonkey",
  },
  /**
   * Tests whether an HTTP status code should be considered a hard failure
   * for script installation (i.e. the install should be abandoned).
   *
   * "Bad" statuses: 429 Too Many Requests, 500 Internal Server Error,
   * and anything ≥ 999.
   *
   * @param {number}  aStatus - HTTP status code to test.
   * @param {boolean} aBool   - When true, returns true for bad statuses;
   *                            when false, returns true for good statuses.
   * @returns {boolean}
   */
  "installScriptBadStatus": function (aStatus, aBool) {
    let statusEqual = [429, 500];     
    let statusGreaterThanAndEqual = 999;
    if (aBool) {
      return GM_util.inArray(statusEqual, aStatus)
          || (statusGreaterThanAndEqual <= aStatus);
    } else {
      return !GM_util.inArray(statusEqual, aStatus)
          && !(statusGreaterThanAndEqual <= aStatus);
    }
  },
  // The HTTP status code: 
  // client errors
  // (401 "Authorization Required", 407 "Proxy Authentication Required")
  "installScriptReloadStatus": [401, 407],
  "ioService": Cc["@mozilla.org/network/io-service;1"]
      .getService(Ci.nsIIOService),
  "jsSubScriptLoader": Cc["@mozilla.org/moz/jssubscript-loader;1"]
      .getService(Ci.mozIJSSubScriptLoader),
  "localeGmAddonsProperties":
      "chrome://greasemonkey/locale/gmAddons.properties",
  "localeGmBrowserProperties":
      "chrome://greasemonkey/locale/gmBrowser.properties",
  "localeGreasemonkeyProperties":
      "chrome://greasemonkey/locale/greasemonkey.properties",
  "localeStringBundle": Cc["@mozilla.org/intl/stringbundle;1"]
      .getService(Ci.nsIStringBundleService),
  "script": {
   "includeAll": "*",
  },
  "scriptAddonType": "greasemonkey-user-script",
  // Backward compatibility.
  // "scriptIDSuffix": "@greasespot.net",
  "scriptIDSuffix": "@greasemonkeyforpm",
  "scriptParseBOM": "\u00EF\u00BB\u00BF",
  "scriptParseBOMArray": [0xEF, 0xBB, 0xBF],
  "scriptParseMetaRegexp": "// ==UserScript==([\\s\\S]*?)^// ==/UserScript==",
  "scriptPrefsUrl": "chrome://greasemonkey/content/scriptPrefs.xul",
  // Seconds.
  "scriptUpdateTimeoutDefault": 45,  
  "scriptUpdateTimeoutMax": 60,
  "scriptUpdateTimeoutMin": 1,
  "scriptType": "user-script",
  "scriptViewID": "addons://list/greasemonkey-user-script",
  "scriptViewIDDetailPrefix": "addons://detail/",
  "urlAboutAllRegexp": "^about:(blank|reader)",
  "urlAboutPart1": "about:blank",
  "urlAboutPart1Regexp": "^about:blank",
  "urlAboutPart2Regexp": "^about:reader",
  "urlUserPassStripRegexp": "(://)([^:/]+)(:[^@/]+)?@",
  "versionChecker": Cc["@mozilla.org/xpcom/version-comparator;1"]
      .getService(Ci.nsIVersionComparator),
  "xulAppInfo": Cc["@mozilla.org/xre/app-info;1"]
      .getService(Ci.nsIXULAppInfo),
  "xulRuntime": Cc["@mozilla.org/xre/app-info;1"]
      .getService(Ci.nsIXULRuntime),
};
