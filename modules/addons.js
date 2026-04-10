/**
 * @file addons.js
 * @overview Integrates Greasemonkey userscripts with the Firefox Add-ons Manager
 *   (about:addons).  Derived from the SlipperyMonkey extension by Dave Townsend.
 *
 * Architecture:
 *
 *   AddonProvider
 *     Implements the AddonManager provider interface.  Registered once via
 *     GM_addonsStartup() to supply script data to the Add-ons Manager UI.
 *
 *   ScriptAddon (implements the Addon interface)
 *     Wraps a Script object as an Add-ons Manager Addon so it appears in the
 *     Extensions/User Scripts list.  Bridges enabled/disabled, uninstall,
 *     and update operations between the AOM UI and Greasemonkey's own config.
 *
 *   ScriptInstall (implements the AddonInstall interface)
 *     Represents an in-progress update download for a script that has a newer
 *     version available.  Created when findUpdates() discovers an update.
 *
 *   ScriptAddonCache / ScriptInstallCache
 *     Simple id-keyed caches to avoid creating duplicate wrappers for the
 *     same Script/AddonInstall within a session.
 *
 * Key entry points:
 *   GM_addonsStartup(aParams)            — called by the component once at startup.
 *   ScriptAddonFactoryByScript(aScript)  — returns (or creates) the ScriptAddon
 *                                          for a Script object.
 *
 * Note: ScriptAddon.isCompatible is repurposed to reflect whether a script
 * has a valid remote update URL (i.e. can be updated).  Combined with CSS in
 * the AOM, this controls the visibility of the update indicator.
 */

// This file specifically targets integration with the add-ons tab
// in Firefox 4+, thus it makes liberal use of features only available there.
//
// Derived from the SlipperyMonkey extension originally by Dave Townsend:
//   http://hg.oxymoronical.com/extensions/SlipperyMonkey/
//   http://www.oxymoronical.com/blog/2010/07/How-to-extend-the-new-Add-ons-Manager

// Module exported symbols.
const EXPORTED_SYMBOLS = ["GM_addonsStartup", "ScriptAddonFactoryByScript"];

////////////////////////////////////////////////////////////////////////////////
// Module level imports / constants / globals.
////////////////////////////////////////////////////////////////////////////////

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

Cu.import("chrome://greasemonkey-modules/content/GM_notification.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


////////////////////////////////////////////////////////////////////////////////
// Addons API Integration
////////////////////////////////////////////////////////////////////////////////

/**
 * AddonManager provider that exposes installed userscripts to about:addons.
 * Registered once via GM_addonsStartup().  Implements the minimal subset of
 * the AddonManager provider interface that Greasemonkey needs.
 */
var AddonProvider = {
  /**
   * Returns the ScriptAddon for the given add-on ID, or null if not found.
   *
   * @param {string}   aId       - Add-on ID (script.id + scriptIDSuffix).
   * @param {function} aCallback - Receives the ScriptAddon or null.
   */
  "getAddonByID": function AddonProvider_getAddonByID(aId, aCallback) {
    aCallback(ScriptAddonFactoryById(aId));
  },

  /**
   * Returns all ScriptAddons, optionally filtered by type.
   *
   * @param {string[]|null} aTypes    - Requested add-on types, or null for all.
   * @param {function}      aCallback - Receives an array of ScriptAddon objects.
   */
  "getAddonsByTypes": function AddonProvider_getAddonsByTypes(
      aTypes, aCallback) {
    if (aTypes && (aTypes.indexOf(GM_CONSTANTS.scriptAddonType) < 0)) {
      aCallback([]);
    } else {
      var scriptAddons = [];
      GM_util.getService().config.scripts.forEach(function (aScript) {
        /*
        "true" - to "properly" (better; also reload page) update the AOM.
        e.g. ScriptAddon.isCompatible
        This solution cannot be used:
          In the case of an uninstall undo failure
          (this script is not uninstalled).
        But a simple solution: see ScriptAddonFactoryByScript().
        */
        // scriptAddons.push(ScriptAddonFactoryByScript(aScript, true));
        scriptAddons.push(ScriptAddonFactoryByScript(aScript));
      });
      aCallback(scriptAddons);
    }
  },

  /**
   * Returns all pending ScriptInstall objects (scripts with an available update).
   *
   * @param {string[]|null} aTypes    - Requested install types (ignored).
   * @param {function}      aCallback - Receives an array of ScriptInstall objects.
   */
  "getInstallsByTypes": function (aTypes, aCallback) {
    var scriptInstalls = [];
    GM_util.getService().config.scripts.forEach(function (aScript) {
      if (!aScript.availableUpdate) {
        return undefined;
      }

      let aAddon = ScriptAddonFactoryByScript(aScript);
      let scriptInstall = ScriptInstallFactoryByAddon(aAddon);

      scriptInstalls.push(scriptInstall);
    });
    aCallback(scriptInstalls);
  }
};

/** @type {Object.<string, ScriptAddon>} Cache of id → ScriptAddon to avoid duplicates. */
var ScriptAddonCache = {};

/**
 * Returns the cached ScriptAddon for aScript, creating a new one if necessary.
 * Pass aReplace=true to force a fresh ScriptAddon (e.g. after an update).
 *
 * @param {Script}  aScript  - The Script object to wrap.
 * @param {boolean} [aReplace=false] - If true, discard any cached wrapper.
 * @returns {ScriptAddon} The (possibly newly created) wrapper.
 */
function ScriptAddonFactoryByScript(aScript, aReplace) {
  let id = aScript.id + GM_CONSTANTS.scriptIDSuffix;
  if (aReplace || !(id in ScriptAddonCache)) {
    ScriptAddonCache[id] = new ScriptAddon(aScript);
  } else {
    // To properly update the AOM.
    if ("isRemoteUpdateAllowed" in aScript) {
      ScriptAddonCache[id].isCompatible = aScript.isRemoteUpdateAllowed(false);
    }
  }

  return ScriptAddonCache[id];
}
/**
 * Looks up a Script by add-on ID and returns its ScriptAddon, or null.
 *
 * @param {string} aId - Add-on ID string (script.id + scriptIDSuffix).
 * @returns {ScriptAddon|null}
 */
function ScriptAddonFactoryById(aId) {
  let _count = 1;
  let scripts = GM_util.getService().config.getMatchingScripts(
      function (aScript) {
        return aId == (aScript.id + GM_CONSTANTS.scriptIDSuffix);
      });
  if (scripts.length == _count) {
    return ScriptAddonFactoryByScript(scripts[0]);
  }

  // Firefox 50+
  // Startup() with reason ADDON_INSTALL should be fired.
  // http://bugzil.la/1304392
  /*
  GM_util.logError(
      GM_CONSTANTS.info.scriptHandler
      + " - ScriptAddonFactoryById - the count of files != " + _count + ": "
      + scripts.length, true);
  */
  return null;
}

/**
 * Wraps a Script object as an AddonManager Addon so it appears in about:addons.
 *
 * Most properties are delegated to the underlying Script.  The `isCompatible`
 * property is repurposed to flag whether a remote update URL is available
 * (used with CSS to show/hide the update badge in the AOM UI).
 *
 * @constructor
 * @param {Script} aScript - The installed script to wrap.
 * @see https://developer.mozilla.org/en/Addons/Add-on_Manager/Addon
 */
function ScriptAddon(aScript) {
  this._script = aScript;

  if (this._script.author) {
    this.creator = {
      "name": this._script.author,
      "url": this._script.homepageURL,
    };
  }
  this.description = this._script.localized.description;
  this.forceUpdate = false;
  this.homepageURL = this._script.homepageURL;
  this.iconURL = this._script.icon && this._script.icon.fileURL;
  this.id = aScript.id + GM_CONSTANTS.scriptIDSuffix;
  this.name = this._script.localized.name;
  this.namespace = this._script.namespace;
  this.providesUpdatesSecurely = aScript.updateIsSecure;
  this.updateDate = this._script.modifiedDate;
  this.version = this._script.version;

  // This, combined with CSS to hide the incorrect "incompatible"
  // text message causes a visible indication on scripts
  // which will not be updated.
  this.isCompatible = this._script.isRemoteUpdateAllowed(false);
}

// Required attributes.
ScriptAddon.prototype.appDisabled = false;
ScriptAddon.prototype.blocklistState = 0;
ScriptAddon.prototype.creator = null;
ScriptAddon.prototype.id = null;
ScriptAddon.prototype.isCompatible = true;
ScriptAddon.prototype.homepageURL = null;
ScriptAddon.prototype.name = null;
ScriptAddon.prototype.operationsRequiringRestart = 
    AddonManager.OP_NEEDS_RESTART_NONE;
ScriptAddon.prototype.pendingOperations = 0;
ScriptAddon.prototype.scope = AddonManager.SCOPE_PROFILE;
ScriptAddon.prototype.type = GM_CONSTANTS.scriptAddonType;
ScriptAddon.prototype.version = null;

// Optional attributes.
ScriptAddon.prototype.description = null;

// Private and custom attributes.
ScriptAddon.prototype._script = null;

Object.defineProperty(ScriptAddon.prototype, "applyBackgroundUpdates", {
  "get": function ScriptAddon_getApplyBackgroundUpdates() {
    return this._script.checkRemoteUpdates;
  },
  "set": function ScriptAddon_setApplyBackgroundUpdates(aVal) {
    this._script.checkRemoteUpdates = aVal;
    this._script._changed("modified", null);
    AddonManagerPrivate.callAddonListeners(
        "onPropertyChanged", this, ["applyBackgroundUpdates"]);
  },
  "configurable": true,
  "enumerable": true,
});

Object.defineProperty(ScriptAddon.prototype, "executionIndex", {
  "get": function ScriptAddon_getExecutionIndex() {
    return GM_util.getService().config._scripts.indexOf(this._script);
  },
  "enumerable": true,
});

// Getters/setters/functions for API attributes.
Object.defineProperty(ScriptAddon.prototype, "isActive", {
  "get": function ScriptAddon_getIsActive() {
    return this._script.enabled;
  },
  "enumerable": true,
});

Object.defineProperty(ScriptAddon.prototype, "optionsURL", {
  "get": function ScriptAddon_getOptionsURL() {
    return GM_CONSTANTS.scriptPrefsUrl + "#"
        + encodeURIComponent(this._script.id);
  },
  "enumerable": true,
});

Object.defineProperty(ScriptAddon.prototype, "permissions", {
  "get": function ScriptAddon_getPermissions() {
    let perms = AddonManager.PERM_CAN_UNINSTALL;
    perms |= this.userDisabled
        ? AddonManager.PERM_CAN_ENABLE
        : AddonManager.PERM_CAN_DISABLE;
    this.isCompatible = this._script.isRemoteUpdateAllowed(false);
    if (this.forceUpdate || this.isCompatible) {
      perms |= AddonManager.PERM_CAN_UPGRADE;
    }

    return perms;
  },
  "enumerable": true,
});

Object.defineProperty(ScriptAddon.prototype, "userDisabled", {
  "get": function ScriptAddon_getUserDisabled() {
    return !this._script.enabled;
  },
  "set": function ScriptAddon_setUserDisabled(aVal) {
    if (aVal == this.userDisabled) {
      return aVal;
    }

    AddonManagerPrivate.callAddonListeners(
        aVal ? "onEnabling" : "onDisabling", this, false);
    this._script.enabled = !aVal;
    AddonManagerPrivate.callAddonListeners(
        aVal ? "onEnabled" : "onDisabled", this);
  },
  "configurable": true,
  "enumerable": true,
});

/**
 * Always returns true; Greasemonkey scripts have no application version
 * compatibility restrictions.
 *
 * @returns {boolean} true
 */
ScriptAddon.prototype.isCompatibleWith = function () {
  return true;
};

/**
 * Initiates a remote update check for this script.
 * Results are delivered asynchronously via aUpdateListener callbacks.
 *
 * @param {nsIAddonUpdateListener} aUpdateListener - AOM update listener.
 * @param {number}                 aReason         - AddonManager.UPDATE_WHEN_* constant.
 */
ScriptAddon.prototype.findUpdates = function (aUpdateListener, aReason) {
  let callback = GM_util.hitch(this, this._handleRemoteUpdate, aUpdateListener);
  this._script.checkForRemoteUpdate(callback, this.forceUpdate, this.manualUpdate);
};

/**
 * Handles the result of a remote update check dispatched by checkForRemoteUpdate.
 * Routes to the appropriate AddonManager listener calls based on aResult.
 *
 * @param {nsIAddonUpdateListener} aUpdateListener - AOM listener to notify.
 * @param {string}                 aResult         - "updateAvailable" | "noUpdateAvailable".
 * @param {object}                 aInfo           - Result details: name, url, log, etc.
 */
ScriptAddon.prototype._handleRemoteUpdate = function (
    aUpdateListener, aResult, aInfo) {
  function tryToCall(aObj, aMethName) {
    if (aObj && (typeof aObj[aMethName] != "undefined")) {
      aObj[aMethName].apply(aObj, Array.prototype.slice.call(arguments, 2));
    }
  }

  let _scriptUpdatedFailure = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGmAddonsProperties)
      .GetStringFromName("script.updated.failure");

  let scriptInstall;
  let _info;
  try {
    switch (aResult) {
      case "updateAvailable":
        // Purge any possible ScriptInstall cache.
        if (this.id in ScriptInstallCache) {
          delete ScriptInstallCache[this.id];
        }
        // Then create one with this newly found update info.
        scriptInstall = ScriptInstallFactoryByAddon(this, this._script);
        AddonManagerPrivate.callInstallListeners(
            "onNewInstall", [], scriptInstall);
        tryToCall(aUpdateListener, "onUpdateAvailable", this, scriptInstall);
        tryToCall(aUpdateListener, "onUpdateFinished", this,
            AddonManager.UPDATE_STATUS_NO_ERROR);
        break;
      case "noUpdateAvailable":
        _info = _scriptUpdatedFailure +
            ' "' + aInfo.name + '" - "' + aInfo.url + '"' +
            (aInfo.info ? aInfo.info : "");
        if (aInfo.log) {
          GM_util.logError(_info, false, aInfo.fileURL, null);
        }
        if (aInfo.notification) {
          let notificationOptions = {
            "persistence": -1,
            "persistWhileVisible": true,
          };
          GM_notification(
              _info, "greasemonkey-script-updated-failure",
              notificationOptions);
        }
        tryToCall(aUpdateListener, "onNoUpdateAvailable", this);
        tryToCall(aUpdateListener, "onUpdateFinished", this,
            AddonManager[aInfo.updateStatus]);
        break;
    }
  } catch (e) {
    // See #1621.
    // Don't die if (e.g.) an addon listener doesn't provide
    // the entire interface and thus a method is undefined.
    GM_util.logError(
        _scriptUpdatedFailure +
        ' "' + aInfo.name + '" - "' + aInfo.url + '" = ' + e, false,
        aInfo.fileURL, null);
    tryToCall(aUpdateListener, "onUpdateFinished", this,
        AddonManager.UPDATE_STATUS_DOWNLOAD_ERROR);
  }
};

/** @returns {string} Human-readable description of this object. */
ScriptAddon.prototype.toString = function () {
  return "[ScriptAddon object " + this.id + "]";
};

/**
 * Marks this add-on as pending uninstall and notifies AOM listeners.
 * Actual removal is deferred until performUninstall() is called.
 */
ScriptAddon.prototype.uninstall = function () {
  AddonManagerPrivate.callAddonListeners("onUninstalling", this, false);
  // TODO:
  // Pick an appropriate time, and act on these pending uninstalls.
  this.pendingOperations |= AddonManager.PENDING_UNINSTALL;
  AddonManagerPrivate.callAddonListeners("onUninstalled", this);
};

/** Cancels a pending uninstall operation and notifies AOM listeners. */
ScriptAddon.prototype.cancelUninstall = function () {
  this.pendingOperations ^= AddonManager.PENDING_UNINSTALL;
  AddonManagerPrivate.callAddonListeners("onOperationCancelled", this);
};

/** Removes the underlying script from the Greasemonkey config and clears the cache. */
ScriptAddon.prototype.performUninstall = function () {
  GM_util.getService().config.uninstall(this._script);
  delete ScriptAddonCache[this.id];
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/** @type {Object.<string, ScriptInstall>} Cache of addon.id → ScriptInstall. */
var ScriptInstallCache = {};

/**
 * Returns the cached ScriptInstall for aAddon, creating a new one if needed.
 *
 * @param {ScriptAddon} aAddon - The ScriptAddon that has an available update.
 * @returns {ScriptInstall}
 */
function ScriptInstallFactoryByAddon(aAddon) {
  if (!(aAddon.id in ScriptInstallCache)) {
    ScriptInstallCache[aAddon.id] = new ScriptInstall(aAddon);
  }
  return ScriptInstallCache[aAddon.id];
}

/**
 * Represents an in-progress or pending update download for an installed script.
 * Implements the AddonManager AddonInstall interface.
 *
 * @constructor
 * @param {ScriptAddon} aAddon - The ScriptAddon whose script has an available update.
 */
function ScriptInstall(aAddon) {
  let newScript = aAddon._script.availableUpdate;
  this.iconURL = newScript.icon.fileURL;
  this.name = newScript.localized.name;
  this.version = newScript.version;

  this._script = aAddon._script;
  this.existingAddon = aAddon;

  this._listeners = [];
}

// Required attributes.
ScriptInstall.prototype.addon = null;
ScriptInstall.prototype.error = null;
ScriptInstall.prototype.file = null;
ScriptInstall.prototype.maxProgress = -1;
ScriptInstall.prototype.progress = 0;
ScriptInstall.prototype.releaseNotesURI = null;
ScriptInstall.prototype.sourceURI = null;
ScriptInstall.prototype.state = AddonManager.STATE_AVAILABLE;
ScriptInstall.prototype.type = GM_CONSTANTS.scriptType;

// Private and custom attributes.
ScriptInstall.prototype._script = null;

/**
 * Downloads and installs the updated script.
 * Notifies AOM listeners at each stage: download started/ended, install
 * started/ended, or download failed.
 */
ScriptInstall.prototype.install = function () {
  AddonManagerPrivate.callInstallListeners(
      "onDownloadStarted", this._listeners, this);
  this.state = AddonManager.STATE_DOWNLOADING;

  var rs = new RemoteScript(this._script.downloadURL);
  rs.messageName = "script.updated";
  rs.onProgress(this._progressCallback);
  rs.download(GM_util.hitch(this, function (aSuccess, aType) {
    if (aSuccess && (aType == "dependencies")) {
      this._progressCallback(rs, "progress", 1);
      AddonManagerPrivate.callInstallListeners(
          "onDownloadEnded", this._listeners, this);

      // See #1659.
      // Pick the biggest of "remote version" (possibly from an @updateURL file)
      // and "downloaded version".
      // Tricky note: In this scope "rs.script" is the script object that
      // was just downloaded; "this._script" is the previously existing script
      // that rs.install() just removed from the config, to update it.
      if (GM_CONSTANTS.versionChecker.compare(
          this._script.availableUpdate.version, rs.script.version) > 0) {
        rs.script._version = this._script.availableUpdate.version;
      }

      this.state = AddonManager.STATE_INSTALLING;
      this.addon = ScriptAddonFactoryByScript(rs.script);
      AddonManagerPrivate.callInstallListeners(
          "onInstallStarted", this._listeners, this);

      // Note: This call also takes care of replacing the cached ScriptAddon
      // object with a new one for the updated script.
      rs.install(this._script);

      this.addon = ScriptAddonFactoryByScript(rs.script);
      AddonManagerPrivate.callInstallListeners(
          "onInstallEnded", this._listeners, this, this.addon);
    } else if (!aSuccess) {
      this.state = AddonManager.STATE_DOWNLOAD_FAILED;
      AddonManagerPrivate.callInstallListeners(
          "onDownloadFailed", this._listeners, this);
    }
  }));
  this._remoteScript = rs;
};

/**
 * Progress callback fed to RemoteScript.onProgress().
 * Converts fractional progress [0–1] to integer percentage and notifies AOM.
 *
 * @param {RemoteScript} aRemoteScript - The downloading script (unused here).
 * @param {string}       aType         - Callback type string (unused here).
 * @param {number}       aData         - Progress fraction in [0, 1].
 */
ScriptInstall.prototype._progressCallback = function (
    aRemoteScript, aType, aData) {
  this.maxProgress = 100;
  this.progress = Math.floor(aData * 100);
  AddonManagerPrivate.callInstallListeners(
      "onDownloadProgress", this._listeners, this);
};

/** Cancels an in-progress download and notifies AOM listeners. */
ScriptInstall.prototype.cancel = function () {
  this.state = AddonManager.STATE_AVAILABLE;
  AddonManagerPrivate.callInstallListeners(
      "onInstallEnded", this._listeners, this, this.existingAddon);
  AddonManagerPrivate.callInstallListeners(
      "onInstallCancelled", this._listeners, this);
  if (this._remoteScript) {
    this._remoteScript.cleanup();
    this._remoteScript = null;
  }
};

/**
 * Registers an install listener (deduplicates by reference).
 *
 * @param {object} aListener - AOM install listener to add.
 */
ScriptInstall.prototype.addListener = function (aListener) {
  if (!this._listeners.some(function (i) {
    return aListener == i;
  })) {
    this._listeners.push(aListener);
  }
};

/**
 * Removes a previously registered install listener.
 *
 * @param {object} aListener - The listener to remove.
 */
ScriptInstall.prototype.removeListener = function (aListener) {
  this._listeners =
      this._listeners.filter(function (i) {
        return aListener != i;
      });
};

/** @returns {string} Human-readable description of this object. */
ScriptInstall.prototype.toString = function () {
  return "[ScriptInstall object " + this._script.id + "]";
};

////////////////////////////////////////////////////////////////////////////////

/** @type {boolean} Guard preventing double-registration of the AddonProvider. */
var _addonsStartupHasRun = false;

/**
 * Registers the Greasemonkey AddonProvider with the Firefox AddonManager.
 * Called once at startup by the XPCOM component.  Subsequent calls are no-ops.
 *
 * @param {object} aParams - Startup parameters passed by the component (unused).
 */
function GM_addonsStartup(aParams) {
  if (_addonsStartupHasRun) {
    return undefined;
  }
  _addonsStartupHasRun = true;

  AddonManagerPrivate.registerProvider(
      AddonProvider,
      [{
        "id": GM_CONSTANTS.scriptAddonType,
        "name": GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmAddonsProperties)
            .GetStringFromName("userScripts"),
        "uiPriority": 4500,
        "viewType": AddonManager.VIEW_TYPE_LIST,
      }]);
}
