/**
 * @file util.js
 * @overview Lazy-loading aggregator for all GM_util helper functions.
 *
 * Each individual utility lives in its own file under modules/util/<name>.js
 * and exports a single function with the same name as the file.
 *
 * This top-level module exposes them all as properties of the GM_util namespace
 * object using XPCOMUtils.defineLazyModuleGetter, so each sub-module is only
 * imported the first time its function is actually called.
 *
 * Usage:
 *   Cu.import("chrome://greasemonkey-modules/content/util.js");
 *   GM_util.someHelper(args);
 */

const EXPORTED_SYMBOLS = ["GM_util"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

var GM_util = {};

// Do not edit below this line. Use "util.sh" to auto-populate.
XPCOMUtils.defineLazyModuleGetter(GM_util, "alert", "chrome://greasemonkey-modules/content/util/alert.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "compareVersion", "chrome://greasemonkey-modules/content/util/compareVersion.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "emptyElm", "chrome://greasemonkey-modules/content/util/emptyElm.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "enqueueRemove", "chrome://greasemonkey-modules/content/util/enqueueRemove.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "fileXhr", "chrome://greasemonkey-modules/content/util/fileXhr.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getBestLocaleMatch", "chrome://greasemonkey-modules/content/util/getBestLocaleMatch.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getBinaryContents", "chrome://greasemonkey-modules/content/util/getBinaryContents.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getBrowserWindow", "chrome://greasemonkey-modules/content/util/getBrowserWindow.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getChannelFromUri", "chrome://greasemonkey-modules/content/util/getChannelFromUri.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getContents", "chrome://greasemonkey-modules/content/util/getContents.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getEditor", "chrome://greasemonkey-modules/content/util/getEditor.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getEnabled", "chrome://greasemonkey-modules/content/util/getEnabled.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getEnvironment", "chrome://greasemonkey-modules/content/util/getEnvironment.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getPreferredLocale", "chrome://greasemonkey-modules/content/util/getPreferredLocale.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getScriptSource", "chrome://greasemonkey-modules/content/util/getScriptSource.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getService", "chrome://greasemonkey-modules/content/util/getService.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getTempDir", "chrome://greasemonkey-modules/content/util/getTempDir.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getTempFile", "chrome://greasemonkey-modules/content/util/getTempFile.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getUriFromFile", "chrome://greasemonkey-modules/content/util/getUriFromFile.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "getUriFromUrl", "chrome://greasemonkey-modules/content/util/getUriFromUrl.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "hash", "chrome://greasemonkey-modules/content/util/hash.js");
// hitch.js (Function.prototype.bind polyfill, GM 1.x era) was retired
// in Phase 5a; inArray.js (Array.prototype.includes polyfill, pre-ES2016)
// was retired in Phase 5b.  UXP's SpiderMonkey has had both natives for
// years; every caller now uses .bind() / .includes() / .some() directly.
XPCOMUtils.defineLazyModuleGetter(GM_util, "installScriptFromSource", "chrome://greasemonkey-modules/content/util/installScriptFromSource.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "isGreasemonkeyable", "chrome://greasemonkey-modules/content/util/isGreasemonkeyable.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "logError", "chrome://greasemonkey-modules/content/util/logError.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "memoize", "chrome://greasemonkey-modules/content/util/memoize.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "newUserScript", "chrome://greasemonkey-modules/content/util/newUserScript.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "openInEditor", "chrome://greasemonkey-modules/content/util/openInEditor.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "parseMetaLine", "chrome://greasemonkey-modules/content/util/parseMetaLine.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "scriptDir", "chrome://greasemonkey-modules/content/util/scriptDir.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "scriptMatchesUrlAndRuns", "chrome://greasemonkey-modules/content/util/scriptMatchesUrlAndRuns.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "setEditor", "chrome://greasemonkey-modules/content/util/setEditor.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "setEnabled", "chrome://greasemonkey-modules/content/util/setEnabled.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "showInstallDialog", "chrome://greasemonkey-modules/content/util/showInstallDialog.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "sniffGrants", "chrome://greasemonkey-modules/content/util/sniffGrants.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "timeout", "chrome://greasemonkey-modules/content/util/timeout.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "uuid", "chrome://greasemonkey-modules/content/util/uuid.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "windowId", "chrome://greasemonkey-modules/content/util/windowId.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "windowIdForEvent", "chrome://greasemonkey-modules/content/util/windowIdForEvent.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "windowIsClosed", "chrome://greasemonkey-modules/content/util/windowIsClosed.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "windowIsPrivate", "chrome://greasemonkey-modules/content/util/windowIsPrivate.js");
XPCOMUtils.defineLazyModuleGetter(GM_util, "writeToFile", "chrome://greasemonkey-modules/content/util/writeToFile.js");
