/**
 * @file editorSave.js
 * @overview Checks a save from the built-in editor (Scratchpad) before
 * anything is written, and keeps a new script a draft until its first save.
 *
 * A new script opens as a draft: its template in a file outside
 * gm_scripts, not installed.  Its first save that passes the check installs
 * it, and the editor carries on with the installed file; closing it unsaved
 * leaves nothing behind.  A save that would give a script the @name and
 * @namespace of another installed script is refused with an alert, and the
 * editor stays open with the text unsaved, so the user can fix it (issue
 * #25; Violentmonkey does the same).
 *
 * An external editor writes the file itself, so there a new script is
 * installed from its template at once, and Script.updateFromNewScript
 * catches a clash after the save instead.
 */

const EXPORTED_SYMBOLS = ["GM_editorSave"];

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

Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

// DevTools can be missing or turned off; see openInEditor.js.
try {
  Cu.import("resource://devtools/client/scratchpad/scratchpad-manager.jsm");
} catch (e) {
  // No ScratchpadManager: openDraft() leaves new scripts to the caller.
}


// Drafts live in the temp folder, not in gm_scripts, where Recover Orphans
// would take one for the folder of a lost script.
const DRAFT_DIRECTORY_NAME = GM_CONSTANTS.directoryTempName + "-new-scripts";

/**
 * @returns {nsIFile} The folder that holds new scripts' drafts (it may not
 *   exist yet).
 */
function draftDir() {
  let dir = GM_CONSTANTS.directoryService
      .get(GM_CONSTANTS.directoryServiceTempName, Ci.nsIFile);
  dir.append(DRAFT_DIRECTORY_NAME);

  return dir;
}

/**
 * @param {string} aPath - A file path.
 * @returns {?nsIFile} The file at aPath, or null for an empty or bad path.
 */
function fileFromPath(aPath) {
  if (!aPath) {
    return null;
  }
  try {
    let file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(aPath);
    return file;
  } catch (e) {
    return null;
  }
}

/**
 * @param {string} aPath - The file an editor saves to.
 * @returns {boolean} Whether it is a new script's draft: a file in a folder
 *   of its own in draftDir().
 */
function isDraft(aPath) {
  let file = fileFromPath(aPath);
  try {
    return !!file && file.parent.parent.equals(draftDir());
  } catch (e) {
    return false;
  }
}

/**
 * Deletes a draft (with its folder) once it is installed, or when its
 * editor closes unsaved.  Anything that isn't a draft is left alone.
 *
 * @param {string} aPath - The editor's file.
 * @returns {void}
 */
function removeDraft(aPath) {
  if (!isDraft(aPath)) {
    return undefined;
  }
  try {
    let dir = fileFromPath(aPath).parent;
    if (dir.exists()) {
      dir.remove(true);
    }
  } catch (e) {
    // A leftover in the temp folder; nothing reads it.
  }
}

/**
 * Opens a new script's template in Scratchpad as a draft.
 *
 * @param {string} aSource - The template, already filled in.
 * @param {string} aName   - The script's @name, for the file name.
 * @returns {boolean} false when an external editor is set or Scratchpad
 *   isn't available: the caller then installs the template itself.
 */
function openDraft(aSource, aName) {
  if (GM_util.getEditor() || (typeof ScratchpadManager == "undefined")) {
    return false;
  }

  // A folder of its own keeps the file name exact: createUnique on a file
  // would make "a.user.js" "a.user-1.js", and Scratchpad would no longer
  // treat it as a script.
  let file;
  try {
    file = GM_util.getTempDir(draftDir());
    file.append(cleanFilename(aName, GM_CONSTANTS.fileScriptName)
        + GM_CONSTANTS.fileScriptExtension);
  } catch (e) {
    return false;
  }
  // Only Scratchpad's Revert reads the file: the template is its "saved"
  // text.  The editor gets the text directly.
  GM_util.writeToFile(aSource, file, function () {});
  try {
    ScratchpadManager.openScratchpad({
      "filename": file.path,
      "text": aSource,
      "saved": true,
    });
  } catch (e) {
    removeDraft(file.path);
    return false;
  }

  return true;
}

/**
 * Reads a string from greasemonkey.properties, with an English fallback
 * for locales that don't have it yet.
 *
 * @param {string} aKey      - The string's key.
 * @param {string} aFallback - The en-US text.
 * @returns {string}
 */
function localeString(aKey, aFallback) {
  try {
    return GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties).GetStringFromName(aKey);
  } catch (e) {
    return aFallback;
  }
}

/**
 * Explains a refused save: the problem, then that nothing was written.
 *
 * @param {string} aProblem - What is wrong.
 * @returns {string} The alert text.
 */
function notSaved(aProblem) {
  return aProblem + "\n\n" + localeString("error.script.notSaved",
      "The script was not saved. Fix this, then save again.");
}

/**
 * Decides whether an editor may save aText to aPath.
 *
 * Only new scripts' drafts and installed scripts' files are checked; any
 * other file saves as usual.  A draft must parse cleanly, because its save
 * installs it.  Neither may take the @name and @namespace of another
 * installed script: the save would either install a second script with
 * that id or leave an installed one running code that no longer matches
 * its own metadata.
 *
 * @param {string} aPath - The file the editor saves to.
 * @param {string} aText - The text it would write.
 * @returns {{draft: boolean, script: ?Script, problem: ?string,
 *     warnings: string[]}}
 *   draft: aPath is a new script's draft; script: the installed script
 *   whose file aPath is; problem: the alert for a refused save, or null;
 *   warnings: the parser's, about lines it ignores (a save goes ahead).
 */
function check(aPath, aText) {
  let draft = isDraft(aPath);
  let config = GM_util.getService().config;
  let script = draft ? null : scriptForPath(aPath);
  if (!draft && !script) {
    return {"draft": false, "script": null, "problem": null, "warnings": []};
  }

  let result = {"draft": draft, "script": script, "problem": null,
    "warnings": []};
  // The same base URL updateModifiedScripts parses an edit with.
  let parsed = parse(aText,
      script ? GM_util.getUriFromUrl(script.downloadURL) : null);
  if (!parsed) {
    result.problem = notSaved(
        localeString("error.parsingScript", "Could not parse script:")
        + "\n" + localeString("error.unknown", "Unknown error."));
    return result;
  }
  result.warnings = parsed.parseWarnings.concat();
  if (draft && parsed.parseErrors.length) {
    result.problem = notSaved(
        localeString("error.parsingScript", "Could not parse script:")
        + "\n" + parsed.parseErrors.join("\n"));
  } else if ((!script || (parsed.id != script.id))
      && config.installIsUpdate(parsed)) {
    // Functions, so a "$" in a name is taken literally.
    result.problem = notSaved(localeString("error.script.duplicateInstalled",
        "Error: Another script with @name: \"%1\" and @namespace: \"%2\" "
        + "is already installed.\nThese values must be unique.")
        .replace("%1", function () { return parsed.name; })
        .replace("%2", function () { return parsed.namespace; }));
  }

  return result;
}

/**
 * @param {string} aPath - A file path.
 * @returns {?Script} The installed script whose file it is.
 */
function scriptForPath(aPath) {
  let file = fileFromPath(aPath);
  if (!file) {
    return null;
  }
  return GM_util.getService().config.scripts.find(function (aScript) {
    try {
      return aScript.file.equals(file);
    } catch (e) {
      return false;
    }
  }) || null;
}

const GM_editorSave = {
  "check": check,
  "isDraft": isDraft,
  "notSaved": notSaved,
  "openDraft": openDraft,
  "removeDraft": removeDraft,
  "scriptForPath": scriptForPath,
};
