/**
 * @file openScriptOptions.js
 * @overview Opens a user script's Options window (content/scriptPrefs.xul).
 */

const EXPORTED_SYMBOLS = ["openScriptOptions"];

if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/constants.js");

/**
 * The Options window's features: a non-modal, resizable top-level
 * window.  Others ("chrome,titlebar,toolbar,...,resizable,dialog=no")
 * gave a window whose corners couldn't be dragged on Pale Moon; this is
 * the recipe Pale Moon's own Page Info window uses, and "minimizable" is
 * what gets Windows to add the Minimize and Maximize buttons.
 */
const OPTIONS_WINDOW_FEATURES =
    "chrome,toolbar,dialog=no,resizable,minimizable,centerscreen";

/**
 * @param {Script|IPCScript} aScript
 * @returns {string} Its Options window's address.
 */
function optionsUrl(aScript) {
  return GM_CONSTANTS.scriptPrefsUrl + "#" + encodeURIComponent(aScript.id);
}

/**
 * Opens a script's Options window, or brings its open one to the front:
 * one window per script, from the Add-ons Manager, the toolbar menu or
 * Scratchpad alike.
 *
 * @param {Script|IPCScript} aScript
 * @returns {void}
 */
function openScriptOptions(aScript) {
  let url = optionsUrl(aScript);

  let enumerator = Services.wm.getEnumerator(null);
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    try {
      if (!win.closed && win.document && (win.document.documentURI === url)) {
        win.focus();
        return undefined;
      }
    } catch (e) {
      // Closing meanwhile: keep looking.
    }
  }

  let browserWin = Services.wm.getMostRecentWindow("navigator:browser");
  if (browserWin) {
    browserWin.openDialog(url, "_blank", OPTIONS_WINDOW_FEATURES);
  } else {
    Services.ww.openWindow(null, url, "_blank", OPTIONS_WINDOW_FEATURES, null);
  }
  return undefined;
}
