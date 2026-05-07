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


const EDITOR_PATH_DEFAULT = "[Scratchpad]";

function GM_getEditor() {
  let editor = GM_util.getEditor();
  let value = editor ? editor.path : EDITOR_PATH_DEFAULT;

  let element = document.getElementById("editor-path");
  element.value = value;
  element.setAttribute("tooltiptext", value);
}

function GM_loadOptions() {
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
}

function GM_saveOptions() {
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
  // Changes to global excludes should be active after tab reload.
  // Pre-cleanup, this was a Services.cpmm.sendAsyncMessage(
  // "greasemonkey:broadcast-script-updates") which round-tripped to
  // the parent process so the GreasemonkeyService could re-broadcast
  // its script descriptors to all content frames.  UXP is single-
  // process, so the round trip is unnecessary; calling the method
  // directly fans out the same updates without IPC.
  GM_util.getService().broadcastScriptUpdates();
}
