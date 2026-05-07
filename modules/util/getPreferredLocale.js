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
  // Historical note: pre-cleanup, this had a Firefox 54+ fallback to
  // mozIOSPreferences for cases where Services.locale.getLocale-
  // ComponentForUserAgent had been removed
  // (http://bugzil.la/1337551, http://bugzil.la/1344901).  UXP browsers
  // (Pale Moon 28+, Basilisk current) keep getLocaleComponentForUserAgent,
  // so the fallback was unreachable and was removed.  The remaining
  // try/catch is a defensive safety net only — if the call somehow
  // throws on a future UXP build we fall back to the useragent.locale
  // pref rather than failing the whole module load.
  let matchOS = Services.prefs.getBoolPref("intl.locale.matchOS");

  if (matchOS) {
    try {
      return Services.locale.getLocaleComponentForUserAgent();
    } catch (e) {
      // Defensive only; not expected on UXP.  Fall through.
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
