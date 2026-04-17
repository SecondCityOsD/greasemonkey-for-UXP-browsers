/**
 * @file backup.js
 * @overview Tampermonkey-compatible ZIP export/import for user scripts.
 *
 * Produces a single .zip archive containing:
 *   - One <basename>.user.js per installed script (raw source).
 *   - One <basename>.user.js.options.json per script (metadata sidecar).
 *   - Optionally one <basename>.user.js.storage.json per script (GM values).
 *   - A top-level "greasemonkey" manifest (JSON) with format version and the
 *     list of exported basenames.
 *
 * The layout is forward- and backward-compatible with Violentmonkey's and
 * Tampermonkey's exports: their importers read individual .user.js entries
 * directly, and our importer tolerates either a VM-style "violentmonkey"
 * manifest or TM-style per-script .options.json / .storage.json sidecars
 * (with or without the .user.js infix).
 *
 * Uses native XPCOM nsIZipWriter / nsIZipReader — no bundled JS library.
 * Entirely local: no cloud sync.
 *
 * @exports GM_BackupExport, GM_BackupImport
 */

const EXPORTED_SYMBOLS = ["GM_BackupExport", "GM_BackupImport"];

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

Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// Layout constants.
const MANIFEST_FILENAME = "greasemonkey";
const VM_MANIFEST_FILENAME = "violentmonkey";
const MANIFEST_FORMAT_VERSION = 1;
const OPTIONS_SUFFIX = ".options.json";
const STORAGE_SUFFIX = ".storage.json";
const USER_JS_SUFFIX = GM_CONSTANTS.fileScriptExtension; // ".user.js"

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
      _addEntryFromFile(zipWriter, userJsName, script.file);

      // 2. Options sidecar (.user.js.options.json).
      _addEntryFromString(
          zipWriter, userJsName + OPTIONS_SUFFIX, _buildOptionsJson(script));

      // 3. Optional GM values dump (.user.js.storage.json).
      if (aIncludeValues) {
        let storageJson = _buildStorageJson(script);
        if (storageJson) {
          _addEntryFromString(
              zipWriter, userJsName + STORAGE_SUFFIX, storageJson);
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
    };
    _addEntryFromString(
        zipWriter, MANIFEST_FILENAME, JSON.stringify(manifest, null, 2));
  } catch (e) {
    // Non-fatal; scripts are already in the archive.
    GM_util.logError("Backup manifest: " + e, false);
  }

  try {
    zipWriter.close();
  } catch (e) {
    GM_util.logError("Backup export: close failed: " + e, false);
    aCallback(false, exportedCount, "" + e);
    return;
  }

  aCallback(true, exportedCount, errors.length ? errors.join("; ") : null);
}


/**
 * Imports user scripts from a ZIP archive produced by GM_BackupExport,
 * Violentmonkey, or Tampermonkey.  Installs each unique script sequentially.
 *
 * A script whose (name, namespace) already matches an installed script is
 * skipped — we never silently overwrite.  Dependencies (@require, @resource,
 * @icon) are re-downloaded fresh via the regular RemoteScript pipeline.
 *
 * @param {nsIFile}  aSrcFile        - The .zip to read from.
 * @param {function} [aCallback]     - Called (success, result, errorMsg) where
 *   result = {total, imported, skipped, errors[]}.
 */
function GM_BackupImport(aSrcFile, aCallback) {
  aCallback = aCallback || function () {};
  let result = { "total": 0, "imported": 0, "skipped": 0, "errors": [] };

  let entries;
  let payloads;
  try {
    let parsed = _readZipContents(aSrcFile);
    entries = parsed.entries;
    payloads = parsed.payloads;
  } catch (e) {
    GM_util.logError("Backup import: cannot read ZIP: " + e, false);
    aCallback(false, result, "" + e);
    return;
  }

  // Group entries by logical script basename.  Three tables:
  //   scripts[name.user.js] = { source, options, storage }
  //   The VM manifest (if present) fills in options gaps.
  let scripts = {};
  let vmManifest = null;

  // First pass: pick up all .user.js files + direct sidecars (TM layout
  // with .user.js.options.json / .user.js.storage.json — GM / VM idiom).
  for (let i = 0; i < entries.length; i++) {
    let name = entries[i];
    if (name === MANIFEST_FILENAME) continue;
    if (name === VM_MANIFEST_FILENAME) {
      try {
        vmManifest = JSON.parse(payloads[name]);
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
      (scripts[base] = scripts[base] || {}).options = payloads[name];
      continue;
    }
    if (name.length > STORAGE_SUFFIX.length
        && name.slice(-STORAGE_SUFFIX.length) === STORAGE_SUFFIX
        && name.length > USER_JS_SUFFIX.length + STORAGE_SUFFIX.length
        && name.slice(-(USER_JS_SUFFIX.length + STORAGE_SUFFIX.length))
            === USER_JS_SUFFIX + STORAGE_SUFFIX) {
      let base = name.slice(0, -STORAGE_SUFFIX.length);
      (scripts[base] = scripts[base] || {}).storage = payloads[name];
      continue;
    }
    if (name.length > USER_JS_SUFFIX.length
        && name.slice(-USER_JS_SUFFIX.length) === USER_JS_SUFFIX) {
      (scripts[name] = scripts[name] || {}).source = payloads[name];
      continue;
    }
  }

  // Second pass: TM-style sidecars without the .user.js infix
  // (e.g. "<name>.options.json" where <name>.user.js also exists).
  for (let i = 0; i < entries.length; i++) {
    let name = entries[i];
    if (name.length > OPTIONS_SUFFIX.length
        && name.slice(-OPTIONS_SUFFIX.length) === OPTIONS_SUFFIX) {
      let stem = name.slice(0, -OPTIONS_SUFFIX.length);
      let candidate = stem + USER_JS_SUFFIX;
      if (scripts[candidate] && !scripts[candidate].options) {
        scripts[candidate].options = payloads[name];
      }
    } else if (name.length > STORAGE_SUFFIX.length
        && name.slice(-STORAGE_SUFFIX.length) === STORAGE_SUFFIX) {
      let stem = name.slice(0, -STORAGE_SUFFIX.length);
      let candidate = stem + USER_JS_SUFFIX;
      if (scripts[candidate] && !scripts[candidate].storage) {
        scripts[candidate].storage = payloads[name];
      }
    }
  }

  // Third pass: if a VM manifest is present, fill in any missing options
  // from its "scripts" map.  VM's manifest keys are the script name.
  if (vmManifest && vmManifest.scripts) {
    let keys = Object.keys(scripts);
    for (let i = 0; i < keys.length; i++) {
      let entry = scripts[keys[i]];
      if (entry.options) continue;
      let stem = keys[i].slice(0, -USER_JS_SUFFIX.length);
      if (vmManifest.scripts[stem]) {
        try {
          entry.options = JSON.stringify(vmManifest.scripts[stem]);
        } catch (e) {
          // Ignore — the script will install with GM defaults.
        }
      }
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

  result.total = toInstall.length;
  if (!toInstall.length) {
    aCallback(false, result, "No user scripts found in archive.");
    return;
  }

  _installNext(0, toInstall, scripts, result, function () {
    aCallback(true, result, null);
  });
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
 * script source alone (enabled, user cludes, autoUpdate, etc.).
 */
function _buildOptionsJson(aScript) {
  return JSON.stringify({
    "name": aScript._name,
    "namespace": aScript._namespace,
    "version": aScript._version,
    "enabled": aScript._enabled,
    "autoUpdate": aScript._autoUpdate,
    "checkRemoteUpdates": aScript.checkRemoteUpdates,
    "installTime": aScript._installTime,
    "downloadURL": aScript._downloadURL,
    "updateURL": aScript._updateURL,
    "homepageURL": aScript._homepageURL,
    "userExcludes": aScript.userExcludes,
    "userIncludes": aScript.userIncludes,
    "userMatches": aScript.userMatches.map(function (m) { return m.pattern; }),
    "userOverride": aScript._userOverride,
  }, null, 2);
}

/**
 * Dumps a script's GM_setValue store into a flat { key: value } JSON object.
 * Returns null (not "{}") when the script has no stored values, so the
 * empty sidecar file isn't added to the archive.
 */
function _buildStorageJson(aScript) {
  try {
    let storage = new GM_ScriptStorageBack(aScript);
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
    return JSON.stringify(out, null, 2);
  } catch (e) {
    GM_util.logError("Backup storage dump failed: " + e, false);
    return null;
  }
}

/** Adds an on-disk file to the ZIP at the given entry path. */
function _addEntryFromFile(aZipWriter, aEntryName, aFile) {
  aZipWriter.addEntryFile(
      aEntryName,
      Ci.nsIZipWriter.COMPRESSION_DEFAULT,
      aFile,
      false);
}

/**
 * Adds a string (UTF-8 encoded) to the ZIP at the given entry path.
 * Uses nsIStringInputStream with the UTF-8 byte length so multi-byte
 * characters survive the round-trip.
 */
function _addEntryFromString(aZipWriter, aEntryName, aString) {
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
      false);
}

/**
 * Reads every entry of a ZIP file into memory and returns:
 *   { entries: [name, …], payloads: { name: string, … } }
 *
 * Entries representing directories (trailing "/") are excluded.  All payloads
 * are decoded as UTF-8 strings; binary entries aren't expected in a backup
 * archive.
 */
function _readZipContents(aSrcFile) {
  let zipReader = Cc["@mozilla.org/libjar/zip-reader;1"]
      .createInstance(Ci.nsIZipReader);
  zipReader.open(aSrcFile);
  try {
    let entries = [];
    let payloads = {};
    let iter = zipReader.findEntries("*");
    while (iter.hasMore()) {
      let name = iter.getNext();
      if (!name || name.charAt(name.length - 1) === "/") {
        continue;
      }
      entries.push(name);
      payloads[name] = _readEntryAsString(zipReader, name);
    }
    return { "entries": entries, "payloads": payloads };
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
 * Sequential installer.  We chain callbacks rather than install in parallel
 * so that the scripts directory is written to one entry at a time and we
 * don't race on config.xml persistence.
 */
function _installNext(aIdx, aKeys, aScripts, aResult, aDone) {
  if (aIdx >= aKeys.length) {
    aDone();
    return;
  }

  let key = aKeys[aIdx];
  let entry = aScripts[key];
  let source = entry.source;
  let options = null;
  if (entry.options) {
    try {
      options = JSON.parse(entry.options);
    } catch (e) {
      // Bad sidecar — install the script with defaults.
      options = null;
    }
  }

  let next = function () {
    _installNext(aIdx + 1, aKeys, aScripts, aResult, aDone);
  };

  let parsedScript;
  try {
    parsedScript = parse(source);
  } catch (e) {
    aResult.skipped++;
    aResult.errors.push(key + ": parse failed - " + e);
    next();
    return;
  }
  if (!parsedScript || !parsedScript._name) {
    aResult.skipped++;
    aResult.errors.push(key + ": parse produced no usable script");
    next();
    return;
  }

  // Refuse to overwrite an already-installed script (matches (name, namespace)).
  let config = GM_util.getService().config;
  if (config.installIsUpdate(parsedScript)) {
    aResult.skipped++;
    aResult.errors.push(key + ": already installed");
    next();
    return;
  }

  // Install via the standard RemoteScript pipeline, minus the editor popup.
  let remoteScript;
  let tempFile;
  try {
    remoteScript = new RemoteScript();
    let tempFileName = cleanFilename(
        parsedScript.name, GM_CONSTANTS.fileScriptName)
        + GM_CONSTANTS.fileScriptExtension;
    tempFile = GM_util.getTempFile(remoteScript._tempDir, tempFileName);
  } catch (e) {
    aResult.skipped++;
    aResult.errors.push(key + ": setup failed - " + e);
    next();
    return;
  }

  GM_util.writeToFile(source, tempFile, function () {
    try {
      remoteScript.setScript(parsedScript, tempFile);
      if (typeof remoteScript.setSilent === "function") {
        remoteScript.setSilent();
      }
      remoteScript.download(function (aSuccess) {
        if (!aSuccess) {
          aResult.skipped++;
          aResult.errors.push(key + ": dependency download failed");
          next();
          return;
        }
        try {
          remoteScript.install();
          _applyImportedOptions(parsedScript, options);
          if (entry.storage) {
            _applyImportedStorage(parsedScript, entry.storage);
          }
          aResult.imported++;
        } catch (e) {
          aResult.skipped++;
          aResult.errors.push(key + ": install failed - " + e);
        }
        next();
      });
    } catch (e) {
      aResult.skipped++;
      aResult.errors.push(key + ": download setup failed - " + e);
      next();
    }
  });
}

/**
 * After a successful install, applies sidecar-provided options to the
 * live Script object.  Only fields that are safe to overwrite are touched
 * — we deliberately do NOT restore installTime/downloadURL/updateURL
 * (those were just set to "now" / the import URL and shouldn't be
 * overwritten with values from a different profile's history).
 */
function _applyImportedOptions(aScript, aOptions) {
  if (!aOptions || typeof aOptions !== "object") return;
  try {
    if (typeof aOptions.enabled === "boolean") {
      aScript._enabled = aOptions.enabled;
    }
    if (typeof aOptions.autoUpdate === "boolean") {
      aScript._autoUpdate = aOptions.autoUpdate;
    }
    if (typeof aOptions.checkRemoteUpdates === "number") {
      aScript.checkRemoteUpdates = aOptions.checkRemoteUpdates;
    }
    if (Array.isArray(aOptions.userIncludes)) {
      aScript.userIncludes = aOptions.userIncludes;
    }
    if (Array.isArray(aOptions.userExcludes)) {
      aScript.userExcludes = aOptions.userExcludes;
    }
    if (Array.isArray(aOptions.userMatches)) {
      aScript.userMatches = aOptions.userMatches;
    }
    if (typeof aOptions.userOverride === "boolean") {
      aScript._userOverride = aOptions.userOverride;
    }
    aScript._changed("modified", null);
  } catch (e) {
    GM_util.logError("Backup import: apply options failed: " + e, false);
  }
}

/**
 * Writes imported GM values into the script's SQLite store.  Missing values
 * are ignored; existing keys (from a prior install) are overwritten.
 */
function _applyImportedStorage(aScript, aStorageJson) {
  let data;
  try {
    data = JSON.parse(aStorageJson);
  } catch (e) {
    GM_util.logError("Backup import: bad storage JSON: " + e, false);
    return;
  }
  if (!data || typeof data !== "object") return;
  try {
    let storage = new GM_ScriptStorageBack(aScript);
    let keys = Object.keys(data);
    for (let i = 0; i < keys.length; i++) {
      try {
        storage.setValue(keys[i], data[keys[i]]);
      } catch (e) {
        GM_util.logError(
            "Backup import: setValue(" + keys[i] + "): " + e, false);
      }
    }
  } catch (e) {
    GM_util.logError("Backup import: storage open failed: " + e, false);
  }
}
