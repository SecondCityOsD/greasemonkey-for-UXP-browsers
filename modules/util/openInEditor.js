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

// Pale Moon and Basilisk both ship Scratchpad at this resource path.
// The try/catch is required because Scratchpad lives in DevTools, and a
// user with DevTools disabled would otherwise fail the module load.
try {
  Cu.import("resource://devtools/client/scratchpad/scratchpad-manager.jsm");
} catch (e) {
  // ScratchpadManager will be undefined; openInEditor() falls through
  // to the configured external editor in that case.
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
      // No built-in editor (Scratchpad/DevTools unavailable on this build) and
      // none configured.  Explain before throwing the user into a bare file
      // picker, then let them choose a local text editor.
      let msg;
      try {
        msg = GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmBrowserProperties)
            .GetStringFromName("editor.noBuiltInChoose");
      } catch (e2) {
        msg = "This browser has no built-in script editor available. Please "
            + "choose a local text editor (for example Notepad, or a code "
            + "editor such as VS Code) to open user scripts with.";
      }
      GM_util.alert(msg);
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
