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
 * Parses, downloads dependencies for, installs, and opens a script given its source text.
 * @param {string} aSource - The raw Greasemonkey script source text.
 * @param {Function} [aCallback] - Optional callback invoked after successful installation.
 * @returns {void}
 */
function installScriptFromSource(aSource, aCallback) {
  var remoteScript = new RemoteScript();
  var script = parse(aSource);
  var tempFileName = cleanFilename(script.name, GM_CONSTANTS.fileScriptName)
      + GM_CONSTANTS.fileScriptExtension;
  var tempFile = GM_util.getTempFile(remoteScript._tempDir, tempFileName);

  GM_util.writeToFile(aSource, tempFile, function () {
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
        return undefined;
      }
      remoteScript.install();
      GM_util.openInEditor(script);
      if (aCallback) {
        aCallback();
      }
    });
  });
}
