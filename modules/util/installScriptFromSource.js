/**
 * @file installScriptFromSource.js
 * @overview Parses raw script source text, writes it to a temp file, downloads
 * any @require dependencies, installs the script, and opens it in the editor.
 */

const EXPORTED_SYMBOLS = ["installScriptFromSource"];

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

Cu.import("chrome://greasemonkey-modules/content/GM_notification.js");
Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Parses, downloads dependencies for, installs, and (optionally) opens a
 * script given its source text.
 *
 * @param {string}   aSource              - Raw Greasemonkey script source text.
 * @param {Function} [aCallback]          - Invoked after install completes.
 *   Signature: callback(err?) — passed null/undefined on success, an Error
 *   instance on failure.  Pre-Phase-7c the callback was only fired on
 *   success and never received an argument; the new signature is
 *   backward-compatible (existing 0-arg callbacks still work).
 * @param {object}   [aOptions]
 * @param {boolean}  [aOptions.skipEditor=false] - When true, do NOT open
 *   the freshly-installed script in the configured editor.  Set by the
 *   Recover-Orphans batch UI so it doesn't spawn N editor windows in a
 *   row when reinstalling a stack of recovered scripts.
 * @returns {void}
 */
function installScriptFromSource(aSource, aCallback, aOptions) {
  let opts = aOptions || {};
  let skipEditor = !!opts.skipEditor;

  var remoteScript;
  var script;
  try {
    remoteScript = new RemoteScript();
    script = parse(aSource);
  } catch (e) {
    if (aCallback) {
      aCallback(e);
    }
    return undefined;
  }
  var tempFileName = cleanFilename(script.name, GM_CONSTANTS.fileScriptName)
      + GM_CONSTANTS.fileScriptExtension;
  var tempFile = GM_util.getTempFile(remoteScript._tempDir, tempFileName);

  GM_util.writeToFile(aSource, tempFile, function (aWriteErr) {
    if (aWriteErr) {
      if (aCallback) {
        aCallback(aWriteErr);
      }
      return undefined;
    }
    remoteScript.setScript(script, tempFile);
    remoteScript.download(function (aSuccess) {
      if (!aSuccess) {
        let notificationOptions = {
          "persistence": -1,
          "persistWhileVisible": true,
        };
        GM_notification(
            GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.couldNotDownloadDependencies")
                .replace("%1", remoteScript.errorMessage),
            "greasemonkey-dependency-download-failed", notificationOptions);
        if (aCallback) {
          aCallback(new Error(
              "Could not download dependencies: "
              + (remoteScript.errorMessage || "")));
        }
        return undefined;
      }
      remoteScript.install();
      if (!skipEditor) {
        GM_util.openInEditor(script);
      }
      if (aCallback) {
        aCallback();
      }
    });
  });
}
