/**
 * @file ipcScript.js
 * @overview IPC-safe, frozen representation of a userscript for use in
 *   content processes.
 *
 * The privileged parent process holds the full Script objects.  When
 * Greasemonkey needs to run scripts in a content process it serialises each
 * Script into an IPCScript (a plain, frozen object that extends AbstractScript)
 * and sends the array to content via the "greasemonkey:scripts-update" IPC
 * message.
 *
 * IPCScript inherits the matchesURL() algorithm from AbstractScript and adds:
 *   - info()         — returns the GM_info payload object visible to scripts.
 *   - scriptsForUrl()— filters the global script list to those that match a URL.
 *   - getByUuid()    — looks up a script by UUID in the global list.
 *
 * The module also maintains the global gScripts array (updated by the
 * GreasemonkeyService whenever scripts are installed, modified, removed,
 * or reordered) and patches IPCScript.prototype.globalExcludes to
 * reflect the current site-wide exclude list.
 *
 * Population on UXP:
 *   The service calls IPCScript.update(data) directly with the result
 *   of GreasemonkeyService.scriptUpdateData() — no IPC.
 *
 * Historical note:
 *   Pre-cleanup, this module bootstrapped via Services.cpmm:
 *     - Firefox 41+ would read initialProcessData["greasemonkey:scripts-update"]
 *     - Older builds would sendSyncMessage to fetch an initial copy
 *     - Subsequent updates arrived via cpmm.addMessageListener
 *   The matching parent-side broadcasts lived in
 *   GreasemonkeyService.broadcastScriptUpdates (ppmm.broadcastAsyncMessage
 *   plus a write to ppmm.initialProcessData).  UXP is single-process; the
 *   IPC bus was a self-loop with no benefit and was replaced by a direct
 *   call to IPCScript.update from the service.
 */

const EXPORTED_SYMBOLS = ["IPCScript"];

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

Cu.import("chrome://greasemonkey-modules/content/abstractScript.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Constructs an IPC-safe, frozen snapshot of a Script object.
 * Converts complex types (MatchPattern objects, file references, etc.) to
 * plain JSON-serialisable values that can be sent across process boundaries.
 *
 * @constructor
 * @param {Script} aScript       - The full Script object from the parent process.
 * @param {string} aAddonVersion - The current Greasemonkey extension version,
 *                                 included in the GM_info payload.
 */
function IPCScript(aScript, aAddonVersion) {
  this.addonVersion = aAddonVersion;
  this.antifeatures = aScript._antifeatures || [];
  this.author = aScript.author || "";
  this.connects = aScript.connects;
  this.copyright = aScript.copyright || null;
  this.description = aScript.description;
  this.enabled = aScript.enabled;
  this.excludes = aScript.excludes;
  this.fileURL = aScript.fileURL;
  this.grants = aScript.grants;
  this.homepage = ((aScript.homepageURL && (aScript.homepageURL != ""))
      ? aScript.homepageURL
      : null);
  this.id = aScript.id;
  this.injectInto = aScript.injectInto || "auto";
  this.supportURL = aScript._supportURL || null;
  this.includes = aScript.includes;
  this.lastUpdated = aScript.modifiedDate.getTime();
  this.localized = aScript.localized;
  this.name = aScript.name;
  this.namespace = aScript.namespace;
  this.needsUninstall = aScript.needsUninstall;
  this.noframes = aScript.noframes;
  this.pendingExec = {};
  this.pendingExec.length = aScript.pendingExec.length || 0;
  this.runAt = aScript.runAt;
  this.topLevelAwait = aScript._topLevelAwait || false;
  // @unwrap (legacy GM1.x): when true, scriptInjector.js skips the
  // IIFE wrapper for page-mode injection so the script's top-level
  // var declarations leak into window scope as the directive intends.
  this.unwrap = aScript.unwrap || false;
  this.userExcludes = aScript.userExcludes;
  this.userIncludes = aScript.userIncludes;
  this.userOverride = aScript.userOverride;
  this.uuid = aScript.uuid;
  this.version = aScript.version;
  this.willUpdate = aScript.isRemoteUpdateAllowed(false)
      && aScript.shouldAutoUpdate();

  this.excludeMatches = aScript.excludeMatches.map(function (aMatch) {
    return aMatch.pattern;
  });
  this.matches = aScript.matches.map(function (aMatch) {
    return aMatch.pattern;
  });
  this.userMatches = aScript.userMatches.map(function (aMatch) {
    return aMatch.pattern;
  });

  this.requires = aScript.requires.map(function (aReq) {
    return {
      "fileURL": aReq.fileURL,
    };
  });

  this.resources = aScript.resources.map(function (aRes) {
    return {
      "name": aRes.name,
      "mimetype": aRes.mimetype,
      "file_url": GM_util.getUriFromFile(aRes.file).spec,
      "gm_url": [
        GM_CONSTANTS.addonScriptProtocolScheme + ":",
        aScript.uuid,
        GM_CONSTANTS.addonScriptProtocolSeparator, aRes.name
      ].join(""),
    };
  });
};

IPCScript.prototype = Object.create(AbstractScript.prototype, {
  "constructor": {
    "value": IPCScript,
  },
});

/**
 * Filters the global script list to those that should execute on aUrl
 * at the given run-at phase.
 *
 * @param {string} aUrl      - The page URL to match against.
 * @param {string} aWhen     - Run-at phase: "document-start", "document-end",
 *                             or "document-idle".
 * @param {*}      aWindowId - Ignored; present for API compatibility.
 * @returns {IPCScript[]} Scripts that match the URL and run-at phase.
 */
IPCScript.scriptsForUrl = function (aUrl, aWhen, aWindowId /* ignore */) {
  let result = gScripts.filter(function (aScript) {
    try {
      return GM_util.scriptMatchesUrlAndRuns(aScript, aUrl, aWhen);
    } catch (e) {
      // See #1692.
      // Prevent failures like that from being so severe.
      GM_util.logError(e, false, e.fileName, e.lineNumber);
      return false;
    }
  });

  return result;
};

/**
 * Builds and returns the GM_info object that is injected into the script
 * sandbox and exposed to the userscript as GM_info / GM.info.
 *
 * @returns {object} Plain object matching the GM_info specification:
 *   { script: {...}, scriptHandler, scriptWillUpdate, uuid, version }
 */
IPCScript.prototype.info = function () {
  let resources = this.resources.map(function (aRes) {
    return {
      "name": aRes.name,
      "mimetype": aRes.mimetype,
      "url": aRes.gm_url,
    };
  });

  return {
    "script": {
      "antifeatures": this.antifeatures,
      "author": this.author,
      "connects": this.connects,
      "copyright": this.copyright,
      "description": this.description,
      "excludeMatches": this.excludeMatches,
      "excludes": this.excludes,
      "grant": this.grants,
      "homepage": this.homepage,
      "homepageURL": this.homepage,
      // "icon": ? source URL,
      "includes": this.includes,
      "lastUpdated": this.lastUpdated,
      "localizedDescription": this.localized.description,
      "localizedName": this.localized.name,
      "matches": this.matches,
      "name": this.name,
      "namespace": this.namespace,
      "noframes": this.noframes,
      // "requires": ? source URL,
      "resources": resources,
      "run-at": this.runAt,
      "supportURL": this.supportURL,
      "version": this.version,
    },
    "platform": {
      "arch": Services.appinfo.XPCOMABI
          ? Services.appinfo.XPCOMABI.split("-")[0] : "",
      "os": Services.appinfo.OS || "",
    },
    // The resolved injection mode for THIS script ("page" / "content" /
    // "auto") — matches Tampermonkey / Violentmonkey's GM_info.injectInto
    // so userscripts can branch on which context they're running in.
    "injectInto": this.injectInto,
    "scriptHandler": GM_CONSTANTS.info.scriptHandler,
    "scriptWillUpdate": this.willUpdate,
    "uuid": this.uuid,
    "version": this.addonVersion,
  };
};

/**
 * The current list of all installed userscripts for this content process.
 * Replaced entirely on each "greasemonkey:scripts-update" IPC message.
 *
 * @type {IPCScript[]}
 */
var gScripts = [];

/**
 * Promotes a plain deserialized object to an IPCScript prototype chain so
 * that it inherits matchesURL() etc., then freezes it to prevent mutation.
 *
 * @param {object} aObj - Plain object received over IPC.
 * @returns {IPCScript} Frozen IPCScript instance.
 */
function objectToScript(aObj) {
  var script = Object.create(IPCScript.prototype);

  Object.keys(aObj).forEach(function (aKey) {
    script[aKey] = aObj[aKey];
  });

  Object.freeze(script);

  return script;
}

/**
 * Finds a script in the global list by its UUID.
 *
 * @param {string} aId - The script UUID to search for.
 * @returns {IPCScript|undefined} The matching script, or undefined if not found.
 */
IPCScript.getByUuid = function (aId) {
  return gScripts.find(function (e) {
    return e.uuid == aId;
  });
}

/**
 * Replaces the global script list with fresh data from the parent process.
 * Also updates the globalExcludes getter on IPCScript.prototype so that
 * matchesURL() uses the current site-wide exclude list.
 *
 * @param {object|null} aData - Payload from the "greasemonkey:scripts-update"
 *   message: { scripts: [...], globalExcludes: [...] }, or null/undefined on
 *   first load if no data is available yet.
 */
function updateData(aData) {
  if (!aData) {
    return undefined;
  }
  let newScripts = aData.scripts.map(objectToScript);
  Object.freeze(newScripts);
  gScripts = newScripts;
  Object.defineProperty(IPCScript.prototype, "globalExcludes", {
    "get": function IPCScript_getGlobalExcludes() {
      return aData.globalExcludes;
    },
    "configurable": true,
    "enumerable": true,
  });
}

/**
 * Replaces the in-memory script list.  The GreasemonkeyService calls this
 * directly from its broadcastScriptUpdates() method whenever the live
 * config changes (script installed / modified / uninstalled / reordered,
 * cludes edited, enable-toggle, etc.).  Public alias of updateData().
 *
 * @param {object|null} aData - { globalExcludes, scripts } from
 *   GreasemonkeyService.scriptUpdateData(), or null/undefined for "clear".
 */
IPCScript.update = updateData;
