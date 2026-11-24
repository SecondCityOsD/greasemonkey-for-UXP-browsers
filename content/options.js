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

// PARKED for 3.9 (scheduled backups):
// Cu.import("chrome://greasemonkey-modules/content/backupScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/updateScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const EDITOR_PATH_DEFAULT = "[Scratchpad]";

// Preferences is modeless (GM_BrowserUI.openOptions marks its copies), so
// the browser stays usable while it's open.  The Add-ons Manager opens
// add-on options modal, though, unless browser.preferences.instantApply
// is on: such a copy hands over before it's ever shown.
if (!GM_isModelessOptions()) {
  GM_handOverToModelessOptions();
}

function GM_isModelessOptions() {
  let args = window.arguments;
  return !!(args && args[0] && args[0].modeless);
}

/**
 * Closes this modal copy and has the browser window open the modeless one
 * just after: on its own timer, which outlives this window, and once this
 * one is gone, or closing it would bring the browser back in front.
 * Without a browser window this copy just stays.
 */
function GM_handOverToModelessOptions() {
  let browserWin = Services.wm.getMostRecentWindow("navigator:browser");
  if (!browserWin || !browserWin.GM_BrowserUI) {
    return undefined;
  }
  browserWin.setTimeout(browserWin.GM_BrowserUI.openOptions, 150);
  window.close();
}

// PARKED for 3.9 (scheduled backups): GM_pickedBackupFolder plus the backup
// load/save blocks and the handlers below are disabled together with the
// Backups groupbox in options.xul and the scheduler in the service.
// var GM_pickedBackupFolder = null;

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
  // PARKED for 3.9 (scheduled backups): backup pref load removed here.

  // Localised first, so the menulist shows its item's translated label.
  GM_localizeOptions();
  document.getElementById("notify-updates")
      .checked = !GM_prefRoot.getValue("notification.muted.script.updated",
          false);
  let badgeShow = GM_prefRoot.getValue("toolbarBadge.show", "unique");
  document.getElementById("badge-show").value =
      (BADGE_SHOW_VALUES.indexOf(badgeShow) != -1) ? badgeShow : "unique";
  document.getElementById("badge-color").value = GM_badgeColor(
      GM_prefRoot.getValue("toolbarBadge.color", BADGE_COLOR_DEFAULT));
  GM_syncBadgeControls();
  document.getElementById("http-only-cookies")
      .checked = GM_prefRoot.getValue("api.GM_cookie.exposeHttpOnly", false);
  document.getElementById("download-browser-api")
      .checked = GM_prefRoot.getValue("api.GM_download.browserApi", false);
  document.getElementById("menu-auto-reload")
      .checked = GM_prefRoot.getValue("toolbarMenu.autoReload", false);
  let menuDisabled = GM_prefRoot.getValue(
      "toolbarMenu.disabledScripts", "show");
  document.getElementById("menu-disabled").value =
      (MENU_DISABLED_VALUES.indexOf(menuDisabled) != -1)
          ? menuDisabled : "show";
  // Anything else is read as the default, "page" (sandbox.js scriptRealm),
  // so it shows as that.
  document.getElementById("inject-into").value =
      (GM_prefRoot.getValue("injectInto.default", "page") == "content")
          ? "content" : "page";
}

/** How the toolbar menu can list the page's disabled scripts. */
const MENU_DISABLED_VALUES = ["show", "group", "hide"];

/** The page that explains the injection modes (the project's wiki). */
const INJECTION_MODES_HELP_URL =
    "https://github.com/SecondCityOsD/greasemonkey-for-UXP-browsers/wiki/"
    + "Injection-modes";

/** "Learn more about injection modes.": the wiki page, in a new tab. */
function GM_openInjectionModesHelp() {
  let chromeWin = GM_util.getBrowserWindow();
  if (!chromeWin) {
    return undefined;
  }
  chromeWin.gBrowser.selectedTab =
      chromeWin.gBrowser.addTab(INJECTION_MODES_HELP_URL);
  return undefined;
}

/** What the toolbar badge can count ("none" hides it), and its colour as
 *  in defaults/preferences, for a stored value that isn't #rrggbb. */
const BADGE_SHOW_VALUES = ["none", "total", "unique"];
const BADGE_COLOR_DEFAULT = "#d90000";

/** aColor when it's a #rrggbb colour, else the default. */
function GM_badgeColor(aColor) {
  return /^#[0-9a-f]{6}$/i.test(aColor)
      ? aColor.toLowerCase() : BADGE_COLOR_DEFAULT;
}

/** The colour means nothing without a badge. */
function GM_syncBadgeControls() {
  let none = document.getElementById("badge-show").value == "none";
  document.getElementById("badge-color").disabled = none;
  let label = document.getElementById("badge-color-label");
  if (none) {
    label.setAttribute("disabled", "true");
  } else {
    label.removeAttribute("disabled");
  }
}

/**
 * Labels added in 3.10 come from greasemonkey.properties, not a DTD (a
 * missing entity would break this window in the locales without it).  The
 * English in options.xul stays where a locale lacks a string.
 */
function GM_localizeOptions() {
  let bundle = null;
  try {
    bundle = GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties);
  } catch (e) {
    return undefined;
  }
  [
    ["options-tab-general", "label", "options.tab.general"],
    ["options-tab-advanced", "label", "options.tab.advanced"],
    ["notifications-caption", "label", "options.notifications"],
    ["notify-updates", "label", "options.notifyUpdates"],
    ["toolbar-button-caption", "label", "options.toolbarButton"],
    ["badge-show-label", "value", "options.badge"],
    ["badge-show-none", "label", "options.badge.none"],
    ["badge-show-total", "label", "options.badge.total"],
    ["badge-show-unique", "label", "options.badge.unique"],
    ["badge-color-label", "value", "options.badgeColor"],
    ["script-apis-caption", "label", "options.scriptApis"],
    ["http-only-cookies", "label", "options.httpOnlyCookies"],
    ["http-only-cookies", "tooltiptext", "options.httpOnlyCookies.tip"],
    ["http-only-cookies-note", null, "options.httpOnlyCookies.scriptOption"],
    ["http-only-cookies-note", "tooltiptext", "options.httpOnlyCookies.tip"],
    ["download-browser-api", "label", "options.downloadBrowserApi"],
    ["download-browser-api", "tooltiptext", "options.downloadBrowserApi.tip"],
    ["menu-auto-reload", "label", "options.menuAutoReload"],
    ["menu-disabled-label", "value", "options.menuDisabled"],
    ["menu-disabled", "tooltiptext", "options.menuDisabled.tip"],
    ["menu-disabled-show", "label", "options.menuDisabled.show"],
    ["menu-disabled-group", "label", "options.menuDisabled.group"],
    ["menu-disabled-hide", "label", "options.menuDisabled.hide"],
    ["inject-into-label", "value", "options.injectInto"],
    ["inject-into-content", "label", "options.injectInto.content"],
    ["inject-into-page", "label", "options.injectInto.page"],
    ["inject-into-help", "value", "options.injectInto.learnMore"],
  ].forEach(function ([aId, aAttribute, aKey]) {
    let text;
    try {
      text = bundle.GetStringFromName(aKey);
    } catch (e) {
      return undefined;
    }
    let element = document.getElementById(aId);
    if (aAttribute) {
      element.setAttribute(aAttribute, text);
    } else {
      element.textContent = text;
    }
  });
}

/* PARKED for 3.9 (scheduled backups): shows the effective backup
   destination (pending Browse… choice, saved pref, or default
   <profile>/gm_backups).
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
*/

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
  GM_prefRoot.setValue("notification.muted.script.updated",
      !document.getElementById("notify-updates").checked);
  GM_prefRoot.setValue("toolbarBadge.show",
      document.getElementById("badge-show").value);
  GM_prefRoot.setValue("toolbarBadge.color",
      GM_badgeColor(document.getElementById("badge-color").value));
  GM_prefRoot.setValue("api.GM_cookie.exposeHttpOnly",
      !!document.getElementById("http-only-cookies").checked);
  GM_prefRoot.setValue("api.GM_download.browserApi",
      !!document.getElementById("download-browser-api").checked);
  GM_prefRoot.setValue("toolbarMenu.autoReload",
      !!document.getElementById("menu-auto-reload").checked);
  GM_prefRoot.setValue("toolbarMenu.disabledScripts",
      document.getElementById("menu-disabled").value);
  GM_prefRoot.setValue("injectInto.default",
      document.getElementById("inject-into").value);
  // PARKED for 3.9 (scheduled backups): backup pref save removed here.
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

/* PARKED for 3.9 (scheduled backups): the Browse… / Back up now handlers
   and their string helper.  Re-enable together with the Backups groupbox
   (options.xul), the load/save blocks above, and the scheduler in
   components/greasemonkey.js.

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
*/
