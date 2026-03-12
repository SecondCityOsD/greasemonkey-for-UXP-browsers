/**
 * @file getPreferredLocale.js
 * @overview Determines and caches the user's preferred locale by checking the
 * matchOS preference and falling back to the browser locale preference.
 */

const EXPORTED_SYMBOLS = ["getPreferredLocale"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


var preferredLocale = (function () {
  let matchOS = Services.prefs.getBoolPref("intl.locale.matchOS");

  if (matchOS) {
    try {
      return Services.locale.getLocaleComponentForUserAgent();
    } catch (e) {
      // Firefox 54+
      // http://bugzil.la/1337551
      // http://bugzil.la/1344901
      return Cc["@mozilla.org/intl/ospreferences;1"]
          .getService(Ci.mozIOSPreferences)
          .systemLocale;
    }
  }

  return Services.prefs.getCharPref("general.useragent.locale") || "en-US";
})();

/**
 * Returns the user's preferred locale string (e.g. "en-US"), computed once at module load time.
 * @returns {string} The preferred locale tag.
 */
function getPreferredLocale() {
  return preferredLocale;
}
