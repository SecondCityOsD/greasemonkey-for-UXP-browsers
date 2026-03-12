/**
 * @file setEditor.js
 * @overview Allows the user to select an external editor executable via a
 * file-picker dialog, or resets to Scratchpad mode when passed a truthy value.
 */

const EXPORTED_SYMBOLS = ["setEditor"];

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

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Sets the external editor preference or resets to Scratchpad mode.
 * When aScratchpad is truthy, removes the editor preference (enabling Scratchpad).
 * Otherwise, prompts the user to choose an executable file via a file picker.
 * @param {boolean} aScratchpad - If truthy, clears the editor preference and uses Scratchpad.
 * @returns {boolean} True if an editor was successfully configured or cleared, false if the user cancelled or chose a non-executable.
 */
function setEditor(aScratchpad) {
  if (aScratchpad) {
    GM_prefRoot.remove("editor");
    return true;
  }

  // Ask the user to choose a new editor.
  // Sometimes users get confused and pick a non-executable file,
  // so we set this up in a loop
  // so that if they do that we can give them an error and try again.
  while (true) {
    let filePicker = Cc["@mozilla.org/filepicker;1"]
        .createInstance(Ci.nsIFilePicker);

    filePicker.init(
        GM_util.getBrowserWindow(),
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmBrowserProperties)
            .GetStringFromName("editor.prompt"),
        Ci.nsIFilePicker.modeOpen);
    filePicker.appendFilters(Ci.nsIFilePicker.filterApps);
    if (GM_util.getEnvironment().osWindows) {
      filePicker.appendFilter("*.cmd", "*.cmd");
    }
    
    let editor = GM_util.getEditor();
    if (editor) {
      filePicker.defaultString = editor.leafName;
      filePicker.displayDirectory = editor.parent;
    }

    if (filePicker.show() != Ci.nsIFilePicker.returnOK) {
      // The user canceled.
      return false;
    }

    if (filePicker.file.exists() && filePicker.file.isExecutable()) {
      GM_prefRoot.setValue("editor", filePicker.file.path);
      return true;
    } else {
      GM_util.alert(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("editor.pleasePickExecutable"));
      return false;
    }
  }
}
