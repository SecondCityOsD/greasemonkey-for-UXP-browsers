/**
 * @file backup.js
 * @overview Tampermonkey-compatible ZIP export/import for user scripts.
 *
 * Produces a single .zip archive containing (formatVersion 2):
 *   - One <basename>.user.js per installed script (raw source).
 *   - One <basename>.user.js.options.json per script (metadata sidecar,
 *     including a "dependencies" table describing the archived dependency
 *     entries below).
 *   - Optionally one <basename>.user.js.storage.json per script (GM values).
 *   - The script's cached @require / @resource / @icon files under
 *     <basename>.user.js.deps/<n>-<filename>, so a restore can pre-seed
 *     them and work fully OFFLINE with the exact bytes that worked at
 *     export time — even when the original URLs are long dead.
 *   - A top-level "greasemonkey" manifest (JSON) with format version and the
 *     list of exported basenames.
 *
 * The layout is forward- and backward-compatible with Violentmonkey's and
 * Tampermonkey's exports: their importers read individual .user.js entries
 * directly (and ignore the .deps/ entries), and our importer tolerates a
 * VM-style "violentmonkey" manifest or TM-style per-script .options.json /
 * .storage.json sidecars (with or without the .user.js infix), translating
 * VM's config/custom and TM's options/settings/meta schemas into our flat
 * per-script options.
 *
 * Uses native XPCOM nsIZipWriter / nsIZipReader — no bundled JS library.
 * Entirely local: no cloud sync.
 *
 * @exports GM_BackupExport, GM_BackupImport
 */

const EXPORTED_SYMBOLS = [
  "GM_BackupExport",
  "GM_BackupImport",
  "GM_BackupPreview",
];

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

Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/GM_notification.js");
Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

Cu.importGlobalProperties(["TextEncoder"]);


// Layout constants.
const MANIFEST_FILENAME = "greasemonkey";
const VM_MANIFEST_FILENAME = "violentmonkey";
// 3: a script's stored values are written as Tampermonkey writes them,
// {"ts": <ms>, "data": {key: value}}, so Tampermonkey and Violentmonkey
// can restore them; up to 2 they were the bare {key: value} map.  The
// options sidecar also carries the Options window's Run at / No frames /
// Inject into choices.
const MANIFEST_FORMAT_VERSION = 3;

/** The values a backup's Run at / Inject into choice may have. */
const RUN_AT_VALUES = [
  "document-start", "document-body", "document-end", "document-idle"];
const INJECT_INTO_VALUES = ["auto", "page", "content"];
const OPTIONS_SUFFIX = ".options.json";
const STORAGE_SUFFIX = ".storage.json";
const USER_JS_SUFFIX = GM_CONSTANTS.fileScriptExtension; // ".user.js"
// Archived dependency entries live under "<base>.user.js.deps/"; the infix
// also routes those entries through the binary (not UTF-8) zip reader.
const DEPS_INFIX = USER_JS_SUFFIX + ".deps/";
// Per-entry inflate cap (zip-bomb guard) — oversized entries are skipped
// and reported, never read into memory.
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

// extensions.greasemonkey.* prefs that round-trip through the manifest's
// "settings" block.  Deliberately curated: machine-specific values (editor
// path) and sync state are excluded, mirroring what VM/TM strip.
const SETTINGS_PREFS = [
  "enableScriptRefreshing",
  "installDelay",
  "newScript.removeUnused",
  "newScript.template",
  "requireDisabledScriptsUpdates",
  "requireSecureUpdates",
  "requireTimeoutUpdates",
  "showGrantsWarning",
  "sniffGrants",
  "timeoutUpdatesInSeconds",
  "update.intervalDays",
];

// How many automatic pre-import safety snapshots to keep in
// <profile>/gm_backups/ before pruning the oldest.
const SNAPSHOTS_TO_KEEP = 10;

// Import: scripts install one at a time, in the archive's order, while the
// @require / @resource / @icon files of the scripts after them download.
// Violentmonkey and Tampermonkey backups carry none of those files, and
// waiting for each script's downloads in turn made such an import take a
// minute or more.  At most IMPORT_FILES_AT_ONCE files (the browser's
// per-site connection limit) and IMPORT_SCRIPTS_AT_ONCE scripts download
// at once, and each file has a time limit, so a dead site can't hold the
// import up.
const IMPORT_FILES_AT_ONCE = 6;
const IMPORT_SCRIPTS_AT_ONCE = 8;
const IMPORT_DEPENDENCY_TIMEOUT_MS = 15000;
const IMPORT_ICON_TIMEOUT_MS = 2000;
// How long the import works before the browser gets its turn again: under
// one screen refresh, so clicks and scrolling are answered between slices.
const IMPORT_SLICE_MS = 12;

// nsIZipWriter open flags (PR_* constants, unavailable on the JS side).
const PR_WRONLY = 0x02;
const PR_CREATE_FILE = 0x08;
const PR_TRUNCATE = 0x20;


/**
 * Exports all installed user scripts into a ZIP archive.
 *
 * Synchronous except for the final callback dispatch, which runs on the
 * microtask queue.  Safe to call from chrome-privileged code.
 *
 * @param {nsIFile} aDestFile        - Where to write the .zip (will be truncated).
 * @param {boolean} aIncludeValues   - If true, bundle each script's GM_values.
 * @param {function} [aCallback]     - Called (success, exportedCount, errorMsg).
 */
function GM_BackupExport(aDestFile, aIncludeValues, aCallback) {
  aCallback = aCallback || function () {};

  let zipWriter;
  try {
    zipWriter = Cc["@mozilla.org/zipwriter;1"]
        .createInstance(Ci.nsIZipWriter);
    zipWriter.open(aDestFile, PR_WRONLY | PR_CREATE_FILE | PR_TRUNCATE);
  } catch (e) {
    GM_util.logError("Backup export: could not open ZIP: " + e, false);
    aCallback(false, 0, "" + e);
    return;
  }

  let config = GM_util.getService().config;
  let scripts = config.scripts;
  let exportedBasenames = [];
  let exportedCount = 0;
  let errors = [];
  // Off-main-thread native compression when enabled (the default): every
  // entry is queued, then processQueue() compresses on a background thread
  // and the observer closes the writer + fires the callback, so the UI
  // never freezes.  Flip extensions.greasemonkey.backup.asyncExport to
  // false to force the proven synchronous path.
  let useAsync = GM_prefRoot.getValue("backup.asyncExport", true);
  // Content-hash dedup across the whole export: a dependency whose exact
  // bytes were already archived (e.g. the same jQuery @require shared by
  // several scripts) is stored once and referenced by every script's table.
  let seenHashes = {};

  for (let i = 0; i < scripts.length; i++) {
    let script = scripts[i];
    try {
      let baseName = _uniqueExportBasename(script, exportedBasenames);
      let userJsName = baseName + USER_JS_SUFFIX;

      // Skip scripts whose source file is missing on disk.
      if (!script.fileExists(script.file)) {
        errors.push(script.id + ": source file missing, skipped");
        continue;
      }

      // 1. Raw .user.js source.
      _addEntryFromFile(zipWriter, userJsName, script.file, useAsync);

      // 2. Cached dependency files (@require / @resource / @icon) under
      //    <base>.user.js.deps/ so a restore works offline (format v2).
      //    Returns the table embedded in the options sidecar.
      let dependencies = _exportDependencies(
          zipWriter, script, userJsName, useAsync, seenHashes);

      // 3. Options sidecar (.user.js.options.json).
      _addEntryFromString(
          zipWriter, userJsName + OPTIONS_SUFFIX,
          _buildOptionsJson(script, dependencies), useAsync);

      // 4. Optional GM values dump (.user.js.storage.json).
      if (aIncludeValues) {
        let storageJson = _buildStorageJson(script);
        if (storageJson) {
          _addEntryFromString(
              zipWriter, userJsName + STORAGE_SUFFIX, storageJson, useAsync);
        }
      }

      exportedBasenames.push(baseName);
      exportedCount++;
    } catch (e) {
      GM_util.logError(
          "Backup export: skipped " + script.id + " - " + e, false);
      errors.push(script.id + ": " + e);
    }
  }

  // Top-level manifest.  Version helps future importers know what to expect.
  try {
    let manifest = {
      "format": "greasemonkey-backup",
      "formatVersion": MANIFEST_FORMAT_VERSION,
      "timestamp": new Date().getTime(),
      "includesValues": !!aIncludeValues,
      "scripts": exportedBasenames,
      "settings": {
        "globalExcludes": config.globalExcludes,
        "prefs": _exportSettingsPrefs(),
      },
    };
    _addEntryFromString(
        zipWriter, MANIFEST_FILENAME, JSON.stringify(manifest, null, 2),
        useAsync);
  } catch (e) {
    // Non-fatal; scripts are already in the archive.
    GM_util.logError("Backup manifest: " + e, false);
  }

  let errMsg = errors.length ? errors.join("; ") : null;

  // Synchronous path (kill-switch off): compress + close inline, as before.
  if (!useAsync) {
    try {
      zipWriter.close();
    } catch (e) {
      GM_util.logError("Backup export: close failed: " + e, false);
      aCallback(false, exportedCount, "" + e);
      return;
    }
    aCallback(true, exportedCount, errMsg);
    return;
  }

  // Async path: processQueue() compresses every queued entry on a
  // background thread; the observer closes the writer and fires the
  // callback when the queue drains.  A synchronous throw from
  // processQueue (bad state) falls through to a failure callback.
  let observer = {
    "onStartRequest": function (aReq, aCtx) {},
    "onStopRequest": function (aReq, aCtx, aStatus) {
      let ok = Components.isSuccessCode(aStatus);
      try {
        zipWriter.close();
      } catch (e) {
        GM_util.logError("Backup export: async close failed: " + e, false);
        aCallback(false, exportedCount, "" + e);
        return undefined;
      }
      if (ok) {
        aCallback(true, exportedCount, errMsg);
      } else {
        aCallback(false, exportedCount,
            "compression failed: 0x" + (aStatus >>> 0).toString(16));
      }
      return undefined;
    },
    "QueryInterface": function (aIID) {
      if (aIID.equals(Ci.nsIRequestObserver) || aIID.equals(Ci.nsISupports)) {
        return this;
      }
      throw Components.results.NS_ERROR_NO_INTERFACE;
    },
  };
  try {
    zipWriter.processQueue(observer, null);
  } catch (e) {
    GM_util.logError("Backup export: processQueue failed: " + e, false);
    try {
      zipWriter.close();
    } catch (e2) {
      // Already failing; nothing more to do.
    }
    aCallback(false, exportedCount, "" + e);
  }
}


/**
 * Imports user scripts from a ZIP archive produced by GM_BackupExport,
 * Violentmonkey, or Tampermonkey.  Installs each unique script, one at a
 * time and in the archive's order, while later scripts' files download
 * (_installAll).
 *
 * By default a script whose (name, namespace) already matches an installed
 * script is skipped; aOptions.overwrite turns that into an in-place update
 * (position kept, stored values carried over, sidecar state applied on
 * top).  Archived dependencies (format v2) restore offline; anything else
 * is re-downloaded via the regular RemoteScript pipeline.
 *
 * Unless aOptions.skipSnapshot is set, a full safety snapshot is exported
 * to <profile>/gm_backups/pre-import-<timestamp>.zip before anything is
 * installed — a durable on-disk undo point.
 *
 * @param {nsIFile}  aSrcFile    - The .zip to read from.
 * @param {object}   [aOptions]  - {selectedKeys: string[]|null (archive keys
 *   to install; null = all), overwrite: boolean, restoreValues: boolean
 *   (default true), restoreSettings: boolean (apply the manifest's global
 *   settings), skipSnapshot: boolean, onProgress: function(done, total,
 *   key)}.  Passing a function here instead is the legacy
 *   (file, callback) signature and still works.
 * @param {function} [aCallback] - Called (success, result, errorMsg) where
 *   result = {total, imported, skipped, errors[], snapshotPath}.
 */
function GM_BackupImport(aSrcFile, aOptions, aCallback) {
  // Legacy signature: (file, callback).
  if (typeof aOptions === "function") {
    aCallback = aOptions;
    aOptions = null;
  }
  let opts = aOptions || {};
  aCallback = aCallback || function () {};
  let result = {
    "total": 0,
    "imported": 0,
    "skipped": 0,
    "errors": [],
    "snapshotPath": null,
  };

  // Dependency payloads stream out of the archive into this temp dir
  // (constant-memory import); removed once the installs finish.
  let depDir = GM_util.getTempDir();

  let entries;
  let payloads;
  let depFiles;
  try {
    let parsed = _readZipContents(aSrcFile, depDir);
    entries = parsed.entries;
    payloads = parsed.payloads;
    depFiles = parsed.depFiles;
    // Oversized entries were skipped, not read — surface that in the
    // result instead of pretending the archive was fully consumed.
    for (let i = 0; i < parsed.skipped.length; i++) {
      result.errors.push(parsed.skipped[i]);
    }
  } catch (e) {
    GM_util.logError("Backup import: cannot read ZIP: " + e, false);
    _cleanupDir(depDir);
    aCallback(false, result, "" + e);
    return;
  }

  let scripts = _collectScripts(entries, payloads).scripts;

  // Our own manifest (format v2 carries the global settings block; older
  // and foreign archives simply have none).
  let manifest = null;
  if (payloads[MANIFEST_FILENAME]) {
    try {
      manifest = JSON.parse(payloads[MANIFEST_FILENAME]);
    } catch (e) {
      // Tolerated — script entries still import.
    }
  }

  // Collect only entries with actual source.
  let toInstall = [];
  let all = Object.keys(scripts);
  for (let i = 0; i < all.length; i++) {
    if (scripts[all[i]].source) {
      toInstall.push(all[i]);
    } else {
      result.skipped++;
      result.errors.push(all[i] + ": no source in archive");
    }
  }

  // Selective import (dialog): only the chosen archive keys.  Deselected
  // scripts are neither installed nor counted as skipped errors.
  if (Array.isArray(opts.selectedKeys)) {
    let allow = {};
    for (let i = 0; i < opts.selectedKeys.length; i++) {
      allow[opts.selectedKeys[i]] = true;
    }
    toInstall = toInstall.filter(function (aKey) {
      return allow[aKey] === true;
    });
  }

  result.total = toInstall.length;

  let finish = function () {
    if (opts.restoreSettings && manifest && manifest.settings) {
      _applyImportedSettings(manifest.settings, result);
    }
    aCallback(true, result, null);
  };
  // The archived files stay until the scripts installed without theirs
  // have fetched them (they use these first).
  let fetchesDone = function (aFailures) {
    _cleanupDir(depDir);
    _reportFetchFailures(aFailures);
  };

  if (!toInstall.length) {
    if (opts.restoreSettings && manifest && manifest.settings) {
      // Settings-only restore is a legitimate operation.
      _cleanupDir(depDir);
      finish();
      return;
    }
    _cleanupDir(depDir);
    aCallback(false, result, "No user scripts found in archive.");
    return;
  }

  let start = function () {
    _installAll(toInstall, scripts, depFiles, opts, result, finish,
        fetchesDone);
  };
  if (opts.skipSnapshot) {
    start();
    return;
  }
  // Durable safety snapshot BEFORE anything is installed — unlike an
  // in-memory undo, a zip in <profile>/gm_backups/ survives restarts.  The
  // installs wait until it is written: the export compresses on another
  // thread, and starting at once let an overwrite replace script files the
  // snapshot hadn't read yet.
  _writeSnapshot(function (aError, aPath) {
    if (aError) {
      GM_util.logError("Backup import: snapshot failed: " + aError, false);
      result.errors.push("safety snapshot failed: " + aError);
    } else {
      result.snapshotPath = aPath;
    }
    start();
  });
}

/** Best-effort recursive removal of an import scratch directory. */
function _cleanupDir(aDir) {
  if (!aDir) {
    return undefined;
  }
  try {
    if (aDir.exists()) {
      aDir.remove(true);
    }
  } catch (e) {
    // Temp files are harmless if they linger; the OS clears the temp dir.
  }
  return undefined;
}

/**
 * Groups raw zip entries into logical scripts:
 *   scripts[name.user.js] = { source, options, storage }
 * Tolerates the GM/VM idiom (.user.js.options.json sidecars), the TM idiom
 * (sidecars without the .user.js infix), and a Violentmonkey index entry
 * whose per-script objects fill remaining options gaps.
 */
function _collectScripts(aEntries, aPayloads) {
  let scripts = {};
  let vmManifest = null;

  // First pass: pick up all .user.js files + direct sidecars (TM layout
  // with .user.js.options.json / .user.js.storage.json — GM / VM idiom).
  for (let i = 0; i < aEntries.length; i++) {
    let name = aEntries[i];
    if (name === MANIFEST_FILENAME) continue;
    if (name === VM_MANIFEST_FILENAME) {
      try {
        vmManifest = JSON.parse(aPayloads[name]);
      } catch (e) {
        GM_util.logError("Backup import: bad VM manifest: " + e, false);
      }
      continue;
    }
    if (name.length > OPTIONS_SUFFIX.length
        && name.slice(-OPTIONS_SUFFIX.length) === OPTIONS_SUFFIX
        && name.length > USER_JS_SUFFIX.length + OPTIONS_SUFFIX.length
        && name.slice(-(USER_JS_SUFFIX.length + OPTIONS_SUFFIX.length))
            === USER_JS_SUFFIX + OPTIONS_SUFFIX) {
      let base = name.slice(0, -OPTIONS_SUFFIX.length);
      (scripts[base] = scripts[base] || {}).options = aPayloads[name];
      continue;
    }
    if (name.length > STORAGE_SUFFIX.length
        && name.slice(-STORAGE_SUFFIX.length) === STORAGE_SUFFIX
        && name.length > USER_JS_SUFFIX.length + STORAGE_SUFFIX.length
        && name.slice(-(USER_JS_SUFFIX.length + STORAGE_SUFFIX.length))
            === USER_JS_SUFFIX + STORAGE_SUFFIX) {
      let base = name.slice(0, -STORAGE_SUFFIX.length);
      (scripts[base] = scripts[base] || {}).storage = aPayloads[name];
      continue;
    }
    if (name.length > USER_JS_SUFFIX.length
        && name.slice(-USER_JS_SUFFIX.length) === USER_JS_SUFFIX) {
      (scripts[name] = scripts[name] || {}).source = aPayloads[name];
      continue;
    }
  }

  // Second pass: TM-style sidecars without the .user.js infix
  // (e.g. "<name>.options.json" where <name>.user.js also exists).
  for (let i = 0; i < aEntries.length; i++) {
    let name = aEntries[i];
    if (name.length > OPTIONS_SUFFIX.length
        && name.slice(-OPTIONS_SUFFIX.length) === OPTIONS_SUFFIX) {
      let stem = name.slice(0, -OPTIONS_SUFFIX.length);
      let candidate = stem + USER_JS_SUFFIX;
      if (scripts[candidate] && !scripts[candidate].options) {
        scripts[candidate].options = aPayloads[name];
      }
    } else if (name.length > STORAGE_SUFFIX.length
        && name.slice(-STORAGE_SUFFIX.length) === STORAGE_SUFFIX) {
      let stem = name.slice(0, -STORAGE_SUFFIX.length);
      let candidate = stem + USER_JS_SUFFIX;
      if (scripts[candidate] && !scripts[candidate].storage) {
        scripts[candidate].storage = aPayloads[name];
      }
    }
  }

  // How each .storage.json is shaped: ours from format 3 and
  // Tampermonkey's are {"ts", "data": {...}}, ours before that the bare
  // map.  Without our manifest the archive is a foreign one: "auto" takes
  // the "data" map when the file has that shape.  (Tampermonkey's were
  // imported whole, as the two values "data" and "ts".)
  let ourManifest = null;
  try {
    ourManifest = aPayloads[MANIFEST_FILENAME]
        ? JSON.parse(aPayloads[MANIFEST_FILENAME]) : null;
  } catch (e) {
    ourManifest = null;
  }
  let shape = !ourManifest ? "auto"
      : ((ourManifest.formatVersion >= 3) ? "wrapped" : "flat");
  Object.keys(scripts).forEach(function (aKey) {
    if (scripts[aKey].storage) {
      scripts[aKey].storageShape = shape;
    }
  });

  // Third pass: if a VM manifest is present, fill in any missing options
  // from its "scripts" map (keyed by the file name's stem), and the
  // stored values from its "values" map (keyed by Violentmonkey's name
  // URI; they were all dropped).
  if (vmManifest && (vmManifest.scripts || vmManifest.values)) {
    let keys = Object.keys(scripts);
    for (let i = 0; i < keys.length; i++) {
      let entry = scripts[keys[i]];
      let stem = keys[i].slice(0, -USER_JS_SUFFIX.length);
      if (!entry.options && vmManifest.scripts && vmManifest.scripts[stem]) {
        try {
          entry.options = JSON.stringify(vmManifest.scripts[stem]);
        } catch (e) {
          // Ignore — the script will install with GM defaults.
        }
      }
      if (!entry.storage && entry.source && vmManifest.values) {
        let values = vmManifest.values[_vmNameUri(entry.source)];
        if (values && (typeof values === "object")) {
          entry.storage = JSON.stringify(_decodeVmValues(values));
          entry.storageShape = "flat";
        }
      }
    }
  }

  return { "scripts": scripts, "vmManifest": vmManifest };
}

/**
 * Violentmonkey's name URI for a script, which its backup keys stored
 * values by: encodeFilename(namespace + "\n" + name + "\n") with the
 * script's own (unlocalised) @namespace and @name.
 *
 * @param {string} aSource - The script's source.
 * @returns {string}
 */
function _vmNameUri(aSource) {
  let block = /\/\/\s*==UserScript==([\s\S]*?)\/\/\s*==\/UserScript==/
      .exec(String(aSource));
  let meta = block ? block[1] : "";
  let first = function (aKey) {
    let m = new RegExp("^\\s*//\\s*@" + aKey + "[ \\t]+(.*?)\\s*$", "m")
        .exec(meta);
    return m ? m[1] : "";
  };
  return (first("namespace") + "\n" + first("name") + "\n")
      .replace(/[-\\/:*?"<>|%\s]/g, function (aChar) {
        let code = aChar.charCodeAt(0).toString(16);
        return "-" + ((code.length < 2) ? "0" + code : code);
      });
}

/**
 * Decodes Violentmonkey's stored values: each is a string whose first
 * letter gives its type ("s" string, "n" number, "b" boolean, "o" JSON).
 * Anything else (an older format) is taken as it is.
 *
 * @param {object} aRaw - {key: raw value}.
 * @returns {object} {key: value}.
 */
function _decodeVmValues(aRaw) {
  let out = {};
  Object.keys(aRaw).forEach(function (aKey) {
    let raw = aRaw[aKey];
    if ((typeof raw !== "string") || !raw) {
      out[aKey] = raw;
      return;
    }
    let rest = raw.slice(1);
    switch (raw.charAt(0)) {
      case "s":
        out[aKey] = rest;
        break;
      case "n":
        out[aKey] = Number(rest);
        break;
      case "b":
        out[aKey] = (rest === "true");
        break;
      case "o":
        try {
          out[aKey] = JSON.parse(rest);
        } catch (e) {
          out[aKey] = rest;
        }
        break;
      default:
        out[aKey] = raw;
    }
  });
  return out;
}

/**
 * Parses an archive WITHOUT installing anything: returns one row per
 * script entry so an import dialog can offer selective restore.
 *
 * @param {nsIFile} aSrcFile - The .zip to inspect.
 * @returns {object} {ok, error, hasSettings, warnings[], scripts: [{key,
 *   name, namespace, version, installed, hasStorage, depCount, error}]}.
 */
function GM_BackupPreview(aSrcFile) {
  let out = {
    "ok": false,
    "error": null,
    "hasSettings": false,
    "warnings": [],
    "scripts": [],
  };

  let parsed;
  try {
    parsed = _readZipContents(aSrcFile);
  } catch (e) {
    GM_util.logError("Backup preview: cannot read ZIP: " + e, false);
    out.error = "" + e;
    return out;
  }
  out.warnings = parsed.skipped.concat();

  let scripts = _collectScripts(parsed.entries, parsed.payloads).scripts;

  if (parsed.payloads[MANIFEST_FILENAME]) {
    try {
      let manifest = JSON.parse(parsed.payloads[MANIFEST_FILENAME]);
      out.hasSettings = !!(manifest && manifest.settings);
    } catch (e) {
      // No settings then.
    }
  }

  let config = GM_util.getService().config;
  let keys = Object.keys(scripts);
  for (let i = 0; i < keys.length; i++) {
    let key = keys[i];
    let entry = scripts[key];
    if (!entry.source) {
      continue;
    }
    let row = {
      "key": key,
      "name": null,
      "namespace": null,
      "version": null,
      "installed": false,
      "hasStorage": !!entry.storage,
      "depCount": 0,
      "error": null,
    };

    let options = null;
    if (entry.options) {
      try {
        options = _normalizeImportedOptions(JSON.parse(entry.options));
      } catch (e) {
        // Defaults below.
      }
    }
    if (options && Array.isArray(options.dependencies)) {
      row.depCount = options.dependencies.length;
    }
    let installUri = null;
    if (options && options.downloadURL) {
      try {
        installUri = GM_util.getUriFromUrl(options.downloadURL);
      } catch (e) {
        installUri = null;
      }
    }

    try {
      let s = parse(entry.source, installUri);
      if (!s || !s._name) {
        row.error = "no usable script name";
      } else {
        row.name = (s.localized && s.localized.name) || s._name;
        row.namespace = s._namespace || "";
        row.version = s._version || "";
        row.installed = config.installIsUpdate(s);
        if (s.parseErrors && s.parseErrors.length) {
          row.error = s.parseErrors.join("; ");
        }
      }
    } catch (e) {
      row.error = "" + e;
    }
    out.scripts.push(row);
  }

  out.scripts.sort(function (aA, aB) {
    return ("" + aA.name).localeCompare("" + aB.name);
  });
  out.ok = true;
  return out;
}


// \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\ Helpers \\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\

/**
 * Produces a filesystem-safe, unique basename for a script in the export
 * archive.  Disambiguates duplicates with "(2)", "(3)", etc.
 */
function _uniqueExportBasename(aScript, aTaken) {
  let raw = (aScript.localized && aScript.localized.name)
      || aScript._name
      || aScript.baseDirName
      || "script";
  let clean = cleanFilename(raw, "script");
  let name = clean;
  let i = 2;
  while (aTaken.indexOf(name) !== -1) {
    name = clean + " (" + i + ")";
    i++;
  }
  return name;
}

/**
 * Serialises the persisted per-script state that isn't recoverable from the
 * script source alone (enabled, user cludes, autoUpdate, etc.), plus the
 * table of archived dependency entries (format v2).
 */
function _buildOptionsJson(aScript, aDependencies) {
  return JSON.stringify({
    "name": aScript._name,
    "namespace": aScript._namespace,
    "version": aScript._version,
    "enabled": aScript._enabled,
    "checkRemoteUpdates": aScript.checkRemoteUpdates,
    "installTime": aScript._installTime,
    "firstInstallTime": aScript.firstInstallTime,
    "downloadURL": aScript._downloadURL,
    "updateURL": aScript._updateURL,
    "homepageURL": aScript._homepageURL,
    "userExcludes": aScript.userExcludes,
    "userIncludes": aScript.userIncludes,
    "userMatches": aScript.userMatches.map(function (m) { return m.pattern; }),
    "userOverride": aScript._userOverride,
    "httpOnlyCookies": aScript.httpOnlyCookies,
    // The Options window's choices; null follows the script's own.
    "userRunAt": aScript._userRunAt || null,
    "userNoframes": (typeof aScript._userNoframes == "boolean")
        ? aScript._userNoframes : null,
    "userInjectInto": aScript._userInjectInto || null,
    "dependencies": aDependencies || [],
  }, null, 2);
}

/**
 * Adds every cached dependency file of a script (@require / @resource /
 * @icon) to the archive under "<userJsName>.deps/<n>-<filename>" and
 * returns the table describing them for the options sidecar:
 *   [{ kind, name, url, entry, mimetype, charset }, …]
 * A dependency whose local file is missing is skipped — import falls back
 * to downloading it from its original URL, exactly as format v1 did for
 * everything.
 */
/**
 * Computes the lowercase hex SHA-256 of a file by streaming it through the
 * platform's native nsICryptoHash — no bytes are buffered in JS.  Used for
 * dependency dedup (content addressing) and import-time integrity checks.
 * A WebExtension has neither file access nor native file hashing.
 *
 * @param {nsIFile} aFile - File to hash.
 * @returns {string} 64-char lowercase hex digest.
 */
function sha256OfFile(aFile) {
  let istream = Cc["@mozilla.org/network/file-input-stream;1"]
      .createInstance(Ci.nsIFileInputStream);
  istream.init(aFile, 0x01 /* PR_RDONLY */, parseInt("444", 8), 0);
  try {
    let hasher = Cc["@mozilla.org/security/hash;1"]
        .createInstance(Ci.nsICryptoHash);
    hasher.init(Ci.nsICryptoHash.SHA256);
    hasher.updateFromStream(istream, 0xffffffff);
    let binary = hasher.finish(false);
    let hex = "";
    for (let i = 0; i < binary.length; i++) {
      hex += ("0" + binary.charCodeAt(i).toString(16)).slice(-2);
    }
    return hex;
  } finally {
    try { istream.close(); } catch (e) { /* best effort */ }
  }
}

function _exportDependencies(
    aZipWriter, aScript, aUserJsName, aQueue, aSeenHashes) {
  let out = [];
  let groups = [
    { "kind": "require", "list": aScript.requires },
    { "kind": "resource", "list": aScript.resources },
  ];
  try {
    let icon = aScript.icon;
    if (icon && icon._filename && icon.downloadURL) {
      groups.push({ "kind": "icon", "list": [icon] });
    }
  } catch (e) {
    // No usable icon — fine.
  }

  let index = 0;
  for (let g = 0; g < groups.length; g++) {
    let group = groups[g];
    for (let i = 0; i < group.list.length; i++) {
      let dep = group.list[i];
      try {
        if (!dep._filename || !dep.downloadURL) {
          continue;
        }
        let file = dep.file;
        if (!file || !file.exists()) {
          continue;
        }
        // Hash for dedup + an integrity value the importer can verify.
        // Hashing failure isn't fatal: store the bytes without a hash.
        let sha256 = null;
        try {
          sha256 = sha256OfFile(file);
        } catch (e) {
          sha256 = null;
        }
        let entry;
        if (sha256 && aSeenHashes && aSeenHashes[sha256]) {
          // Identical content is already in the archive — reference the
          // existing entry instead of storing the bytes again.
          entry = aSeenHashes[sha256];
        } else {
          entry = aUserJsName + ".deps/" + index + "-"
              + cleanFilename(file.leafName, "dependency");
          _addEntryFromFile(aZipWriter, entry, file, aQueue);
          if (sha256 && aSeenHashes) {
            aSeenHashes[sha256] = entry;
          }
          index++;
        }
        out.push({
          "kind": group.kind,
          "name": (group.kind == "resource") ? dep.name : null,
          "url": dep.downloadURL,
          "entry": entry,
          "sha256": sha256,
          "mimetype": dep._mimetype || null,
          "charset": dep._charset || null,
        });
      } catch (e) {
        GM_util.logError(
            "Backup export: dependency skipped for " + aScript.id
            + " - " + e, false);
      }
    }
  }
  return out;
}

/**
 * Dumps a script's GM_setValue store as Tampermonkey writes it,
 * {"ts": <ms>, "data": {key: value}}, which Tampermonkey and Violentmonkey
 * read (format 3; the bare map before couldn't be restored there).
 * Returns null (not "{}") when the script has no stored values, so the
 * empty sidecar file isn't added to the archive.
 */
function _buildStorageJson(aScript) {
  try {
    let storage = getStorageBackForScript(aScript);
    // No .db on disk = the script never stored a value.  Bail before the
    // lazy db getter would CREATE the file (and run its open-time VACUUM)
    // as a side effect — an export must not mutate the profile.  Going
    // through the module registry (instead of a private Back) also means
    // the connection is shared with the live script and closed at
    // shutdown rather than leaked.
    if (!storage.dbFile.exists()) {
      return null;
    }
    let keys = storage.listValues();
    if (!keys.length) return null;
    let out = {};
    for (let i = 0; i < keys.length; i++) {
      let raw = storage.getValue(keys[i]);
      try {
        out[keys[i]] = JSON.parse(raw);
      } catch (e) {
        out[keys[i]] = raw;
      }
    }
    return JSON.stringify({"ts": Date.now(), "data": out}, null, 2);
  } catch (e) {
    GM_util.logError("Backup storage dump failed: " + e, false);
    return null;
  }
}

/** Adds an on-disk file to the ZIP at the given entry path. */
function _addEntryFromFile(aZipWriter, aEntryName, aFile, aQueue) {
  aZipWriter.addEntryFile(
      aEntryName,
      Ci.nsIZipWriter.COMPRESSION_DEFAULT,
      aFile,
      !!aQueue);
}

/**
 * Adds a string (UTF-8 encoded) to the ZIP at the given entry path.
 * Uses nsIStringInputStream with the UTF-8 byte length so multi-byte
 * characters survive the round-trip.  When aQueue is true the entry is
 * queued for background-thread compression (see GM_BackupExport); the
 * string input stream is held by the writer's queue until processed.
 */
function _addEntryFromString(aZipWriter, aEntryName, aString, aQueue) {
  let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
      .createInstance(Ci.nsIScriptableUnicodeConverter);
  converter.charset = "UTF-8";
  let bytes = converter.ConvertFromUnicode(aString) + converter.Finish();

  let sis = Cc["@mozilla.org/io/string-input-stream;1"]
      .createInstance(Ci.nsIStringInputStream);
  sis.setData(bytes, bytes.length);

  // nsIZipWriter.addEntryStream takes the mod time in microseconds (PR_Now).
  let nowMicros = new Date().getTime() * 1000;
  aZipWriter.addEntryStream(
      aEntryName,
      nowMicros,
      Ci.nsIZipWriter.COMPRESSION_DEFAULT,
      sis,
      !!aQueue);
}

/**
 * Reads every entry of a ZIP file into memory and returns:
 *   { entries: [name, …], payloads: { name: string, … } }
 *
 * Entries representing directories (trailing "/") are excluded.  All payloads
 * are decoded as UTF-8 strings; binary entries aren't expected in a backup
 * archive.
 */
function _readZipContents(aSrcFile, aExtractDir) {
  let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"]
      .createInstance(Ci.nsIZipReader);
  zipReader.open(aSrcFile);
  try {
    let entries = [];
    let payloads = {};
    let depFiles = {};
    let skipped = [];
    let depIndex = 0;
    let iter = zipReader.findEntries("*");
    while (iter.hasMore()) {
      let name = iter.getNext();
      if (!name || name.charAt(name.length - 1) === "/") {
        continue;
      }
      // Zip-bomb guard: refuse to inflate any entry past the cap; record
      // the skip so the import result reports it instead of silently
      // pretending the archive was fully consumed.
      let realSize = 0;
      try {
        realSize = zipReader.getEntry(name).realSize;
      } catch (e) {
        // Unreadable entry record — let the read below throw if it must.
      }
      if (realSize > MAX_ENTRY_BYTES) {
        skipped.push(name + ": entry too large (" + realSize + " bytes)");
        continue;
      }
      if (name.indexOf(DEPS_INFIX) !== -1) {
        // Archived dependency payload (format v2).  Stream it straight to a
        // temp file via the native zip reader instead of buffering its
        // bytes in memory, so import stays roughly constant-memory no
        // matter how large the archive (a WebExtension using JSZip/fflate
        // must hold the whole thing in memory).  No extract dir = caller
        // only wants metadata (GM_BackupPreview), so skip the payload.
        if (aExtractDir) {
          try {
            let outFile = aExtractDir.clone();
            outFile.append("dep-" + depIndex);
            depIndex++;
            zipReader.extract(name, outFile);
            depFiles[name] = outFile;
          } catch (e) {
            GM_util.logError(
                "Backup import: could not extract " + name + " - " + e,
                false);
          }
        }
        continue;
      }
      entries.push(name);
      payloads[name] = _readEntryAsString(zipReader, name);
    }
    return {
      "entries": entries,
      "payloads": payloads,
      "depFiles": depFiles,
      "skipped": skipped,
    };
  } finally {
    try { zipReader.close(); } catch (e) { /* ignore */ }
  }
}

/** Reads a single ZIP entry as a UTF-8 string. */
function _readEntryAsString(aZipReader, aEntryName) {
  let stream = aZipReader.getInputStream(aEntryName);
  try {
    let cis = Cc["@mozilla.org/intl/converter-input-stream;1"]
        .createInstance(Ci.nsIConverterInputStream);
    // Replace malformed sequences with U+FFFD rather than throwing.
    cis.init(stream, "UTF-8", 0,
        Ci.nsIConverterInputStream.DEFAULT_REPLACEMENT_CHARACTER);
    try {
      let chunks = [];
      let out = {};
      let n;
      do {
        n = cis.readString(4096, out);
        if (n) chunks.push(out.value);
      } while (n);
      return chunks.join("");
    } finally {
      cis.close();
    }
  } finally {
    try { stream.close(); } catch (e) { /* some impls auto-close */ }
  }
}

/**
 * Installs the archive's scripts, strictly one at a time and in the
 * archive's order, so the scripts directory and config.xml are written one
 * entry at a time and the execution order is the archive's.  Each is
 * prepared first (sidecar, archived dependencies, parse, "already
 * installed" check).  A script whose @require / @resource / @icon files
 * are all archived (our own backups), or that has none, installs with
 * them.  One whose files are on the web installs at once without them,
 * waiting for them (Script.markDependenciesPending), and they are fetched
 * after its install, several scripts' at once (IMPORT_FILES_AT_ONCE /
 * IMPORT_SCRIPTS_AT_ONCE), as Violentmonkey does: waiting for them first
 * made every script wait for the slowest site before it.  aOpts carries
 * the import options (overwrite / restoreValues / onProgress) documented
 * on GM_BackupImport.
 *
 * The work is done in slices of about IMPORT_SLICE_MS (installing a
 * script, or preparing one and writing its file, as many as fit), and the
 * browser gets its turn between them.  Doing it all back to back (every
 * prepare up front, every finished download's install at once) froze the
 * browser for seconds at a time on a 200-script backup.
 *
 * @param {string[]} aKeys      - Archive keys to install, in order.
 * @param {object}   aScripts   - Archive entries by key (_collectScripts).
 * @param {object}   aDepFiles  - Extracted archived dependency files.
 * @param {object}   aOpts
 * @param {object}   aResult    - {imported, skipped, errors, fetching},
 *   filled in; fetching counts the scripts installed without their files.
 * @param {function} aDone      - Called once, after the last install.
 * @param {function} [aFetchesDone] - Called once, after that and the last
 *   fetch, with the failures: [{key, name, message, gaveUp}].
 */
function _installAll(
    aKeys, aScripts, aDepFiles, aOpts, aResult, aDone, aFetchesDone) {
  // Filled in as each is prepared; emptied again once installed.
  let jobs = [];
  let nextToStart = 0;
  let nextToInstall = 0;
  let filesInFlight = 0;
  let scriptsInFlight = 0;
  let scheduled = false;
  let finished = false;
  // The ids of the scripts this import installed: a second copy in the
  // archive is "already installed", even while the first still waits for
  // its files.
  let thisImport = new Set();
  aResult.fetching = 0;

  let schedule = function () {
    if (!scheduled) {
      scheduled = true;
      _nextTurn(step);
    }
  };

  // The files a job downloads before its install: none for one that gets
  // them after.
  let costNow = function (aJob) {
    return aJob.deferred ? 0 : aJob.cost;
  };

  let hasRoom = function (aJob) {
    if (scriptsInFlight >= IMPORT_SCRIPTS_AT_ONCE) {
      return false;
    }
    // One script is always let through, however many files it has.
    return (scriptsInFlight == 0)
        || (filesInFlight + costNow(aJob) <= IMPORT_FILES_AT_ONCE);
  };

  // Prepares the next script and starts its downloads (or the writing of
  // its file) if there is room.  Returns whether it got anywhere; when
  // there was no room, a download's end brings the next step.
  let startNext = function () {
    let job = jobs[nextToStart];
    if (!job) {
      job = _prepareImport(aKeys[nextToStart], aScripts[aKeys[nextToStart]],
          aDepFiles, aOpts, thisImport);
      job.index = nextToStart;
      job.total = aKeys.length;
      jobs[nextToStart] = job;
    }
    if (job.state != "waiting") {
      // Skipped: nothing to download.
      nextToStart++;
      return true;
    }
    if (!hasRoom(job)) {
      return false;
    }
    nextToStart++;
    scriptsInFlight++;
    filesInFlight += costNow(job);
    _downloadForImport(job, function () {
      scriptsInFlight--;
      filesInFlight -= costNow(job);
      schedule();
    });
    return true;
  };

  // The files of the scripts installed without them.
  let fetchQueue = [];
  let fetchScripts = 0;
  let fetchFiles = 0;
  let fetchFailures = [];
  let fetchesReported = false;
  let reportFetches = function () {
    if (finished && !fetchQueue.length && !fetchScripts && !fetchesReported) {
      fetchesReported = true;
      if (aFetchesDone) {
        aFetchesDone(fetchFailures);
      }
    }
  };
  let startFetches = function () {
    while (fetchQueue.length && (fetchScripts < IMPORT_SCRIPTS_AT_ONCE)
        && !Services.startup.shuttingDown) {
      let job = fetchQueue[0];
      if (fetchScripts && (fetchFiles + job.cost > IMPORT_FILES_AT_ONCE)) {
        break;
      }
      fetchQueue.shift();
      fetchScripts++;
      fetchFiles += job.cost;
      job.parsedScript.fetchPendingDependencies({
        "dependencyMs": IMPORT_DEPENDENCY_TIMEOUT_MS,
        "iconMs": IMPORT_ICON_TIMEOUT_MS,
        "prefetch": job.prefetch,
        "source": job.source,
      }, function (aSuccess, aMessage, aGaveUp) {
        fetchScripts--;
        fetchFiles -= job.cost;
        if (!aSuccess && aMessage) {
          fetchFailures.push({
            "gaveUp": !!aGaveUp,
            "key": job.key,
            "message": aMessage,
            "name": job.parsedScript.name,
          });
        }
        startFetches();
        reportFetches();
      });
    }
  };

  // One piece of work: install the next script if it is ready, or prepare
  // the next one and start its downloads.  Returns whether there may be
  // more to do now.
  let work = function () {
    if (Services.startup.shuttingDown) {
      // The browser is closing: config.xml has just been written
      // (Config.flushSave), and a script installed after that would be
      // left out of it, an orphaned folder.  The import stops; importing
      // again installs the rest.
      finished = true;
      return false;
    }
    if (nextToInstall >= aKeys.length) {
      finished = true;
      aDone();
      reportFetches();
      return false;
    }
    let head = jobs[nextToInstall];
    if (head && (head.state != "waiting") && (head.state != "downloading")) {
      _commitImport(head, aOpts, aResult, thisImport);
      if (head.deferred && head.installed) {
        aResult.fetching++;
        fetchQueue.push(head);
        startFetches();
      }
      jobs[nextToInstall] = null;
      nextToInstall++;
      return true;
    }
    return (nextToStart < aKeys.length) && startNext();
  };

  let step = function () {
    scheduled = false;
    let deadline = Date.now() + IMPORT_SLICE_MS;
    while (!finished) {
      if (!work()) {
        // Waiting for a download (its end schedules the next step), or
        // done.
        return undefined;
      }
      if (Date.now() >= deadline) {
        schedule();
        return undefined;
      }
    }
  };

  schedule();
}

/**
 * Runs aFn at the next turn of the event loop, after what is already
 * waiting (clicks, scrolling, painting).  A 0 ms timer waited for the next
 * tick of the system clock, ~16 ms on Windows: an import's slices spent
 * half their time on it.
 *
 * @param {function} aFn
 */
function _nextTurn(aFn) {
  Services.tm.mainThread.dispatch({
    "run": aFn,
  }, Ci.nsIThread.DISPATCH_NORMAL);
}

/**
 * Tells the user, once an import's fetches are over, which of its scripts
 * couldn't get their @require / @resource files: those still waiting (the
 * next start tries again; importing again does it now) and those marked
 * broken, which switches them off (Script.fetchPendingDependencies).  Each
 * reason goes to the Browser Console.
 *
 * @param {Array} aFailures - [{key, name, message, gaveUp}].
 */
function _reportFetchFailures(aFailures) {
  if (!aFailures || !aFailures.length) {
    return undefined;
  }
  aFailures.forEach(function (aFailure) {
    GM_util.logError("Backup import: " + aFailure.key
        + ": dependency download failed - " + aFailure.message, false);
  });
  let notify = function (aList, aKey, aFallback, aTopic) {
    if (!aList.length) {
      return undefined;
    }
    let text = aFallback;
    try {
      text = GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties).GetStringFromName(aKey);
    } catch (e) {
      // This locale doesn't have it yet: the English.
    }
    let names = aList.map(function (aFailure) {
      return aFailure.name;
    }).join(", ");
    // Functions, so a "$" in a name is taken literally.
    GM_notification(text
        .replace("%1", function () { return aList.length; })
        .replace("%2", function () { return names; }),
        aTopic, { "persistence": -1, "persistWhileVisible": true });
  };
  notify(aFailures.filter(function (aFailure) {
    return !aFailure.gaveUp;
  }), "backup.dependenciesRetry",
      "%1 imported scripts couldn't get their @require or @resource files"
      + " yet, so they don't run.  Greasemonkey tries again the next time"
      + " it starts, or import them again to try now: %2",
      "greasemonkey-import-dependencies-retry");
  notify(aFailures.filter(function (aFailure) {
    return aFailure.gaveUp;
  }), "backup.dependenciesFailed",
      "%1 imported scripts couldn't get their @require or @resource files,"
      + " so they are switched off (marked broken in the Add-ons Manager):"
      + " %2",
      "greasemonkey-import-dependencies-failed");
}

/**
 * Everything about one archive entry that needs no download: its sidecar
 * (translated from Violentmonkey / Tampermonkey), its archived dependency
 * files, the parsed script, and whether it is installed already.
 *
 * @returns {object} The job: {key, entry, source, options, prefetch,
 *   parsedScript, cost, state, error, remoteScript}.  state is "waiting"
 *   (to download) or "skipped" (error says why).
 */
function _prepareImport(aKey, aEntry, aDepFiles, aOpts, aThisImport) {
  let job = {
    "cost": 0,
    "entry": aEntry,
    "error": null,
    "key": aKey,
    "notes": [],
    "options": null,
    "parsedScript": null,
    "prefetch": null,
    "remoteScript": null,
    "source": aEntry.source,
    "state": "waiting",
  };
  let skip = function (aWhy) {
    job.state = "skipped";
    job.error = aWhy;
    return job;
  };

  let options = null;
  if (aEntry.options) {
    try {
      options = JSON.parse(aEntry.options);
    } catch (e) {
      // Bad sidecar — install the script with defaults.
      options = null;
    }
  }
  // Translate foreign sidecar schemas (Violentmonkey config/custom,
  // Tampermonkey options/settings/meta) into our flat shape; our own
  // sidecars pass through unchanged.
  options = _normalizeImportedOptions(options);
  if (options && Array.isArray(options.notes)) {
    job.notes = options.notes.slice();
  }
  job.options = options;

  // Map each archived dependency (format v2) to its extracted temp file so
  // the install can pre-seed it: restore works offline and dead URLs keep
  // working.  Anything not in the archive downloads normally.
  let prefetch = null;
  if (options && Array.isArray(options.dependencies)) {
    for (let d = 0; d < options.dependencies.length; d++) {
      let dep = options.dependencies[d];
      if (!dep || !dep.url || !dep.entry
          || !aDepFiles || !(dep.entry in aDepFiles)) {
        continue;
      }
      let depFile = aDepFiles[dep.entry];
      // Verify the extracted bytes against the recorded hash before
      // trusting them: a corrupt or tampered dependency falls back to a
      // fresh download rather than being installed silently (the import
      // otherwise bypasses the normal install review).
      if (dep.sha256) {
        let actual = null;
        try {
          actual = sha256OfFile(depFile);
        } catch (e) {
          actual = null;
        }
        if (actual !== dep.sha256) {
          job.notes.push("dependency " + (dep.name || dep.url)
              + " failed integrity check; re-downloading");
          continue;
        }
      }
      prefetch = prefetch || {};
      prefetch[dep.url] = {
        "file": depFile,
        "mimetype": dep.mimetype || null,
        "charset": dep.charset || null,
      };
    }
  }
  job.prefetch = prefetch;

  // Synthesise an install URI from the sidecar's downloadURL so that
  // parseScript.js populates script._namespace (from aUri.host) and
  // script.downloadURL (from aUri.spec) the same way it did on the
  // original install.  Without this, scripts that have no explicit
  // @namespace in their source would get an empty namespace on re-import,
  // breaking duplicate detection (id = name@namespace) and leaving
  // downloadURL null, which in turn marks the imported script as
  // non-updatable (yellow-stripes) even though we have a perfectly good
  // download URL in the sidecar.
  let installUri = null;
  if (options && options.downloadURL) {
    try {
      installUri = GM_util.getUriFromUrl(options.downloadURL);
    } catch (e) {
      installUri = null;
    }
  }

  let parsedScript;
  try {
    parsedScript = parse(job.source, installUri);
  } catch (e) {
    return skip("parse failed - " + e);
  }
  if (!parsedScript || !parsedScript._name) {
    return skip("parse produced no usable script");
  }
  // The normal install pipeline refuses scripts with recoverable parse
  // problems (invalid @match, bad @require/@resource URLs — see
  // remoteScript.js); installing them here would silently drop those
  // directives and ship a script that malfunctions at runtime.  Match the
  // pipeline: report and skip.
  if (parsedScript.parseErrors && parsedScript.parseErrors.length) {
    return skip("parse errors - " + parsedScript.parseErrors.join("; "));
  }
  job.parsedScript = parsedScript;

  // Skipped early so it isn't downloaded for nothing; checked again at
  // install time, when an earlier entry of this archive may have
  // installed the same script.
  if (_importClashes(parsedScript, aOpts, aThisImport)) {
    return skip("already installed");
  }

  job.cost = _importDownloadCount(parsedScript, prefetch);
  // Files from the web: the script is installed at once, without them,
  // and they are fetched after (see _installAll).
  job.deferred = job.cost > 0;
  return job;
}

/**
 * @returns {boolean} Whether aScript's (name, namespace) is installed and
 *   the import doesn't overwrite.  With aOpts.overwrite the install is an
 *   in-place update instead: config.install() resolves the existing script,
 *   keeps its list position, and its stored values carry over via
 *   basedir-name reuse; the sidecar's options/values then apply on top.
 *   An installed copy that couldn't get its files (broken, or still
 *   waiting for them) doesn't count: importing again replaces it the same
 *   way, which is how to try again now.  One this import installed
 *   (aThisImport: their ids) always does.
 */
function _importClashes(aScript, aOpts, aThisImport) {
  if (aOpts && aOpts.overwrite) {
    return false;
  }
  if (aThisImport && aThisImport.has(aScript.id)) {
    return true;
  }
  let installed = _installedCopy(aScript);
  return !!installed && !installed.broken && !installed._dependenciesPending;
}

/**
 * @param {Script} aScript
 * @returns {?Script} The installed script with aScript's id.
 */
function _installedCopy(aScript) {
  let config = GM_util.getService().config;
  if (!config.installIsUpdate(aScript)) {
    return null;
  }
  return config.getMatchingScripts(function (aInstalled) {
    return aInstalled.id == aScript.id;
  })[0] || null;
}

/**
 * @returns {number} How many files aScript downloads at once: those of its
 *   dependencies that aren't archived (aPrefetch) or data: addresses, up to
 *   RemoteScript's per-script limit.
 */
function _importDownloadCount(aScript, aPrefetch) {
  let count = 0;
  let deps = aScript.dependencies;
  for (let i = 0; i < deps.length; i++) {
    let url = deps[i].downloadURL;
    if (url && !/^data:/i.test(url) && !(aPrefetch && (url in aPrefetch))) {
      count++;
    }
  }
  return Math.min(count, RemoteScript.DEPENDENCY_DOWNLOADS_AT_ONCE);
}

/**
 * Downloads one job's dependency files into a RemoteScript's temp folder,
 * with time limits.  Sets aJob.state to "ready" or "failed" (aJob.error),
 * then calls aDone once.
 */
function _downloadForImport(aJob, aDone) {
  let fail = function (aWhy) {
    aJob.state = "failed";
    aJob.error = aWhy;
    aDone();
  };
  let remoteScript;
  let tempFile;
  try {
    remoteScript = new RemoteScript();
    // Its own new, empty folder: the name is free as it is.
    tempFile = remoteScript._tempDir.clone();
    tempFile.append(
        cleanFilename(aJob.parsedScript.name, GM_CONSTANTS.fileScriptName)
        + GM_CONSTANTS.fileScriptExtension);
  } catch (e) {
    fail("setup failed - " + e);
    return undefined;
  }
  aJob.remoteScript = remoteScript;
  aJob.state = "downloading";

  let written = function (aWriteErr) {
    if (aWriteErr) {
      fail("temp write failed - " + aWriteErr);
      return undefined;
    }
    try {
      remoteScript.setScript(aJob.parsedScript, tempFile);
      remoteScript.setSilent(true);
      if (aJob.deferred) {
        // Installed without its files, which are fetched after.
        aJob.state = "ready";
        aDone();
        return undefined;
      }
      if (aJob.prefetch) {
        remoteScript.setPrefetchedDependencies(aJob.prefetch);
      }
      remoteScript.setDownloadTimeouts(
          IMPORT_DEPENDENCY_TIMEOUT_MS, IMPORT_ICON_TIMEOUT_MS);
      remoteScript.download(function (aSuccess) {
        if (aSuccess) {
          aJob.state = "ready";
          aDone();
        } else {
          fail("dependency download failed"
              + (remoteScript.errorMessage
                  ? " - " + remoteScript.errorMessage : ""));
        }
      });
    } catch (e) {
      fail("download setup failed - " + e);
    }
    return undefined;
  };
  // On OS.File's own thread: creating and opening the file (twice, with
  // GM_util.writeToFile) cost the browser's thread a few ms per script.
  OS.File.writeAtomic(tempFile.path, new TextEncoder().encode(aJob.source))
      .then(function () {
        written(null);
      }, function (aError) {
        written(aError || "the file can't be written");
      });
  return undefined;
}

/**
 * Installs one prepared, downloaded job, or records why it wasn't, then
 * applies its sidecar options and stored values.
 */
function _commitImport(aJob, aOpts, aResult, aThisImport) {
  if (aOpts && (typeof aOpts.onProgress === "function")) {
    try {
      aOpts.onProgress(aJob.index, aJob.total, aJob.key);
    } catch (e) {
      // Progress UI must never break the import.
    }
  }
  aJob.notes.forEach(function (aNote) {
    aResult.errors.push(aJob.key + ": " + aNote);
  });
  let notInstalled = function (aWhy) {
    aResult.skipped++;
    aResult.errors.push(aJob.key + ": " + aWhy);
    if (aJob.remoteScript) {
      // Its temp folder goes.
      aJob.remoteScript.cleanup();
    }
  };
  if (aJob.state != "ready") {
    notInstalled(aJob.error);
    return undefined;
  }
  if (_importClashes(aJob.parsedScript, aOpts, aThisImport)) {
    notInstalled("already installed");
    return undefined;
  }
  try {
    if (aJob.deferred) {
      aJob.parsedScript.markDependenciesPending();
    }
    // A broken copy this replaces was switched off by Greasemonkey, not by
    // the user: the new one doesn't take that over (config.install() copies
    // the old copy's on/off), unless the backup says so.
    let replaced = _installedCopy(aJob.parsedScript);
    let wasBroken = !!replaced && replaced.broken;
    aJob.remoteScript.install();
    if (wasBroken) {
      aJob.parsedScript._enabled = true;
    }
    _applyImportedOptions(aJob.parsedScript, aJob.options);
    if (aJob.entry.storage && !(aOpts && (aOpts.restoreValues === false))) {
      _applyImportedStorage(
          aJob.parsedScript, aJob.entry.storage, aJob.entry.storageShape);
    }
    aResult.imported++;
    aJob.installed = true;
    if (aThisImport) {
      aThisImport.add(aJob.parsedScript.id);
    }
  } catch (e) {
    aResult.skipped++;
    aResult.errors.push(aJob.key + ": install failed - " + e);
  }
  return undefined;
}

/**
 * Translates a foreign per-script options sidecar into our flat shape.
 *
 * Detection:
 *   - Violentmonkey: state nested under config ({enabled, shouldUpdate} as
 *     0/1 numbers) and custom ({include/match/exclude arrays, downloadURL,
 *     lastInstallURL, origInclude/origMatch/origExclude, runAt, noframes,
 *     injectInto}).
 *   - Tampermonkey: {options: {override: {use_* lists, merge_* booleans,
 *     noframes}, check_for_updates, run_at}, settings: {enabled,
 *     position}, meta: {file_url}}.
 *   - Anything else (our own exports) passes through unchanged.
 *
 * The result may carry `notes`: what this import couldn't keep, for the
 * import result.
 */
function _normalizeImportedOptions(aRaw) {
  if (!aRaw || typeof aRaw !== "object") {
    return null;
  }

  // Violentmonkey (zip index entry with config/custom nesting).
  if (aRaw.config || aRaw.custom) {
    let config = aRaw.config || {};
    let custom = aRaw.custom || {};
    let out = {"notes": []};
    if (config.enabled != null) {
      out.enabled = !!+config.enabled;
    }
    if ((config.shouldUpdate != null) && !+config.shouldUpdate) {
      out.checkRemoteUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    // Its per-script "Allow GM_cookie to access HTTP-only cookies".
    if (config.httpOnly != null) {
      out.httpOnlyCookies = !!+config.httpOnly;
    }
    // A user-set download URL, else the address it was installed from
    // (without it a script with no @downloadURL couldn't update).
    if (custom.downloadURL) {
      out.downloadURL = "" + custom.downloadURL;
    } else if (custom.lastInstallURL) {
      out.downloadURL = "" + custom.lastInstallURL;
    }
    if (custom.homepageURL) {
      out.homepageURL = "" + custom.homepageURL;
    }
    _importUserRules(out, custom.include, custom.match, custom.exclude,
        custom.origInclude !== false, custom.origMatch !== false,
        custom.origExclude !== false, "Violentmonkey");
    _importUserSettings(out, custom.runAt, custom.noframes, custom.injectInto);
    return out;
  }

  // Tampermonkey (.options.json with options/settings/meta).
  if (aRaw.settings || aRaw.meta
      || (aRaw.options && (typeof aRaw.options === "object"))) {
    let tmOptions = aRaw.options || {};
    let override = tmOptions.override || {};
    let settings = aRaw.settings || {};
    let meta = aRaw.meta || {};
    let out = {"notes": []};
    if (typeof settings.enabled === "boolean") {
      out.enabled = settings.enabled;
    }
    if (tmOptions.check_for_updates === false) {
      out.checkRemoteUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    if (meta.file_url) {
      out.downloadURL = "" + meta.file_url;
    }
    // use_* are the user's own lists; merge_* (booleans, true when
    // absent) say whether the script's own still count.
    _importUserRules(out, override.use_includes, override.use_matches,
        override.use_excludes, override.merge_includes !== false,
        override.merge_matches !== false, override.merge_excludes !== false,
        "Tampermonkey");
    _importUserSettings(out, tmOptions.run_at, override.noframes, null);
    return out;
  }

  return aRaw;
}

/**
 * Maps another manager's user rules to ours.  They choose per list whether
 * the script's own @include, @match and @exclude still count (Tampermonkey
 * merge_*, Violentmonkey origInclude / origMatch / origExclude); we have
 * one switch, userOverride, which drops all three.
 *   - The user's lists are imported as they are.
 *   - userOverride only when the script's own includes or matches were off
 *     AND the user has includes or matches of their own.  With none,
 *     userOverride means "run on every site": importing a single user
 *     exclude used to turn that on.
 *   - With userOverride, script @exclude rules the other manager kept are
 *     copied into the user excludes (keepScriptExcludes).
 *   - What can't be expressed keeps the script's own rules, with a note.
 *
 * @param {object}  aOut          - The normalised options being built.
 * @param {Array}   aIncludes     - The user's @include rules.
 * @param {Array}   aMatches      - The user's @match rules.
 * @param {Array}   aExcludes     - The user's @exclude rules.
 * @param {boolean} aKeepIncludes - The script's own @include still count.
 * @param {boolean} aKeepMatches  - The script's own @match still count.
 * @param {boolean} aKeepExcludes - The script's own @exclude still count.
 * @param {string}  aFrom         - The other manager's name, for notes.
 */
function _importUserRules(aOut, aIncludes, aMatches, aExcludes,
    aKeepIncludes, aKeepMatches, aKeepExcludes, aFrom) {
  let list = function (aList) {
    return Array.isArray(aList) ? aList.filter(function (aRule) {
      return (typeof aRule === "string") && (aRule !== "");
    }) : [];
  };
  let includes = list(aIncludes);
  let matches = list(aMatches);
  let excludes = list(aExcludes);
  aOut.userIncludes = includes;
  aOut.userMatches = matches;
  aOut.userExcludes = excludes;

  let replace = !aKeepIncludes || !aKeepMatches;
  if (replace && (includes.length || matches.length)) {
    aOut.userOverride = true;
    if (aKeepExcludes) {
      aOut.keepScriptExcludes = true;
    }
    return undefined;
  }
  aOut.userOverride = false;
  if (replace) {
    aOut.notes.push(aFrom + " had the script's own @include / @match rules"
        + " off, with none of the user's own instead; they stay on.");
  }
  if (!aKeepExcludes) {
    aOut.notes.push(aFrom + " had the script's own @exclude rules off;"
        + " they stay on.");
  }
  return undefined;
}

/**
 * Maps another manager's Run at / No frames / Inject into choices to the
 * Options window's.  Unknown values are left out.
 *
 * @param {object}         aOut       - The normalised options being built.
 * @param {string}         aRunAt     - e.g. "document-start".
 * @param {number|boolean} aNoframes  - 0 / 1 (Violentmonkey) or a boolean.
 * @param {string}         aInjectInto - "auto", "page" or "content".
 */
function _importUserSettings(aOut, aRunAt, aNoframes, aInjectInto) {
  if (RUN_AT_VALUES.indexOf(aRunAt) > -1) {
    aOut.userRunAt = aRunAt;
  }
  if ((aNoframes !== null) && (aNoframes !== undefined) && (aNoframes !== "")) {
    aOut.userNoframes = !!+aNoframes;
  }
  if (INJECT_INTO_VALUES.indexOf(aInjectInto) > -1) {
    aOut.userInjectInto = aInjectInto;
  }
}

/**
 * After a successful install, applies sidecar-provided options to the
 * live Script object.  `installTime` is deliberately NOT restored — it was
 * just set to "now" by the install pipeline and replacing it with the
 * exporter's timestamp would confuse the modified-since-install check.
 * The first-install date is restored, being history rather than that
 * baseline.  downloadURL is also not touched here — it was already
 * populated during parse() from the synthesised install URI, and we want
 * it to reflect the URL the import used (which matches the sidecar's
 * value anyway).
 */
function _applyImportedOptions(aScript, aOptions) {
  if (!aOptions || typeof aOptions !== "object") return;
  try {
    if (typeof aOptions.enabled === "boolean") {
      aScript._enabled = aOptions.enabled;
    }
    if (typeof aOptions.checkRemoteUpdates === "number") {
      aScript.checkRemoteUpdates = aOptions.checkRemoteUpdates;
    } else if (aOptions.autoUpdate === false) {
      // Legacy 3.6.0-beta exports carried a boolean `autoUpdate` field
      // instead of checkRemoteUpdates; preserve the intent by mapping to
      // the equivalent AOM AUTOUPDATE_DISABLE state.
      aScript.checkRemoteUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    // Restore the explicit update URL only if the script didn't set one via
    // @updateURL in its source.  Scripts that carry @updateURL should keep
    // whatever the source said; scripts that rely on the sidecar-persisted
    // value otherwise lose it on re-import.
    if (aOptions.updateURL && !aScript._updateURL) {
      aScript._updateURL = "" + aOptions.updateURL;
    }
    // Restore a homepage the source doesn't declare (e.g. a Violentmonkey
    // custom one), but not one Greasemonkey itself guessed: up to 3.9 it
    // saved the @namespace, the script page or the install URL as if
    // declared.  Those are derived again on read (Script.homepageURL), and
    // restoring one as declared would hide the script page.
    let homepage = aOptions.homepageURL ? "" + aOptions.homepageURL : null;
    let guessed = !!homepage && [aScript.namespace, aScript.scriptPageURL,
        aScript.downloadURL].some(function (aUrl) {
          // The guess was stored normalised, e.g. with a trailing "/".
          return !!aUrl
              && (aUrl.replace(/\/$/, "") == homepage.replace(/\/$/, ""));
        });
    if (homepage && !aScript._homepageURL && !guessed) {
      aScript._homepageURL = homepage;
    }
    if (Array.isArray(aOptions.userIncludes)) {
      aScript.userIncludes = aOptions.userIncludes;
    }
    if (Array.isArray(aOptions.userExcludes)) {
      aScript.userExcludes = aOptions.userExcludes;
    }
    if (aOptions.keepScriptExcludes) {
      // userOverride drops the script's own @exclude rules, which the
      // other manager kept: they become user excludes.
      let excludes = aScript.userExcludes;
      aScript.excludes.forEach(function (aExclude) {
        if (excludes.indexOf(aExclude) == -1) {
          excludes.push(aExclude);
        }
      });
      aScript.userExcludes = excludes;
    }
    // The Options window's choices (our own backups from format 3, and
    // Violentmonkey's / Tampermonkey's).  null follows the script's own.
    if ("userRunAt" in aOptions) {
      aScript.runAt = (RUN_AT_VALUES.indexOf(aOptions.userRunAt) > -1)
          ? aOptions.userRunAt : null;
    }
    if ("userNoframes" in aOptions) {
      aScript.noframes = (typeof aOptions.userNoframes === "boolean")
          ? aOptions.userNoframes : null;
    }
    if ("userInjectInto" in aOptions) {
      aScript.injectInto =
          (INJECT_INTO_VALUES.indexOf(aOptions.userInjectInto) > -1)
              ? aOptions.userInjectInto : null;
    }
    if (Array.isArray(aOptions.userMatches)) {
      aScript.userMatches = aOptions.userMatches;
    }
    if (typeof aOptions.userOverride === "boolean") {
      aScript._userOverride = aOptions.userOverride;
    }
    if (typeof aOptions.httpOnlyCookies === "boolean") {
      aScript.httpOnlyCookies = aOptions.httpOnlyCookies;
    }
    // The earliest first install known wins: the backup's, or the copy's
    // this import replaced.  A backup from before 3.10 has only
    // installTime, its last install or update before the export, which
    // still comes before this import.
    let firstInstalls = [aOptions.firstInstallTime, aOptions.installTime,
        aScript.firstInstallTime].filter(function (aTime) {
          return (typeof aTime === "number") && (aTime > 0)
              && (aTime <= Date.now());
        });
    if (firstInstalls.length) {
      aScript._firstInstallTime = Math.min.apply(null, firstInstalls);
    }
    aScript._changed("modified", null);
  } catch (e) {
    GM_util.logError("Backup import: apply options failed: " + e, false);
  }
}

/**
 * @param {*} aParsed - A parsed .storage.json.
 * @returns {boolean} Whether it has Tampermonkey's shape, {"data": {...}}
 *   with at most a "ts" besides.
 */
function _isWrappedStorage(aParsed) {
  return !!aParsed && (typeof aParsed.data === "object")
      && (aParsed.data !== null) && !Array.isArray(aParsed.data)
      && Object.keys(aParsed).every(function (aKey) {
        return (aKey === "data") || (aKey === "ts");
      });
}

/**
 * Writes imported GM values into the script's SQLite store, in one
 * transaction.  Existing keys (from a prior install) are overwritten.
 *
 * @param {Script} aScript
 * @param {string} aStorageJson - The .storage.json.
 * @param {string} [aShape]     - "wrapped" ({"ts", "data"}: ours from
 *   format 3, Tampermonkey's), "flat" (the bare map: ours before, and
 *   Violentmonkey's decoded values) or "auto" (wrapped when it has that
 *   shape).  See _collectScripts.
 */
function _applyImportedStorage(aScript, aStorageJson, aShape) {
  let data;
  try {
    data = JSON.parse(aStorageJson);
  } catch (e) {
    GM_util.logError("Backup import: bad storage JSON: " + e, false);
    return;
  }
  if (!data || typeof data !== "object") return;
  if ((aShape === "wrapped")
      || ((aShape !== "flat") && _isWrappedStorage(data))) {
    data = _isWrappedStorage(data) ? data.data : null;
    if (!data) return;
  }
  try {
    // Module registry, not a private Back: shared with the live script and
    // closed at shutdown instead of leaking an open SQLite connection.
    getStorageBackForScript(aScript).setValuesBatch(data);
  } catch (e) {
    GM_util.logError("Backup import: storage write failed: " + e, false);
  }
}

/**
 * Snapshots the whitelisted extensions.greasemonkey.* prefs for the
 * manifest's settings block: only the ones the user has changed.  A
 * default written into a backup would come back as a user value on
 * import, and pin that default once a later version changes it.
 */
function _exportSettingsPrefs() {
  let out = {};
  for (let i = 0; i < SETTINGS_PREFS.length; i++) {
    try {
      if (!GM_prefRoot.pref.prefHasUserValue(SETTINGS_PREFS[i])) {
        continue;
      }
      let value = GM_prefRoot.getValue(SETTINGS_PREFS[i]);
      if (typeof value !== "undefined") {
        out[SETTINGS_PREFS[i]] = value;
      }
    } catch (e) {
      // Leave the key out.
    }
  }
  return out;
}

/**
 * Applies a manifest settings block: global excludes plus the whitelisted
 * prefs.  Only primitive values are accepted, and only keys on the
 * whitelist — a tampered archive can't write arbitrary preferences.
 */
function _applyImportedSettings(aSettings, aResult) {
  if (!aSettings || typeof aSettings !== "object") {
    return;
  }

  if (Array.isArray(aSettings.globalExcludes)) {
    try {
      let service = GM_util.getService();
      service.config.globalExcludes =
          aSettings.globalExcludes.filter(function (aItem) {
            return typeof aItem === "string";
          });
      service.broadcastScriptUpdates();
    } catch (e) {
      GM_util.logError("Backup import: global excludes failed: " + e, false);
      aResult.errors.push("global excludes restore failed: " + e);
    }
  }

  if (aSettings.prefs && (typeof aSettings.prefs === "object")) {
    for (let i = 0; i < SETTINGS_PREFS.length; i++) {
      let key = SETTINGS_PREFS[i];
      if (!(key in aSettings.prefs)) {
        continue;
      }
      let value = aSettings.prefs[key];
      let type = typeof value;
      if ((type !== "boolean") && (type !== "number") && (type !== "string")) {
        continue;
      }
      try {
        GM_prefRoot.setValue(key, value);
      } catch (e) {
        GM_util.logError(
            "Backup import: pref " + key + " failed: " + e, false);
        aResult.errors.push("setting " + key + " restore failed: " + e);
      }
    }
  }
}

/**
 * Writes a full pre-import safety snapshot (scripts + values + settings)
 * to <profile>/gm_backups/pre-import-<timestamp>.zip and prunes old ones.
 * The export usually finishes on another thread, so this reports through
 * aCallback once the file is complete (it said so before any byte was
 * written, and a failed compression went unreported).
 *
 * @param {function} aCallback - (error, path): error a string when the
 *   snapshot couldn't be written, else path its full path.
 */
function _writeSnapshot(aCallback) {
  let dir;
  let file;
  try {
    dir = GM_util.scriptDir().parent;
    dir.append("gm_backups");
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, GM_CONSTANTS.directoryMask);
    }
  } catch (e) {
    aCallback("" + e, null);
    return;
  }

  // ISO timestamp, filesystem-safe and lexically chronological:
  // "2026-06-13_01-23-45".
  let stamp = new Date().toISOString()
      .replace(/[:.]/g, "-")
      .replace("T", "_")
      .slice(0, 19);
  file = dir.clone();
  file.append("pre-import-" + stamp + ".zip");

  GM_BackupExport(file, /* includeValues */ true,
      function (aSuccess, aCount, aError) {
        if (!aSuccess) {
          aCallback(aError || "the snapshot was not written", null);
          return;
        }
        try {
          _pruneSnapshots(dir);
        } catch (e) {
          // Old snapshots stay; this one is written.
        }
        aCallback(null, file.path);
      });
}

/** Keeps only the newest SNAPSHOTS_TO_KEEP pre-import snapshots. */
function _pruneSnapshots(aDir) {
  let names = [];
  let entries = aDir.directoryEntries;
  while (entries.hasMoreElements()) {
    let file = entries.getNext().QueryInterface(Ci.nsIFile);
    if (/^pre-import-.*\.zip$/.test(file.leafName)) {
      names.push(file.leafName);
    }
  }
  // Timestamped names sort lexically = chronologically; drop the oldest.
  names.sort();
  while (names.length > SNAPSHOTS_TO_KEEP) {
    let victim = aDir.clone();
    victim.append(names.shift());
    try {
      victim.remove(false);
    } catch (e) {
      // Best effort.
    }
  }
}
