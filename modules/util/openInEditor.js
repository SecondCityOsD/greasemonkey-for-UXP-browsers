/**
 * @file openInEditor.js
 * @overview Opens a user script file in the configured external editor,
 * falling back to the Scratchpad DevTools panel when no editor is set.
 */

const EXPORTED_SYMBOLS = ["openInEditor"];

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

try {
  Cu.import("resource://gre/modules/devtools/scratchpad-manager.jsm");
} catch (e) {
  try {
    Cu.import("resource://devtools/client/scratchpad/scratchpad-manager.jsm");
  } catch (e) {
    try {
      // Moved in Firefox 44
      // http://hg.mozilla.org/mozilla-central/rev/397c69fa1677
      Cu.import("resource:///modules/devtools/client/scratchpad/scratchpad-manager.jsm");
    } catch (e) {
      try {
        // Moved in Firefox 44
        // http://hg.mozilla.org/mozilla-central/rev/3b90d45a2bbc
        Cu.import("resource:///modules/devtools/scratchpad-manager.jsm");
      } catch (e) {
        // Ignore.
      }
    }
  }
}

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Opens a user script in the configured external editor or, if none is set, in Scratchpad.
 * On macOS the editor is launched via /usr/bin/open.
 * @param {object} aScript - The script object with file (nsIFile) and textContent properties.
 * @returns {void}
 * @throws {Error} Re-throws any error from launching the editor after clearing the editor preference.
 */
function openInEditor(aScript) {
  let editor = GM_util.getEditor();
  if (!editor) {
    // Without DevTools.
    try {
      ScratchpadManager.openScratchpad({
        "filename": aScript.file.path,
        "text": aScript.textContent,
        "saved": true,
      });
    } catch (e) {
      if (GM_util.setEditor(0)) {
        openInEditor(aScript);
      }
    }
    return undefined;
  }

  try {
    let args = [aScript.file.path];

    // For the Mac, wrap with a call to "open".
    if (GM_util.getEnvironment().osMac) {
      args = ["-a", editor.path, aScript.file.path];
      editor = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      editor.followLinks = true;
      editor.initWithPath("/usr/bin/open");
    }

    let process = Cc["@mozilla.org/process/util;1"]
        .createInstance(Ci.nsIProcess);
    process.init(editor);
    process.runw(false, args, args.length);
  } catch (e) {
    // Something may be wrong with the editor the user selected.
    // Remove so that next time they can pick a different one.
    GM_util.alert(GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGmBrowserProperties)
        .GetStringFromName("editor.couldNotLaunch")
        + "\n" + e);
    GM_prefRoot.remove("editor");
    throw e;
  }
}
