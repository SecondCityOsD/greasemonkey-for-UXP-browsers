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

Cu.import("chrome://greasemonkey-modules/content/ipcScript.js");
Cu.import("chrome://greasemonkey-modules/content/menuCommand.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/sync.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const DIRECTORY_TEMP = GM_CONSTANTS.directoryService
    .get(GM_CONSTANTS.directoryServiceTempName, Ci.nsIFile);

var gGreasemonkeyVersion = "unknown";
var gStartupHasRun = false;

/////////////////////// Component-global Helper Functions //////////////////////

function shutdown(aService) {
  // Closes every per-script SQLite Back this session opened.  Pre-cleanup
  // this was a method on the service backed by service.scriptValStores;
  // ownership of that registry moved into modules/storageBack.js so the
  // shutdown is now a one-line module call.
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

  // The four greasemonkey:scriptVal-* mm listeners that used to live
  // here were the parent-process handlers for storageFront's RPCs.
  // After Phase 4d collapsed the front/back into a single module
  // (modules/storageBack.js), no script ever sends those messages, so
  // the listeners were unreachable code and were removed.

  // The five greasemonkey:* ppmm listeners that used to live here
  // (scripts-update, broadcast-script-updates, script-install,
  // script-open-folder, url-is-temp-file) were the parent-side
  // handlers for cpmm.sendAsyncMessage / sendSyncMessage calls in
  // installPolicy.js, options.js, content/newScript.js,
  // content/browser.js, and modules/ipcScript.js.  Phases 4c, 4d,
  // and 4e replaced every one of those senders with direct calls
  // into the service or into IPCScript, so the listeners are
  // unreachable code and were removed.

  Services.mm.loadFrameScript(
      "chrome://greasemonkey/content/frameScript.js", true);

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
  // UXP single-process: the only consumer of the script list is the
  // module-private gScripts inside ipcScript.js, which lives in the
  // same JS runtime as this service.  Push the fresh snapshot directly
  // — no cpmm round-trip, no initialProcessData write.  Pre-cleanup
  // this method also did Services.ppmm.broadcastAsyncMessage; that
  // hop existed only because the parent process couldn't reach
  // content-process module state without IPC.
  IPCScript.update(this.scriptUpdateData());
};

// Pre-cleanup, this file maintained service.scriptValStores (a registry
// of per-script SQLite Back instances) along with closeAllScriptValStores,
// getStoreByScriptId, handleScriptValMsg (the cpmm RPC dispatch) and the
// gRemoteCacheTracker / remoteCached / invalidateRemoteValueCaches helpers
// used to broadcast value-invalidate messages to other processes.
//
// All of that machinery lived in service of the storageFront ↔ storageBack
// IPC bus.  Phase 4d collapsed front + back into a single module
// (modules/storageBack.js) that owns its own registry; the cpmm bus is no
// longer needed on UXP single-process.  The ~85 lines of code that lived
// here are gone.  Shutdown delegates to closeAllStorageBacks() (see top of
// this file).

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
