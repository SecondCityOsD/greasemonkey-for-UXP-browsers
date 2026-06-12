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

Cu.import("resource://gre/modules/AddonManager.jsm");

Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// Layout constants.
const MANIFEST_FILENAME = "greasemonkey";
const VM_MANIFEST_FILENAME = "violentmonkey";
const MANIFEST_FORMAT_VERSION = 2;
const OPTIONS_SUFFIX = ".options.json";
const STORAGE_SUFFIX = ".storage.json";
const USER_JS_SUFFIX = GM_CONSTANTS.fileScriptExtension; // ".user.js"
// Archived dependency entries live under "<base>.user.js.deps/"; the infix
// also routes those entries through the binary (not UTF-8) zip reader.
const DEPS_INFIX = USER_JS_SUFFIX + ".deps/";
// Per-entry inflate cap (zip-bomb guard) — oversized entries are skipped
// and reported, never read into memory.
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

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

      // 2. Cached dependency files (@require / @resource / @icon) under
      //    <base>.user.js.deps/ so a restore works offline (format v2).
      //    Returns the table embedded in the options sidecar.
      let dependencies = _exportDependencies(zipWriter, script, userJsName);

      // 3. Options sidecar (.user.js.options.json).
      _addEntryFromString(
          zipWriter, userJsName + OPTIONS_SUFFIX,
          _buildOptionsJson(script, dependencies));

      // 4. Optional GM values dump (.user.js.storage.json).
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
  let binaries;
  try {
    let parsed = _readZipContents(aSrcFile);
    entries = parsed.entries;
    payloads = parsed.payloads;
    binaries = parsed.binaries;
    // Oversized entries were skipped, not read — surface that in the
    // result instead of pretending the archive was fully consumed.
    for (let i = 0; i < parsed.skipped.length; i++) {
      result.errors.push(parsed.skipped[i]);
    }
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

  _installNext(0, toInstall, scripts, binaries, result, function () {
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
    "downloadURL": aScript._downloadURL,
    "updateURL": aScript._updateURL,
    "homepageURL": aScript._homepageURL,
    "userExcludes": aScript.userExcludes,
    "userIncludes": aScript.userIncludes,
    "userMatches": aScript.userMatches.map(function (m) { return m.pattern; }),
    "userOverride": aScript._userOverride,
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
function _exportDependencies(aZipWriter, aScript, aUserJsName) {
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
        let entry = aUserJsName + ".deps/" + index + "-"
            + cleanFilename(file.leafName, "dependency");
        _addEntryFromFile(aZipWriter, entry, file);
        out.push({
          "kind": group.kind,
          "name": (group.kind == "resource") ? dep.name : null,
          "url": dep.downloadURL,
          "entry": entry,
          "mimetype": dep._mimetype || null,
          "charset": dep._charset || null,
        });
        index++;
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
 * Dumps a script's GM_setValue store into a flat { key: value } JSON object.
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
    let binaries = {};
    let skipped = [];
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
        // Archived dependency payloads (format v2) can be binary (images,
        // fonts) — read raw bytes, NOT UTF-8 with replacement characters.
        binaries[name] = _readEntryAsBytes(zipReader, name);
        continue;
      }
      entries.push(name);
      payloads[name] = _readEntryAsString(zipReader, name);
    }
    return {
      "entries": entries,
      "payloads": payloads,
      "binaries": binaries,
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
 * Reads a single ZIP entry as a raw byte string (binary-safe — one
 * character per byte, code points 0-255).  Used for archived dependency
 * payloads, which may be images, fonts, or other non-text files.
 */
function _readEntryAsBytes(aZipReader, aEntryName) {
  let stream = aZipReader.getInputStream(aEntryName);
  try {
    let bstream = Cc["@mozilla.org/binaryinputstream;1"]
        .createInstance(Ci.nsIBinaryInputStream);
    bstream.setInputStream(stream);
    let chunks = [];
    let avail;
    while ((avail = bstream.available()) > 0) {
      chunks.push(bstream.readBytes(avail));
    }
    return chunks.join("");
  } finally {
    try { stream.close(); } catch (e) { /* some impls auto-close */ }
  }
}

/**
 * Sequential installer.  We chain callbacks rather than install in parallel
 * so that the scripts directory is written to one entry at a time and we
 * don't race on config.xml persistence.
 */
function _installNext(aIdx, aKeys, aScripts, aBinaries, aResult, aDone) {
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
  // Translate foreign sidecar schemas (Violentmonkey config/custom,
  // Tampermonkey options/settings/meta) into our flat shape; our own
  // sidecars pass through unchanged.
  options = _normalizeImportedOptions(options);

  // Collect archived dependency bytes (format v2) for this script so the
  // install can pre-seed them: restore works offline, dead URLs keep
  // working.  Anything not in the archive downloads normally.
  let prefetch = null;
  if (options && Array.isArray(options.dependencies)) {
    for (let d = 0; d < options.dependencies.length; d++) {
      let dep = options.dependencies[d];
      if (dep && dep.url && dep.entry
          && aBinaries && (dep.entry in aBinaries)) {
        prefetch = prefetch || {};
        prefetch[dep.url] = {
          "bytes": aBinaries[dep.entry],
          "mimetype": dep.mimetype || null,
          "charset": dep.charset || null,
        };
      }
    }
  }

  let next = function () {
    _installNext(aIdx + 1, aKeys, aScripts, aBinaries, aResult, aDone);
  };

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
    parsedScript = parse(source, installUri);
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

  // The normal install pipeline refuses scripts with recoverable parse
  // problems (invalid @match, bad @require/@resource URLs — see
  // remoteScript.js); installing them here would silently drop those
  // directives and ship a script that malfunctions at runtime.  Match the
  // pipeline: report and skip.
  if (parsedScript.parseErrors && parsedScript.parseErrors.length) {
    aResult.skipped++;
    aResult.errors.push(
        key + ": parse errors - " + parsedScript.parseErrors.join("; "));
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

  GM_util.writeToFile(source, tempFile, function (aWriteErr) {
    if (aWriteErr) {
      // Without this branch a failed temp write used to stall the whole
      // sequential chain: next() never ran and the completion callback
      // never fired (silent partial import).
      aResult.skipped++;
      aResult.errors.push(key + ": temp write failed - " + aWriteErr);
      next();
      return undefined;
    }
    try {
      remoteScript.setScript(parsedScript, tempFile);
      if (typeof remoteScript.setSilent === "function") {
        remoteScript.setSilent();
      }
      if (prefetch
          && (typeof remoteScript.setPrefetchedDependencies === "function")) {
        remoteScript.setPrefetchedDependencies(prefetch);
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
 * Translates a foreign per-script options sidecar into our flat shape.
 *
 * Detection:
 *   - Violentmonkey: state nested under config ({enabled, shouldUpdate} as
 *     0/1 numbers) and custom ({include/match/exclude arrays, downloadURL,
 *     origInclude/origMatch/origExclude merge flags}).
 *   - Tampermonkey: {options: {override: {use_* / merge_* lists},
 *     check_for_updates}, settings: {enabled, position}, meta: {file_url}}.
 *   - Anything else (our own exports) passes through unchanged.
 *
 * Mapping notes: VM/TM keep replace-vs-merge per clude list; we have one
 * userOverride flag for all of them — any "replace" wins.  TM use_* lists
 * take precedence over merge_* lists when both are present.
 */
function _normalizeImportedOptions(aRaw) {
  if (!aRaw || typeof aRaw !== "object") {
    return null;
  }

  // Violentmonkey (zip index entry with config/custom nesting).
  if (aRaw.config || aRaw.custom) {
    let config = aRaw.config || {};
    let custom = aRaw.custom || {};
    let out = {};
    if (config.enabled != null) {
      out.enabled = !!+config.enabled;
    }
    if ((config.shouldUpdate != null) && !+config.shouldUpdate) {
      out.checkRemoteUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    if (custom.downloadURL) {
      out.downloadURL = "" + custom.downloadURL;
    }
    if (custom.homepageURL) {
      out.homepageURL = "" + custom.homepageURL;
    }
    if (Array.isArray(custom.include)) {
      out.userIncludes = custom.include;
    }
    if (Array.isArray(custom.exclude)) {
      out.userExcludes = custom.exclude;
    }
    if (Array.isArray(custom.match)) {
      out.userMatches = custom.match;
    }
    // VM's origInclude/origMatch/origExclude default to true (= merge the
    // custom lists with the script's own); an explicit false means
    // "replace" — our userOverride.
    if ((custom.origInclude === false) || (custom.origMatch === false)
        || (custom.origExclude === false)) {
      out.userOverride = true;
    } else if (out.userIncludes || out.userExcludes || out.userMatches) {
      out.userOverride = false;
    }
    return out;
  }

  // Tampermonkey (.options.json with options/settings/meta).
  if (aRaw.settings || aRaw.meta
      || (aRaw.options && (typeof aRaw.options === "object"))) {
    let tmOptions = aRaw.options || {};
    let override = tmOptions.override || {};
    let settings = aRaw.settings || {};
    let meta = aRaw.meta || {};
    let out = {};
    if (typeof settings.enabled === "boolean") {
      out.enabled = settings.enabled;
    }
    if (tmOptions.check_for_updates === false) {
      out.checkRemoteUpdates = AddonManager.AUTOUPDATE_DISABLE;
    }
    if (meta.file_url) {
      out.downloadURL = "" + meta.file_url;
    }
    let pick = function (aList) {
      return (Array.isArray(aList) && aList.length) ? aList : null;
    };
    let useIncludes = pick(override.use_includes);
    let useMatches = pick(override.use_matches);
    let useExcludes = pick(override.use_excludes);
    if (useIncludes || useMatches || useExcludes) {
      if (useIncludes) { out.userIncludes = useIncludes; }
      if (useMatches) { out.userMatches = useMatches; }
      if (useExcludes) { out.userExcludes = useExcludes; }
      out.userOverride = true;
    } else {
      let mergeIncludes = pick(override.merge_includes);
      let mergeMatches = pick(override.merge_matches);
      let mergeExcludes = pick(override.merge_excludes);
      if (mergeIncludes) { out.userIncludes = mergeIncludes; }
      if (mergeMatches) { out.userMatches = mergeMatches; }
      if (mergeExcludes) { out.userExcludes = mergeExcludes; }
      if (mergeIncludes || mergeMatches || mergeExcludes) {
        out.userOverride = false;
      }
    }
    return out;
  }

  return aRaw;
}

/**
 * After a successful install, applies sidecar-provided options to the
 * live Script object.  `installTime` is deliberately NOT restored — it was
 * just set to "now" by the install pipeline and replacing it with the
 * exporter's timestamp would confuse the modified-since-install check.
 * downloadURL is also not touched here — it was already populated during
 * parse() from the synthesised install URI, and we want it to reflect the
 * URL the import used (which matches the sidecar's value anyway).
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
    // Homepage URL isn't persisted in the source for many scripts (our
    // Phase-A fallback chain derives it on the fly), so restore the last
    // resolved value if we can — keeps the Add-ons Manager homepage link
    // intact across a round-trip.
    if (aOptions.homepageURL && !aScript._homepageURL) {
      aScript._homepageURL = "" + aOptions.homepageURL;
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
    // Module registry, not a private Back: shared with the live script and
    // closed at shutdown instead of leaking an open SQLite connection.
    let storage = getStorageBackForScript(aScript);
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
