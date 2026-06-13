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

Cu.import("chrome://greasemonkey-modules/content/backupScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/updateScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const EDITOR_PATH_DEFAULT = "[Scratchpad]";

// Folder chosen via Browse… but not yet persisted — written to the
// backup.auto.folder pref only when the dialog is accepted, so Cancel
// discards it like every other control here.
var GM_pickedBackupFolder = null;

function GM_getEditor() {
  let editor = GM_util.getEditor();
  let value = editor ? editor.path : EDITOR_PATH_DEFAULT;

  let element = document.getElementById("editor-path");
  element.value = value;
  element.setAttribute("tooltiptext", value);
}

function GM_loadOptions() {
  let intervalUpdatesInDays = parseInt(
      GM_prefRoot.getValue("update.intervalDays"), 10);
  intervalUpdatesInDays =
      (isNaN(intervalUpdatesInDays) || (intervalUpdatesInDays < 0))
          ? 1
          : Math.min(intervalUpdatesInDays, 365);
  document.getElementById("interval-update-value")
      .value = intervalUpdatesInDays;
  document.getElementById("secure-update")
      .checked = GM_prefRoot.getValue("requireSecureUpdates");
  document.getElementById("disable-update")
      .checked = GM_prefRoot.getValue("requireDisabledScriptsUpdates");
  document.getElementById("timeout-update")
      .checked = GM_prefRoot.getValue("requireTimeoutUpdates");
  let timeoutUpdatesInSeconds = GM_prefRoot.getValue("timeoutUpdatesInSeconds");
  timeoutUpdatesInSeconds = isNaN(parseInt(timeoutUpdatesInSeconds, 10))
      ? GM_CONSTANTS.scriptUpdateTimeoutDefault
      : parseInt(timeoutUpdatesInSeconds, 10);
  timeoutUpdatesInSeconds = (((timeoutUpdatesInSeconds >= 1)
      && (timeoutUpdatesInSeconds <= GM_CONSTANTS.scriptUpdateTimeoutMax))
      ? timeoutUpdatesInSeconds : GM_CONSTANTS.scriptUpdateTimeoutDefault);
  let timeoutUpdateValueElm = document.getElementById("timeout-update-value");
  timeoutUpdateValueElm
      .setAttribute("min", GM_CONSTANTS.scriptUpdateTimeoutMin);
  timeoutUpdateValueElm
      .setAttribute("max", GM_CONSTANTS.scriptUpdateTimeoutMax);
  timeoutUpdateValueElm
      .value = timeoutUpdatesInSeconds;
  document.getElementById("check-sync")
      .setAttribute("label", document.getElementById("check-sync")
      .getAttribute("label")
      .replace(new RegExp("Pale\\s*Moon", "i"), (
      (Services.appinfo.ID == GM_CONSTANTS.browserIDFirefox)
          ? "Firefox"
          : "$&")
      ));
  document.getElementById("check-sync")
      .checked = GM_prefRoot.getValue("sync.enabled");
  GM_getEditor();
  document.getElementById("global-excludes")
      .pages = GM_util.getService().config.globalExcludes;
  document.getElementById("new-script-remove-unused")
      .checked = GM_prefRoot.getValue("newScript.removeUnused");
  document.getElementById("new-script-template")
      .value = GM_prefRoot.getValue("newScript.template");
  let intervalBackupsInDays = parseInt(
      GM_prefRoot.getValue("backup.auto.intervalDays"), 10);
  intervalBackupsInDays =
      (isNaN(intervalBackupsInDays) || (intervalBackupsInDays < 0))
          ? 0
          : Math.min(intervalBackupsInDays, 365);
  document.getElementById("interval-backup-value")
      .value = intervalBackupsInDays;
  let backupsToKeep = parseInt(GM_prefRoot.getValue("backup.auto.keep"), 10);
  backupsToKeep = (isNaN(backupsToKeep) || (backupsToKeep < 1))
      ? 5
      : Math.min(backupsToKeep, 50);
  document.getElementById("backup-keep-value").value = backupsToKeep;
  GM_getBackupFolder();
}

// Shows the effective backup destination: the pending Browse… choice, the
// saved pref, or the default <profile>/gm_backups (display only — nothing
// is created until a backup actually runs).
function GM_getBackupFolder() {
  let value = GM_pickedBackupFolder
      || GM_prefRoot.getValue("backup.auto.folder", "");
  if (!value) {
    let dir = GM_util.scriptDir().parent;
    dir.append("gm_backups");
    value = dir.path;
  }
  let element = document.getElementById("backup-folder");
  element.value = value;
  element.setAttribute("tooltiptext", value);
}

function GM_saveOptions() {
  let intervalUpdatesInDays = parseInt(
      document.getElementById("interval-update-value").value, 10);
  intervalUpdatesInDays =
      (isNaN(intervalUpdatesInDays) || (intervalUpdatesInDays < 0))
          ? 1
          : Math.min(intervalUpdatesInDays, 365);
  GM_prefRoot.setValue("update.intervalDays", intervalUpdatesInDays);
  GM_prefRoot.setValue("requireSecureUpdates",
      !!document.getElementById("secure-update").checked);
  GM_prefRoot.setValue("requireDisabledScriptsUpdates",
      !!document.getElementById("disable-update").checked);
  GM_prefRoot.setValue("requireTimeoutUpdates",
      !!document.getElementById("timeout-update").checked);
  GM_prefRoot.setValue("timeoutUpdatesInSeconds",
      parseInt(document.getElementById("timeout-update-value").value, 10));
  GM_prefRoot.setValue("sync.enabled",
      !!document.getElementById("check-sync").checked);
  GM_util.getService().config.globalExcludes =
      document.getElementById("global-excludes").pages;
  GM_prefRoot.setValue("newScript.removeUnused",
      !!document.getElementById("new-script-remove-unused").checked);
  GM_prefRoot.setValue("newScript.template",
      document.getElementById("new-script-template").value);
  let intervalBackupsInDays = parseInt(
      document.getElementById("interval-backup-value").value, 10);
  intervalBackupsInDays =
      (isNaN(intervalBackupsInDays) || (intervalBackupsInDays < 0))
          ? 0
          : Math.min(intervalBackupsInDays, 365);
  GM_prefRoot.setValue("backup.auto.intervalDays", intervalBackupsInDays);
  let backupsToKeep = parseInt(
      document.getElementById("backup-keep-value").value, 10);
  backupsToKeep = (isNaN(backupsToKeep) || (backupsToKeep < 1))
      ? 5
      : Math.min(backupsToKeep, 50);
  GM_prefRoot.setValue("backup.auto.keep", backupsToKeep);
  if (GM_pickedBackupFolder !== null) {
    GM_prefRoot.setValue("backup.auto.folder", GM_pickedBackupFolder);
  }
  // Changes to global excludes should be active after tab reload.
  // UXP is single-process, so we call broadcastScriptUpdates() directly
  // on the service to fan out the refreshed script descriptors to all
  // content frames without any IPC round-trip.
  GM_util.getService().broadcastScriptUpdates();
}

// "Check now" button: run an update sweep immediately (stamps
// update.lastCheck).  Results surface through the regular pipeline —
// notifications and about:addons; per-script settings are honoured.
function GM_checkUpdatesNow() {
  GM_updateScheduler.checkNow();
  // Brief disable as click feedback; the sweep itself is asynchronous.
  let button = document.getElementById("update-check-now");
  button.disabled = true;
  setTimeout(function () {
    button.disabled = false;
  }, 3000);
}

// Folder picker for automatic backups; held in GM_pickedBackupFolder
// until the dialog is accepted.
function GM_backupBrowseFolder() {
  let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(window, "Greasemonkey", Ci.nsIFilePicker.modeGetFolder);
  let result = fp.show();
  if ((result != Ci.nsIFilePicker.returnOK) || !fp.file) {
    return;
  }
  GM_pickedBackupFolder = fp.file.path;
  GM_getBackupFolder();
}

// "Back up now": writes a dated zip immediately — to the pending Browse…
// choice when there is one, else the saved folder — and stamps
// backup.auto.lastBackup on success.
function GM_backupNow() {
  let button = document.getElementById("backup-now");
  button.disabled = true;
  let folder = GM_pickedBackupFolder
      || GM_prefRoot.getValue("backup.auto.folder", "")
      || null;
  GM_backupScheduler.backupNow(folder, function (aOk, aPath, aErr) {
    button.disabled = false;
    if (aOk) {
      alert(GM_backupString("backup.now.done", "Backup written to:\n%1")
          .replace("%1", aPath));
    } else {
      alert(GM_backupString("backup.failed", "Backup operation failed.\n\n%1")
          .replace("%1", aErr || ""));
    }
  });
}

// gmAddons.properties string with an inline English fallback (missing
// .properties keys in a locale are non-fatal, unlike DTD entities).
function GM_backupString(aKey, aFallback) {
  try {
    return Cc["@mozilla.org/intl/stringbundle;1"]
        .getService(Ci.nsIStringBundleService)
        .createBundle("chrome://greasemonkey/locale/gmAddons.properties")
        .GetStringFromName(aKey);
  } catch (e) {
    return aFallback;
  }
}
