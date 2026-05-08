/**
 * @file sync.js
 * @overview Optional Firefox Sync (Weave) integration for Greasemonkey.
 *
 * If the Sync service is not present (e.g. Pale Moon without Sync), the entire
 * module exits early after the try/catch import block — nothing is registered.
 *
 * When Sync IS available, the module registers a Weave SyncEngine named
 * "Greasemonkey" that syncs installed userscripts across devices.
 *
 * Sync record fields (ScriptRecord cleartext):
 *   downloadURL  — the remote source URL of the script.
 *   enabled      — whether the script is currently enabled.
 *   id           — the script's local ID (hashed to produce the sync ID).
 *   installed    — false means "this script was uninstalled, remove it".
 *   userExcludes, userIncludes, userMatches, userOverride — per-script overrides.
 *   values       — GM_getValue storage (when sync.values pref is enabled).
 *   valuesTooBig — true if values exceeded sync.values.maxSizePerScript.
 *
 * Initialisation strategy (see bug #2335):
 *   The "weave:service:ready" observer is unreliable under e10s.  Instead,
 *   SyncServiceObserver.init() polls every 1 second until gWeave.Status.ready
 *   is true, then registers the ScriptEngine.  A guard flag (gSyncInitialized)
 *   prevents double-registration.
 *
 * The Sync service import is delayed until the engine is actually initialised
 * (see bug #1852) to avoid triggering the master password dialog at startup.
 *
 * Scripts loaded from file:// URLs are excluded from sync (not portable).
 *
 * This entire module is wrapped in an IIFE (initSync) so that all Sync-related
 * globals stay out of the module scope.
 */

const EXPORTED_SYMBOLS = [];

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

(function initSync() {

var gWeave = {};
try {
  // The files we're trying to import below don't exist in Pale Moon builds
  // without sync service, causing the import to throw.
  Cu.import("resource://services-sync/engines.js", gWeave);
  Cu.import("resource://services-sync/record.js", gWeave);
  Cu.import("resource://services-sync/status.js", gWeave);
  Cu.import("resource://services-sync/util.js", gWeave);
} catch (e) {
  // If there's no sync service, it doesn't make sense to continue.
  return undefined;
}

Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://services-crypto/utils.js");

Cu.import("chrome://greasemonkey-modules/content/miscApis.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const FILE_PROTOCOL_SCHEME_REGEXP = new RegExp(GM_CONSTANTS.fileProtocolSchemeRegexp, "");

var gSyncInitialized = false;

/**
 * Polls for Weave service readiness and registers the ScriptEngine once ready.
 * Uses a 1-second polling interval as a fallback for the unreliable
 * "weave:service:ready" observer (bug #2335).
 */
var SyncServiceObserver = {
  "init": function () {
    if (gWeave.Status.ready) {
      this.initEngine();
    } else {
      // See #2335.
      // The "weave:service:ready" observer has been identified
      // as unreliable - Electrolysis (e10s)?
      // Manually poll instead.
      GM_util.timeout(SyncServiceObserver.init.bind(SyncServiceObserver), 1000);
    }
  },

  "initEngine": function () {
    if (gSyncInitialized) {
      return undefined;
    }
    gSyncInitialized = true;

    // See #1852.
    // Delay importing the actual Sync service to prevent conflicts
    // with the master password dialog during browser startup.
    Cu.import("resource://services-sync/service.js", gWeave);

    gWeave.Service.engineManager.register(ScriptEngine);
  },

  "QueryInterface": XPCOMUtils.generateQI([Ci.nsISupportsWeakReference]),
};

/**
 * A Weave CryptoWrapper subclass representing one synced userscript.
 * The cleartext payload fields are defined via gWeave.Utils.deferGetSet below.
 *
 * @constructor
 * @param {string} aCollection - Sync collection name.
 * @param {string} aId         - Sync record ID (hashed script ID).
 */
function ScriptRecord(aCollection, aId) {
  gWeave.CryptoWrapper.call(this, aCollection, aId);
}
ScriptRecord.prototype = {
  "__proto__": gWeave.CryptoWrapper.prototype,

  "_logName": "Record.GreasemonkeyScript",
};

gWeave.Utils.deferGetSet(
    ScriptRecord, "cleartext",
    [
      "downloadURL",
      "enabled",
      "id",
      "installed",
      "userExcludes",
      "userIncludes",
      "userMatches",
      "userOverride",
      "values",
      "valuesTooBig",
    ]);

/**
 * Weave Store implementation for Greasemonkey scripts.
 * Handles create/update/remove/wipe operations driven by incoming sync records,
 * and createRecord/getAllIDs for outgoing sync.
 *
 * @constructor
 * @param {string}       aName   - Store name.
 * @param {SyncEngine}   aEngine - The owning ScriptEngine.
 */
function ScriptStore(aName, aEngine) {
  gWeave.Store.call(this, aName, aEngine);
}
ScriptStore.prototype = {
  "__proto__": gWeave.Store.prototype,

  "changeItemID": function (aOldId, aNewId) {
    dump(">>> Sync - ScriptStore.changeItemID..." + " "
        + aOldId.substr(0, 8) + " " + aNewId.substr(0, 8) + "\n");
  },

  // Incoming Sync record, create local version.
  "create": function (aRecord) {
    if (aRecord.cleartext.installed) {
      let url = aRecord.cleartext.downloadURL;
      if (!url) {
        dump("Sync - Ignoring incoming sync record with empty downloadURL."
            + "\n");
        return undefined;
      }
      if (!GM_util.getUriFromUrl(url)) {
        dump("Sync - Ignoring incoming sync record with bad downloadURL:" + "\n"
            + url + "\n");
        return undefined;
      }

      var rs = new RemoteScript(aRecord.cleartext.downloadURL);
      rs.setSilent();
      rs.download(function (aSuccess, aType) {
        if (aSuccess && (aType == "dependencies")) {
          rs.install();
          rs.script.enabled = aRecord.cleartext.enabled;
          rs.script.userExcludes = aRecord.cleartext.userExcludes;
          rs.script.userMatches = aRecord.cleartext.userMatches;
          rs.script.userIncludes = aRecord.cleartext.userIncludes;
          rs.script.userOverride = aRecord.cleartext.userOverride;
          setScriptValuesFromSyncRecord(rs.script, aRecord);
        }
      }.bind(this));
    } else {
      let script = scriptForSyncId(aRecord.cleartext.id);
      if (script) {
        GM_util.getService().config.uninstall(script);
      }
    }
  },

  /// New local item, create sync record.
  "createRecord": function (aId, aCollection) {
    let script = scriptForSyncId(aId);
    let record = new ScriptRecord();
    record.cleartext.id = aId;
    if (!script) {
      // Assume this script was not found because it was uninstalled.
      record.cleartext.enabled = false;
      record.cleartext.installed = false;
    } else {
      record.cleartext.downloadURL = script.downloadURL;
      record.cleartext.enabled = script.enabled;
      record.cleartext.installed = !script.needsUninstall;
      record.cleartext.userExcludes = script.userExcludes;
      record.cleartext.userMatches = script.userMatches;
      record.cleartext.userIncludes = script.userIncludes;
      record.cleartext.userOverride = script.userOverride;

      if (GM_prefRoot.getValue("sync.values")) {
        let storage = new GM_ScriptStorageBack(script);
        let totalSize = 0;
        let maxSize = GM_prefRoot.getValue("sync.values.maxSizePerScript");
        record.cleartext.values = {};
        record.cleartext.valuesTooBig = false;
        let names = storage.listValues();
        for (let i = 0, iLen = names.length; i < iLen; i++) {
          let name = names[i];
          let val = storage.getValue(name);
          try {
            val = JSON.parse(val);
          } catch (e) {
            dump("Sync:" + "\n" + uneval(e) + "\n");
            continue;
          }
          record.cleartext.values[name] = val;
          totalSize += name.length;
          // 4 for number / bool (no length).
          totalSize += val.length || 4;

          if (totalSize > maxSize) {
            record.cleartext.values = [];
            record.cleartext.valuesTooBig = true;
            break;
          }
        }
      }
    }

    return record;
  },

  "getAllIDs": function () {
    let syncIds = {};
    let scripts = GM_util.getService().config.scripts;
    for (let i = 0, iLen = scripts.length; i < iLen; i++) {
      let script = scripts[i];
      if (!script.downloadURL) {
        continue;
      }
      if (FILE_PROTOCOL_SCHEME_REGEXP.test(script.downloadURL)) {
        continue;
      }
      syncIds[syncId(script)] = 1;
    }

    return syncIds;
  },

  "isAddonSyncable": function (aAddon) {
    return true;
  },

  "itemExists": function (aId) {
    let script = scriptForSyncId(aId);
    return !!script;
  },

  "remove": function (aRecord) {
    let script = scriptForSyncId(aRecord.cleartext.id);
    if (script) {
      GM_util.getService().config.uninstall(script);
    }
  },

  "update": function (aRecord) {
    let script = scriptForSyncId(aRecord.cleartext.id);
    if (!script) {
      dump("Sync - Could not find script for record:" + "\n"
          + aRecord.cleartext + "\n");
      return undefined;
    }
    if (!aRecord.cleartext.installed) {
      GM_util.getService().config.uninstall(script);
    } else {
      script.enabled = !!aRecord.cleartext.enabled;
      script.userExcludes = aRecord.cleartext.userExcludes || [];
      script.userMatches = aRecord.cleartext.userMatches || [];
      script.userIncludes = aRecord.cleartext.userIncludes || [];
      script.userOverride = !!aRecord.cleartext.userOverride;
      setScriptValuesFromSyncRecord(script, aRecord);
    }
  },

  "wipe": function () {
    dump(">>> Sync - ScriptStore.wipe..." + "\n");
    // Delete everything!
  },
};

/**
 * Weave Tracker that watches for local script changes and marks changed
 * scripts as needing sync.  Observes the Greasemonkey config for events:
 *   - edit-enabled, install, modified, uninstall → score += 5 (high priority)
 *   - cludes, val-del, val-set                   → score += 1 (low priority)
 *
 * @constructor
 * @param {string}     aName   - Tracker name.
 * @param {SyncEngine} aEngine - The owning ScriptEngine.
 */
function ScriptTracker(aName, aEngine) {
  gWeave.Tracker.call(this, aName, aEngine);
  GM_util.getService().config.addObserver(this);
}
ScriptTracker.prototype = {
  "__proto__": gWeave.Tracker.prototype,

  "notifyEvent": function (aScript, aEvent, aData) {
    if (aEvent in {
        "edit-enabled": 1,
        "install": 1,
        "modified": 1,
        "uninstall": 1,
    }) {
      if (this.addChangedID(syncId(aScript))) {
        this.score = Math.min(100, this.score + 5);
      }
    // See #2414.
    // http://bugzil.la/1286618
    } else if (aEvent in {
      "cludes": 1,
      "val-del": 1,
      "val-set": 1,
    }) {
      if (this.addChangedID(syncId(aScript))) {
        this.score = Math.min(100, this.score + 1);
      }
    }
  },
};

/**
 * The top-level Weave SyncEngine for Greasemonkey scripts.
 * Registers itself with the Weave engine manager when the Sync service is ready.
 * Enabled state mirrors the "sync.enabled" preference and is watched for changes.
 *
 * @constructor
 */
function ScriptEngine() {
  gWeave.SyncEngine.call(this, GM_CONSTANTS.info.scriptHandler, gWeave.Service);

  this.enabled = GM_prefRoot.getValue("sync.enabled");
  GM_prefRoot.watch("sync.enabled", function () {
    this.enabled = GM_prefRoot.getValue("sync.enabled");
  }.bind(this));
}
ScriptEngine.prototype = {
  "__proto__": gWeave.SyncEngine.prototype,

  "_recordObj": ScriptRecord,
  "_storeObj": ScriptStore,
  "_trackerObj": ScriptTracker,
};

/**
 * Finds the locally installed Script object whose sync ID matches aSyncId.
 *
 * @param {string} aSyncId - Hashed sync ID to look up.
 * @returns {Script|undefined} Matching Script, or undefined if not found.
 */
function scriptForSyncId(aSyncId) {
  let scripts = GM_util.getService().config.scripts;
  for (let i = 0, iLen = scripts.length; i < iLen; i++) {
    let script = scripts[i];
    if (syncId(script) == aSyncId) {
      return script;
    }
  }
}

/**
 * Derives the stable sync ID for a script by hashing its local ID.
 *
 * @param {Script} aScript - The script to derive the sync ID for.
 * @returns {string} SHA-256 hash of the script's local ID.
 */
function syncId(aScript) {
  return GM_util.hash(aScript.id);
}

/**
 * Applies GM_setValue storage from an incoming sync record to a local script.
 * Only runs if the "sync.values" pref is enabled and valuesTooBig is false.
 * If "sync.values.deleteNonExistentValues" is enabled, values present locally
 * but absent from the record are deleted.
 *
 * @param {Script}       aScript - The local script to update storage for.
 * @param {ScriptRecord} aRecord - The incoming sync record.
 */
function setScriptValuesFromSyncRecord(aScript, aRecord) {
  if (GM_prefRoot.getValue("sync.values")
      && !aRecord.cleartext.valuesTooBig) {
    let storage = new GM_ScriptStorageBack(aScript);
    let valuesOld = storage.listValues();
    let valuesNew = [];
    for (let name in aRecord.cleartext.values) {
      storage.setValue(name, aRecord.cleartext.values[name]);
      valuesNew.push(name);
    }
    if (GM_prefRoot.getValue("sync.values.deleteNonExistentValues")) {
      for (let i = 0, iLen = valuesOld.length; i < iLen; i++) {
        let valueOld = valuesOld[i];
        if (!GM_util.inArray(valuesNew, valueOld)) {
          storage.deleteValue(valueOld);
        }
      }
    }
  }
}

SyncServiceObserver.init();
})();
