/**
 * @file prompt.js
 * @overview Provides alert()/confirm()/prompt() functions for opening
 * dialogs with predefined (default) dialog title.
 * alert(null, ...)/confirm(null, ...)/prompt(null, ...) can be used in XPCOM
 * module/component scope where "window" object does not exist.
 */

const EXPORTED_SYMBOLS = ["prompt"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

// Cache the prompt service at module load.
const PROMPT_SERVICE = Cc["@mozilla.org/embedcomp/prompt-service;1"]
    .getService(Ci.nsIPromptService);

const prompt = {
// Because alert is not defined in component/module scope.
/**
 * Displays a modal alert dialog with a given or the Greasemonkey handler name
 * as title.
 * @param {object} wnd - The parent window for the dialog; if null - active browser window.
 * @param {string} aMsg - The message text to display in the dialog.
 * @param {string} aTitle - The dialog title text (optional)
 * @returns {void}
 */
  alert: function (wnd, aMsg, aTitle) {
    PROMPT_SERVICE
    .alert( wnd
          , arguments.length > 2 ? aTitle : GM_CONSTANTS.info.scriptHandler
          , arguments.length > 1 ? aMsg : ""
          );
  },

/**
 * Displays a modal confirmation dialog with a given or the Greasemonkey
 * handler name as title.
 * @param {object} wnd - The parent window for the dialog; if null - active browser window.
 * @param {string} aMsg - The message text to display in the alert dialog.
 * @param {string} aTitle - The alert dialog title text (optional)
 * @returns {boolean}
 */
  confirm: function (wnd, aMsg, aTitle) {
    return PROMPT_SERVICE
           .confirm( wnd
                   , arguments.length > 2 ? aTitle : GM_CONSTANTS.info.scriptHandler
                   , arguments.length > 1 ? aMsg : ""
                   );
  },

/**
 * Displays a modal prompt dialog with a given or the Greasemonkey
 * handler name as title.
 * @param {object} wnd - The parent window for the dialog; if null - active browser window.
 * @param {string} aMsg - The message text to display in the dialog
 * @param {string} aDefVal - The default value for the dialog field (optional)
 * @param {string} aTitle - The dialog title text (optional)
 * @returns {string OR null}
 */
  prompt: function (wnd, aMsg, aDefVal, aTitle) {
    var val, ret;
    val = arguments.length > 2 ? { value: aDefVal } : {};
    ret = PROMPT_SERVICE
          .prompt( wnd
                 , arguments.length > 3 ? aTitle : GM_CONSTANTS.info.scriptHandler
                 , arguments.length > 1 ? aMsg : ""
                 , val
                 , null, {}
                 );
    return ret ? val.value : null;
  }
}