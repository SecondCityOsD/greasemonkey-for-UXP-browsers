///////////////// Component-global "Constants" and "Variables" /////////////////

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
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://gre/modules/AddonManager.jsm");

// PARKED for 3.9: scheduled on-disk backups need fine-tuning before
// release.  modules/backupScheduler.js stays in the tree but is left
// unreferenced; re-enable here together with the start()/stop() calls
// below and the Backups group in the options dialog.
// Cu.import("chrome://greasemonkey-modules/content/backupScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/ipcScript.js");
Cu.import("chrome://greasemonkey-modules/content/menuCommand.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/scriptInjector.js");
Cu.import("chrome://greasemonkey-modules/content/scriptProtocol.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/sync.js");
Cu.import("chrome://greasemonkey-modules/content/updateScheduler.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

// Import installPolicy here so its nsIContentPolicy registration runs at
// chrome startup.  The module is side-effecting on import — it calls
// InstallPolicy.init() once at the bottom.
Cu.import("chrome://greasemonkey-modules/content/installPolicy.js");


const DIRECTORY_TEMP = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceTempName, Ci.nsIFile);

var gGreasemonkeyVersion = "unknown";
var gStartupHasRun = false;

/////////////////////// Component-global Helper Functions //////////////////////

function shutdown(aService) {
  // No further scheduled update sweeps once teardown begins.
  GM_updateScheduler.stop();
  // PARKED for 3.9 (see the commented import above).
  // GM_backupScheduler.stop();
  // Closes every per-script SQLite Back this session opened.  The
  // per-script registry lives inside modules/storageBack.js, so shutdown
  // is a single module call.
  closeAllStorageBacks();
}

function startup(aService) {
  if (gStartupHasRun) {
    return undefined;
  }
  gStartupHasRun = true;

  GM_CONSTANTS.jsSubScriptLoader.loadSubScript(
      "chrome://global/content/XPCNativeWrapper.js");

  GM_CONSTANTS.jsSubScriptLoader.loadSubScript(
      "chrome://greasemonkey/content/config.js");
  GM_CONSTANTS.jsSubScriptLoader.loadSubScript(
      "chrome://greasemonkey/content/thirdParty/mplUtils.js");

  // UXP is single-process: storage RPCs (modules/storageBack.js) and
  // service RPCs (script-install, script-open-folder, url-is-temp-file,
  // scripts-update, broadcast-script-updates) are dispatched as direct
  // method calls into this service or into IPCScript, so no parent-side
  // mm/ppmm listeners are registered here.

  // Register the chrome-side script-injection observers and the
  // greasemonkey-script: protocol handler.  Both startup calls are
  // idempotent.
  startScriptInjector();
  initScriptProtocol();

  // Beam down initial set of scripts.
  aService.broadcastScriptUpdates();

  // Notification is async; send the scripts again once we have our version.
  AddonManager.getAddonByID(GM_CONSTANTS.addonGUID, function (aAddon) {
    gGreasemonkeyVersion = "" + aAddon.version;
    aService.broadcastScriptUpdates();
  });

  // Beam down on updates.
  aService.config.addObserver({
    "notifyEvent": function (aScript, aEvent, aData) {
      if ([
        "cludes",
        "edit-enabled",
        "install",
        // "missing-removed",
        "modified",
        "move",
        "uninstall",
      ].some(function (e) {
        return e == aEvent;
      })) {
        aService.broadcastScriptUpdates();
      }
    }
  });

  Cu.import("chrome://greasemonkey-modules/content/requestObserver.js", {});
  Cu.import("chrome://greasemonkey-modules/content/responseObserver.js", {});

  // GM-owned periodic script-update checks (update.intervalDays pref).
  GM_updateScheduler.start();
  // PARKED for 3.9 (see the commented import above).
  // GM_backupScheduler.start();

  Services.obs.addObserver(aService, "quit-application", false);

  // Import this once, early, so that enqueued deletes can happen.
  Cu.import("chrome://greasemonkey-modules/content/util/enqueueRemove.js");
}

/////////////////////////////////// Service ////////////////////////////////////

function service() {
  this.filename = Components.stack.filename;
  this.wrappedJSObject = this;
}

////////////////////////////////// Constants ///////////////////////////////////

service.prototype.classDescription = GM_CONSTANTS.addonServiceClassDescription;
service.prototype.classID = GM_CONSTANTS.addonServiceClassID;
service.prototype.contractID = GM_CONSTANTS.addonServiceContractID;
service.prototype.QueryInterface = XPCOMUtils.generateQI([Ci.nsIObserver]);

///////////////////////////////// nsIObserver //////////////////////////////////

service.prototype.observe = function (aSubject, aTopic, aData) {
  switch (aTopic) {
    case "profile-after-change":
      startup(this);
      break;
    case "quit-application":
      shutdown(this);
      break;
  }
};

///////////////////////////// Greasemonkey Service /////////////////////////////

service.prototype._config = null;
Object.defineProperty(service.prototype, "config", {
  "get": function service_getConfig() {
    if (!this._config) {
      // First guarantee instantiation and existence.
      // So that anything, including stuff inside i.e. config._load(),
      // can call i.e. config._changed().
      this._config = new Config();
      // Then initialize.
      this._config.initialize();
    }
    return this._config;
  },
  "enumerable": true,
});

service.prototype.scriptUpdateData = function () {
  let ipcScripts = this.config.scripts.map(function (aScript) {
    return new IPCScript(aScript, gGreasemonkeyVersion);
  });
  let excludes = this.config._globalExcludes;
  return {
    "globalExcludes": excludes,
    "scripts": ipcScripts,
  };
};

service.prototype.broadcastScriptUpdates = function () {
  // UXP is single-process: the only consumer of the script list is the
  // module-private gScripts inside ipcScript.js, which lives in the same
  // JS runtime as this service.  Push the fresh snapshot directly — no
  // cpmm round-trip, no initialProcessData write.
  IPCScript.update(this.scriptUpdateData());
};

// Per-script SQLite Back registries live inside modules/storageBack.js;
// shutdown drains them via closeAllStorageBacks() (see top of this file).

service.prototype.scriptRefresh = function (aUrl, aWindowId, aBrowser) {
  if (!GM_util.getEnabled()) {
    return [];
  }
  if (!aUrl) {
    return [];
  }
  if (!GM_util.isGreasemonkeyable(aUrl)) {
    return [];
  }

  if (GM_prefRoot.getValue("enableScriptRefreshing")) {
    this.config.updateModifiedScripts("document-start", aUrl, aWindowId, aBrowser);
    this.config.updateModifiedScripts("document-end", aUrl, aWindowId, aBrowser);
    this.config.updateModifiedScripts("document-idle", aUrl, aWindowId, aBrowser);
  }
};

service.prototype.scriptInstall = function (aMessage) {
  GM_util.showInstallDialog(aMessage.data.url);
};

service.prototype.scriptOpenFolder = function (aMessage) {      
  GM_openFolder(this.config.getScriptById(aMessage.data.scriptId).file);
};

service.prototype.urlIsTempFile = function (aMessage) {
  let file;
  try {
    file = GM_CONSTANTS.fileProtocolHandler
        .getFileFromURLSpec(aMessage.data.url);
  } catch (e) {
    return false;
  }

  return DIRECTORY_TEMP.contains(file);
};

//////////////////////////// Component Registration ////////////////////////////

var NSGetFactory = XPCOMUtils.generateNSGetFactory([service]);
