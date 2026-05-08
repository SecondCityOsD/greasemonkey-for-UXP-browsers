/**
 * @file storageBack.js
 * @overview Per-script SQLite key/value store for GM_setValue / GM_getValue /
 *   GM_deleteValue / GM_listValues — and the GM4 async equivalents
 *   GM.setValue / GM.getValue / GM.deleteValue / GM.listValues, plus the
 *   batched GM_getValues / GM_setValues / GM_deleteValues and
 *   GM_addValueChangeListener / GM_removeValueChangeListener APIs.
 *
 * Two classes live here:
 *
 *   GM_ScriptStorageBack(aScript)
 *     Owns the SQLite database for a single script.  One instance per script,
 *     shared across all sandboxes that script is running in.  Provides the
 *     low-level setValue/getValue/deleteValue/listValues over JSON-encoded
 *     values.  Each script's database lives at:
 *       <profile>/gm_scripts/<baseDirName>.db
 *
 *   GM_ScriptStorageFront(aWrappedContentWin, aSandbox, aScript)
 *     Per-sandbox wrapper around a Back instance.  Adds:
 *       - Read cache with hit-counter promotion (avoids hitting SQLite for
 *         hot keys; large values bypass the cache).
 *       - Sandbox-cloning of returned values (Cu.cloneInto) so scripts
 *         cannot hold privileged references.
 *       - Value-change listeners (addValueChangeListener / removeValue-
 *         ChangeListener) with a "remote" flag distinguishing in-sandbox
 *         changes from changes made by other sandboxes watching the same
 *         key (other tabs, other scripts).
 *       - Batched getValues / setValues / deleteValues helpers.
 *
 *   getStorageBackForScript(aScript)
 *     Returns the singleton Back for the script, creating it on first use.
 *
 *   closeAllStorageBacks()
 *     Closes every Back this module has opened.  Called on quit-application.
 *
 * Historical note:
 *   Pre-cleanup, the front-end and back-end lived in separate modules
 *   (storageFront.js + storageBack.js) and communicated through Services.
 *   cpmm RPC messages (greasemonkey:scriptVal-{get,set,delete,list}) plus
 *   a value-invalidate broadcast.  UXP is single-process — chrome and
 *   content share the same JS runtime — so the IPC was a self-loop with
 *   no benefit.  Both classes now live in this single module; sandbox.js
 *   constructs the Front directly with no message-manager argument, and
 *   the GreasemonkeyService no longer maintains its own scriptValStores
 *   registry (the registry is now module-private and accessed via the
 *   getStorageBackForScript / closeAllStorageBacks exports).
 *
 * SQLite PRAGMA notes (see bug #1879):
 *   auto_vacuum=INCREMENTAL — reclaims free pages gradually rather than on VACUUM.
 *   journal_mode=MEMORY     — keeps the write-ahead journal in memory for speed.
 *   synchronous=OFF         — trades crash safety for performance (profile data only).
 *   wal_autocheckpoint=10   — checkpoints the WAL every 10 pages.
 */

const EXPORTED_SYMBOLS = [
  "GM_ScriptStorageBack",
  "GM_ScriptStorageFront",
  "getStorageBackForScript",
  "closeAllStorageBacks",
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

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const MESSAGE_ERROR_PREFIX_BACK  = "Script storage back end: ";
const MESSAGE_ERROR_PREFIX_FRONT = "Script storage front end: ";

/** Start caching a value only after it has been read this many times. */
const CACHE_AFTER_N_GETS = 3;
/** Values longer than this (in characters) are never cached. */
const CACHE_MAX_VALUE = 4096;
/** Maximum number of entries in the in-memory value cache. */
const CACHE_SIZE = 1024;

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //
// ─── Back: per-script SQLite store ──────────────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Back-end storage object for a single userscript.
 * Manages a per-script SQLite database and exposes CRUD operations.
 *
 * @constructor
 * @param {Script} aScript - The Script object whose storage this instance manages.
 *                           Must have a .baseDirName property used to derive
 *                           the database file path.
 */
function GM_ScriptStorageBack(aScript) {
  this._db = null;
  this._script = aScript;
}

/**
 * Lazy getter for the open SQLite database connection.
 * On first access the database file is opened (or created), PRAGMAs are
 * applied, and the "scriptvals" table is created if it does not yet exist.
 * Subsequent accesses return the cached connection.
 *
 * @type {mozIStorageConnection}
 */
Object.defineProperty(GM_ScriptStorageBack.prototype, "db", {
  "get": function GM_ScriptStorageBack_getDb() {
    if (null == this._db) {
      this._db = Services.storage.openDatabase(this.dbFile);

      // The auto_vacuum pragma has to be set before the table is created.
      this._db.executeSimpleSQL("PRAGMA auto_vacuum = INCREMENTAL;");
      this._db.executeSimpleSQL("PRAGMA incremental_vacuum(10);");
      this._db.executeSimpleSQL("PRAGMA journal_mode = MEMORY;");
      this._db.executeSimpleSQL("PRAGMA synchronous = OFF;");
      this._db.executeSimpleSQL("PRAGMA temp_store = MEMORY;");
      this._db.executeSimpleSQL("PRAGMA wal_autocheckpoint = 10;");

      this._db.executeSimpleSQL(
          "CREATE TABLE IF NOT EXISTS scriptvals ("
          + "name TEXT PRIMARY KEY NOT NULL, "
          + "value TEXT "
          + ")");

      // See #1879.
      // Run vacuum once manually to switch to the correct auto_vacuum mode
      // for databases that were created with incorrect auto_vacuum.
      this._db.executeSimpleSQL("VACUUM;");
    }
    return this._db;
  },
  "enumerable": true,
});

/**
 * Lazy getter that returns the nsIFile pointing to this script's .db file.
 * The path is: <profile>/gm_scripts/<baseDirName>.db
 *
 * @type {nsIFile}
 */
Object.defineProperty(GM_ScriptStorageBack.prototype, "dbFile", {
  "get": function GM_ScriptStorageBack_getDbFile() {
    let file = GM_util.scriptDir();
    file.append(this._script.baseDirName + GM_CONSTANTS.fileScriptDBExtension);

    return file;
  },
  "enumerable": true,
});

/**
 * Closes the SQLite database connection.
 * Should be called when the script is uninstalled or the extension shuts down.
 */
GM_ScriptStorageBack.prototype.close = function () {
  if (this._db) {
    this._db.close();
    this._db = null;
  }
};

/**
 * Persists a key/value pair for this script.
 * The value is JSON-serialised, so any JSON-safe JS value is accepted.
 * Fires a "val-set" changed notification on the owning Script object.
 *
 * @param {string} aName - The storage key.
 * @param {*}      aVal  - The value to store (must be JSON-serialisable).
 * @throws {Error} If called with fewer or more than 2 arguments.
 */
GM_ScriptStorageBack.prototype.setValue = function (aName, aVal) {
  if (arguments.length !== 2) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.setValue.arguments"));
  }

  let stmt = this.db.createStatement(
      "INSERT OR REPLACE INTO scriptvals (name, value) VALUES (:name, :value)");
  try {
    stmt.params.name = aName;
    stmt.params.value = JSON.stringify(aVal);
    stmt.execute();
  } finally {
    stmt.reset();
  }

  // Defensive: getStorageBackForScript() resolves the IPCScript view
  // back to the full Script via the service, but on very early startup
  // it may fall back to the IPCScript which lacks .changed().  Skip
  // the notification rather than throwing.
  if (typeof this._script.changed == "function") {
    this._script.changed("val-set", aName);
  }
};

/**
 * Retrieves a stored value by key.
 *
 * @param {string} aName - The storage key to look up.
 * @returns {string|null} The raw JSON string stored for that key, or null if
 *                        the key does not exist or a database error occurs.
 */
GM_ScriptStorageBack.prototype.getValue = function (aName) {
  let value = null;
  let stmt = this.db.createStatement(
      "SELECT value FROM scriptvals WHERE name = :name");
  try {
    stmt.params.name = aName;
    while (stmt.step()) {
      value = stmt.row.value;
    }
  } catch (e) {
    GM_util.logError(
        MESSAGE_ERROR_PREFIX_BACK + "getValue():" + "\n" + e, false,
        e.fileName, e.lineNumber);
  } finally {
    stmt.reset();
  }

  return value;
};

/**
 * Removes a key/value pair from storage.
 * Fires a "val-del" changed notification on the owning Script object.
 *
 * @param {string} aName - The storage key to delete.
 */
GM_ScriptStorageBack.prototype.deleteValue = function (aName) {
  let stmt = this.db.createStatement(
      "DELETE FROM scriptvals WHERE name = :name");
  try {
    stmt.params.name = aName;
    stmt.execute();
  } finally {
    stmt.reset();
  }

  // Defensive — see setValue() above.
  if (typeof this._script.changed == "function") {
    this._script.changed("val-del", aName);
  }
};

/**
 * Returns all stored key names for this script.
 *
 * @returns {string[]} Array of key names (may be empty).
 */
/**
 * Batched fetch of multiple stored values in a single SQL query.
 * Returns a plain object mapping each requested name to its raw JSON
 * string (the value as stored), or omits names that don't exist.
 *
 * Phase 7d: replaces N round-trips through getValue() with one
 * SELECT … WHERE name IN (…) statement.  For scripts that read a
 * dozen GM_*Values at once, this drops the SQL chatter from N calls
 * to 1 — measurable on slow disks even with synchronous=OFF.
 *
 * @param {string[]} aNames - Storage keys to fetch.
 * @returns {object} Map of name → raw JSON string for each found row.
 */
GM_ScriptStorageBack.prototype.getValuesBatch = function (aNames) {
  let result = {};
  if (!aNames || !aNames.length) {
    return result;
  }

  // Build the IN-clause placeholder list.  mozStorage supports named
  // placeholders via stmt.params, which is cleaner than positional ?N.
  let placeholders = aNames
      .map(function (_, i) { return ":n" + i; })
      .join(", ");
  let sql = "SELECT name, value FROM scriptvals WHERE name IN ("
      + placeholders + ")";
  let stmt = this.db.createStatement(sql);
  try {
    for (let i = 0; i < aNames.length; i++) {
      stmt.params["n" + i] = aNames[i];
    }
    while (stmt.executeStep()) {
      result[stmt.row.name] = stmt.row.value;
    }
  } catch (e) {
    GM_util.logError(
        MESSAGE_ERROR_PREFIX_BACK + "getValuesBatch():" + "\n" + e, false,
        e.fileName, e.lineNumber);
  } finally {
    stmt.reset();
  }

  return result;
};

/**
 * Batched write of multiple key/value pairs.  Wraps every INSERT OR
 * REPLACE in a single SQLite transaction so the writes either all
 * commit or all roll back — atomic from the script's perspective.
 *
 * Phase 7d: replaces N independent INSERTs (each its own implicit
 * transaction) with one BEGIN … COMMIT, plus statement-reuse across
 * the loop.
 *
 * @param {object} aMap - { name: value } map.  Values are JSON-
 *                        serialised here.
 */
GM_ScriptStorageBack.prototype.setValuesBatch = function (aMap) {
  let names = Object.keys(aMap || {});
  if (!names.length) {
    return;
  }

  let stmt = this.db.createStatement(
      "INSERT OR REPLACE INTO scriptvals (name, value)"
      + " VALUES (:name, :value)");
  let inTx = false;
  try {
    this.db.beginTransaction();
    inTx = true;
    for (let i = 0; i < names.length; i++) {
      stmt.params.name = names[i];
      stmt.params.value = JSON.stringify(aMap[names[i]]);
      stmt.execute();
      stmt.reset();
    }
    this.db.commitTransaction();
    inTx = false;
  } catch (e) {
    if (inTx) {
      try { this.db.rollbackTransaction(); } catch (e2) {}
    }
    throw e;
  } finally {
    stmt.reset();
  }

  // Defensive — see setValue() above re: IPCScript fallback.
  if (typeof this._script.changed == "function") {
    for (let i = 0; i < names.length; i++) {
      this._script.changed("val-set", names[i]);
    }
  }
};

/**
 * Batched deletion of multiple stored values in a single SQL statement.
 *
 * @param {string[]} aNames - Storage keys to delete.
 */
GM_ScriptStorageBack.prototype.deleteValuesBatch = function (aNames) {
  if (!aNames || !aNames.length) {
    return;
  }

  let placeholders = aNames
      .map(function (_, i) { return ":n" + i; })
      .join(", ");
  let sql = "DELETE FROM scriptvals WHERE name IN (" + placeholders + ")";
  let stmt = this.db.createStatement(sql);
  try {
    for (let i = 0; i < aNames.length; i++) {
      stmt.params["n" + i] = aNames[i];
    }
    stmt.execute();
  } finally {
    stmt.reset();
  }

  // Defensive — see deleteValue() above re: IPCScript fallback.
  if (typeof this._script.changed == "function") {
    for (let i = 0; i < aNames.length; i++) {
      this._script.changed("val-del", aNames[i]);
    }
  }
};

/**
 * Returns all stored key names for this script.
 *
 * @returns {string[]} Array of key names (may be empty).
 */
GM_ScriptStorageBack.prototype.listValues = function () {
  let valueNames = [];

  let stmt = this.db.createStatement("SELECT name FROM scriptvals");
  try {
    while (stmt.executeStep()) {
      valueNames.push(stmt.row.name);
    }
  } finally {
    stmt.reset();
  }

  return valueNames;
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //
// ─── Module-level Back registry ─────────────────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * One Back instance per script id, shared across all sandboxes that ever
 * touch that script's storage in this browser session.  Replaces the
 * historical service.scriptValStores map (which was duplicated work
 * because storageFront.js had its own caching layer above the cpmm RPC).
 */
var gBackByScriptId = new Map();

/**
 * Returns the Back instance for the given script, creating it on first use.
 * Backs are kept open for the lifetime of the application; closeAllStorageBacks
 * is called from the GreasemonkeyService's quit-application observer.
 *
 * IMPORTANT: callers commonly pass an IPCScript (the frozen IPC-shaped
 * view) rather than the full Script object, because that's what the
 * sandbox layer has on hand.  The IPCScript carries id / baseDirName but
 * NOT the live Script.changed() method, which the Back uses to fire
 * val-set / val-del observer notifications.  We therefore resolve the
 * id back to the full Script via the GreasemonkeyService here.  If the
 * service is not yet available (very early startup, or running in a
 * test harness) we fall back to the IPCScript and leave the Back's
 * setValue / deleteValue methods to typeof-check before calling
 * .changed().
 *
 * @param {Script|IPCScript} aScript - Either a full Script or its IPC view.
 *                                     Must expose at least .id and .baseDirName.
 * @returns {GM_ScriptStorageBack}
 */
function getStorageBackForScript(aScript) {
  let id = aScript.id;
  let back = gBackByScriptId.get(id);
  if (!back) {
    let fullScript = aScript;
    try {
      let svc = GM_util.getService();
      if (svc && svc.config
          && (typeof svc.config.getScriptById == "function")) {
        let resolved = svc.config.getScriptById(id);
        if (resolved) {
          fullScript = resolved;
        }
      }
    } catch (e) {
      // Service not ready yet; use whatever we got.  setValue /
      // deleteValue will skip .changed() if the method is missing.
    }
    back = new GM_ScriptStorageBack(fullScript);
    gBackByScriptId.set(id, back);
  }
  return back;
}

/**
 * Closes every Back instance this module has opened.  Called once on
 * quit-application.  Safe to call multiple times.
 */
function closeAllStorageBacks() {
  gBackByScriptId.forEach(function (aBack) {
    try {
      aBack.close();
    } catch (e) {
      // Ignore — best-effort shutdown.
    }
  });
  gBackByScriptId.clear();
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //
// ─── Front: per-sandbox cache + listeners ───────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Module-level value cache keyed by "<scriptId>:<name>".  Shared across
 * all Front instances so that a setValue in one sandbox invalidates the
 * cache entry that another sandbox might have read.  On UXP single-
 * process the same module instance is loaded everywhere, so all Fronts
 * share this Map automatically.
 */
var cache = new Map();
var cacheHitCounter = new Map();

/**
 * Listener registry.  gListeners maps each listener id to its descriptor;
 * gListenersByKey maps each cache key to the set of listener ids watching it.
 *   gListeners: id → {cacheKey, name, callback, storageFront}
 *   gListenersByKey: cacheKey → Set<id>
 */
var gListeners = new Map();
var gListenersByKey = new Map();
var gNextListenerId = 0;

/**
 * Generates the cache key for a script/name pair.
 *
 * @param {Script} aScript - The script whose value is being accessed.
 * @param {string} aName   - The value name.
 * @returns {string} Cache key string, e.g. "abc-123:myKey".
 */
function cacheKey(aScript, aName) {
  return aScript.id + ":" + aName;
}

/**
 * Removes a single entry from both the value cache and the hit-count map.
 * Called when a setValue / deleteValue is performed locally.
 *
 * @param {string} aKey - Cache key in the form "<scriptId>:<name>".
 */
function invalidateCache(aKey) {
  cache["delete"](aKey);
  cacheHitCounter["delete"](aKey);
}

/**
 * Fires every listener registered for the given key.  Listeners whose
 * owning Front matches aSetterFront receive aRemote=false; listeners
 * owned by other Fronts (other sandboxes watching the same key) receive
 * aRemote=true.  This preserves the pre-cleanup contract where "remote"
 * meant "the change came from a different document context".
 *
 * @param {string}  aKey          - Cache key in "<scriptId>:<name>" format.
 * @param {*}       aOldValue     - Previous value (may be undefined).
 * @param {*}       aNewValue     - New value (may be undefined).
 * @param {object}  aSetterFront  - The Front instance that triggered the change.
 */
function fireValueChangeListeners(aKey, aOldValue, aNewValue, aSetterFront) {
  let listenerIds = gListenersByKey.get(aKey);
  if (!listenerIds || listenerIds.size == 0) {
    return undefined;
  }
  listenerIds.forEach(function (aListenerId) {
    let entry = gListeners.get(aListenerId);
    if (!entry) {
      return undefined;
    }
    let aRemote = entry.storageFront !== aSetterFront;
    try {
      entry.callback(entry.name, aOldValue, aNewValue, aRemote);
    } catch (e) {
      GM_util.logError(e, false, e.fileName, e.lineNumber);
    }
  });
}

/**
 * Sandbox-side wrapper around a Back instance.  One per sandbox.
 *
 * @constructor
 * @param {Window}   aWrappedContentWin - The content window (used to
 *   construct Error objects that point back to the script).
 * @param {Sandbox}  aSandbox           - The script's sandbox; values
 *   are cloned into it before being returned.
 * @param {Script}   aScript            - The script object; provides
 *   the id used for cache keys and Back lookup.
 */
function GM_ScriptStorageFront(aWrappedContentWin, aSandbox, aScript) {
  this._sandbox = aSandbox;
  this._script = aScript;
  this._wrappedContentWin = aWrappedContentWin;
  this._back = getStorageBackForScript(aScript);
}

/**
 * The db / dbFile / close members are intentionally non-functional from
 * the Front — direct database access is the Back's responsibility.  These
 * remain as thin throws to preserve the pre-cleanup interface contract
 * (a Front "looks like" a Back to anything that imported one historically).
 */
Object.defineProperty(GM_ScriptStorageFront.prototype, "db", {
  "get": function GM_ScriptStorageFront_getDb() {
    throw new Error(
        MESSAGE_ERROR_PREFIX_FRONT
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.storage.db.noConnection"));
  },
  "enumerable": true,
});

Object.defineProperty(GM_ScriptStorageFront.prototype, "dbFile", {
  "get": function GM_ScriptStorageFront_getDbFile() {
    throw new Error(
        MESSAGE_ERROR_PREFIX_FRONT
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.storage.db.noFile"));
  },
  "enumerable": true,
});

GM_ScriptStorageFront.prototype.close = function () {
  throw new this._wrappedContentWin.Error(
      MESSAGE_ERROR_PREFIX_FRONT
      + GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("error.storage.db.noConnection"),
      this._script.fileURL, null);
};

/**
 * Stores a value via the Back, invalidates this key's cache entry, and
 * fires any registered value-change listeners.
 *
 * @param {string} aName - Storage key.
 * @param {*}      aVal  - Value to store (must be JSON-serialisable).
 *   undefined is normalised to null before being passed down.
 * @throws {Error} If called with a wrong number of arguments.
 */
GM_ScriptStorageFront.prototype.setValue = function (aName, aVal) {
  if (arguments.length !== 2) {
    throw new this._wrappedContentWin.Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.setValue.arguments"),
            this._script.fileURL, null);
  }

  aName = String(aName);

  let key = cacheKey(this._script, aName);

  // Capture old value for change listeners before invalidation.
  let oldValue = cache.has(key) ? cache.get(key) : undefined;

  invalidateCache(key);

  if (typeof aVal == "undefined") {
    aVal = null;
  }

  this._back.setValue(aName, aVal);

  // Listeners owned by this Front get aRemote=false; listeners owned
  // by other Fronts watching the same key get aRemote=true.
  fireValueChangeListeners(key, oldValue, aVal, this);
};

/**
 * Retrieves a stored value, using the in-memory cache when available.
 *
 * Cache promotion strategy:
 *   - The hit counter for the key is incremented on every call.
 *   - Once the hit count exceeds CACHE_AFTER_N_GETS, the next successful
 *     fetch also stores the value in the cache map.
 *   - Values > CACHE_MAX_VALUE chars are excluded from caching.
 *   - When the cache map exceeds CACHE_SIZE entries it is cleared entirely.
 *
 * The returned value is deep-cloned into the script sandbox via Cu.cloneInto
 * so that scripts cannot hold privileged references.
 *
 * @param {string} aName     - Storage key to look up.
 * @param {*}      [aDefVal] - Returned when the key is absent or null.
 * @returns {*} The stored value (cloned into sandbox scope), or aDefVal.
 */
GM_ScriptStorageFront.prototype.getValue = function (aName, aDefVal) {
  let value;

  aName = String(aName);

  let key = cacheKey(this._script, aName);

  if (cache.has(key)) {
    value = cache.get(key);
  } else {
    let count = (cacheHitCounter.get(key) || 0) + 1;
    let intentToCache = count > CACHE_AFTER_N_GETS;

    let raw = this._back.getValue(aName);

    // Avoid caching large values.
    if ((typeof raw == "string") && (raw.length > CACHE_MAX_VALUE)) {
      count = 0;
      intentToCache = false;
    }

    try {
      value = JSON.parse(raw);
    } catch (e) {
      GM_util.logError(
          MESSAGE_ERROR_PREFIX_FRONT.trim() + "\n" + e, false,
          e.fileName, e.lineNumber);
      return aDefVal;
    }

    if (intentToCache) {
      // Clean caches if scripts dynamically generate lots of keys.
      if (cache.size > CACHE_SIZE) {
        cache.clear();
        cacheHitCounter.clear();
      }
      cache.set(key, value);
    }

    cacheHitCounter.set(key, count);
  }

  if (typeof aDefVal == "undefined") {
    aDefVal = undefined;
  }
  if ((typeof value == "undefined") || (value === null)) {
    return aDefVal;
  }

  return Cu.cloneInto(value, this._sandbox, {
    "wrapReflectors": true,
  });
};

/**
 * Deletes a stored value and invalidates this key's cache entry.
 *
 * @param {string} aName - Storage key to delete.
 */
GM_ScriptStorageFront.prototype.deleteValue = function (aName) {
  aName = String(aName);

  let key = cacheKey(this._script, aName);

  // Capture old value for change listeners before invalidation.
  let oldValue = cache.has(key) ? cache.get(key) : undefined;

  invalidateCache(key);

  this._back.deleteValue(aName);

  fireValueChangeListeners(key, oldValue, undefined, this);
};

/**
 * Returns all stored key names for this script (cloned into sandbox scope).
 *
 * @returns {string[]} Array of key names (cloned), or [] on error.
 */
GM_ScriptStorageFront.prototype.listValues = function () {
  let value;
  try {
    value = this._back.listValues() || [];
    // Round-trip through JSON to detach from any chrome-side references
    // before cloning into the sandbox.
    value = JSON.parse(JSON.stringify(value));
    return Cu.cloneInto(value, this._sandbox, {
      "wrapReflectors": true,
    });
  } catch (e) {
    GM_util.logError(
        MESSAGE_ERROR_PREFIX_FRONT.trim() + "\n" + e, false,
        e.fileName, e.lineNumber);
    return Cu.cloneInto([], this._sandbox);
  }
};

/**
 * Retrieves multiple values at once.
 *
 * @param {string[]|object} aWhat - Array of key names, or an object whose
 *   keys are the names and values are the defaults.
 * @returns {object} Object mapping each key to its stored value (cloned into
 *   sandbox scope).
 */
GM_ScriptStorageFront.prototype.getValues = function (aWhat) {
  let keys;
  let defaults = {};
  if (Array.isArray(aWhat)) {
    keys = aWhat;
  } else if (aWhat && typeof aWhat == "object") {
    keys = Object.keys(aWhat);
    defaults = aWhat;
  } else {
    keys = [];
  }

  // Phase 7d: cache hits served from the module-level Map; only the
  // cache MISSES go to the Back, in a single batched SELECT.
  let result = {};
  let toFetch = [];
  for (let i = 0; i < keys.length; i++) {
    let name = String(keys[i]);
    let key = cacheKey(this._script, name);
    if (cache.has(key)) {
      result[name] = cache.get(key);
    } else {
      toFetch.push(name);
    }
  }

  if (toFetch.length) {
    let raw = this._back.getValuesBatch(toFetch);
    for (let i = 0; i < toFetch.length; i++) {
      let name = toFetch[i];
      let rawVal = raw[name];
      let parsed;
      if (rawVal === undefined) {
        // Key not in DB — fall through to default below.
        parsed = null;
      } else {
        try {
          parsed = JSON.parse(rawVal);
        } catch (e) {
          GM_util.logError(
              MESSAGE_ERROR_PREFIX_FRONT.trim() + " getValues parse:\n" + e,
              false, e.fileName, e.lineNumber);
          parsed = null;
        }
      }
      // Apply per-key cache promotion identical to single-key getValue.
      let key = cacheKey(this._script, name);
      let count = (cacheHitCounter.get(key) || 0) + 1;
      let intentToCache = count > CACHE_AFTER_N_GETS;
      if (typeof rawVal == "string" && rawVal.length > CACHE_MAX_VALUE) {
        count = 0;
        intentToCache = false;
      }
      if (intentToCache && parsed !== null && parsed !== undefined) {
        if (cache.size > CACHE_SIZE) {
          cache.clear();
          cacheHitCounter.clear();
        }
        cache.set(key, parsed);
      }
      cacheHitCounter.set(key, count);

      result[name] = (parsed === null || parsed === undefined)
          ? defaults[name]
          : parsed;
    }
  }

  return Cu.cloneInto(result, this._sandbox, {
    "wrapReflectors": true,
  });
};

/**
 * Stores multiple values at once.  Routes through the Back's
 * setValuesBatch so all writes commit in a single SQLite transaction.
 * Fires per-key change listeners after the batch completes.
 *
 * @param {object} aObj - Object whose keys/values are stored.
 */
GM_ScriptStorageFront.prototype.setValues = function (aObj) {
  if (!aObj || typeof aObj != "object") {
    return undefined;
  }
  let keys = Object.keys(aObj);
  if (!keys.length) {
    return undefined;
  }

  // Capture pre-write old values for change-listener notifications and
  // invalidate the cache before the Back commits the new ones.
  let oldValues = {};
  let normalized = {};
  for (let i = 0; i < keys.length; i++) {
    let name = String(keys[i]);
    let key = cacheKey(this._script, name);
    oldValues[name] = cache.has(key) ? cache.get(key) : undefined;
    invalidateCache(key);
    let val = aObj[keys[i]];
    normalized[name] = (typeof val == "undefined") ? null : val;
  }

  this._back.setValuesBatch(normalized);

  // Fan out change-listener notifications per key.
  let names = Object.keys(normalized);
  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    fireValueChangeListeners(
        cacheKey(this._script, name), oldValues[name],
        normalized[name], this);
  }
};

/**
 * Deletes multiple values at once.  Routes through the Back's
 * deleteValuesBatch (single DELETE … WHERE name IN (…)).
 *
 * @param {string[]} aKeys - Array of key names to delete.
 */
GM_ScriptStorageFront.prototype.deleteValues = function (aKeys) {
  if (!Array.isArray(aKeys) || !aKeys.length) {
    return undefined;
  }

  let names = [];
  let oldValues = {};
  for (let i = 0; i < aKeys.length; i++) {
    let name = String(aKeys[i]);
    names.push(name);
    let key = cacheKey(this._script, name);
    oldValues[name] = cache.has(key) ? cache.get(key) : undefined;
    invalidateCache(key);
  }

  this._back.deleteValuesBatch(names);

  for (let i = 0; i < names.length; i++) {
    let name = names[i];
    fireValueChangeListeners(
        cacheKey(this._script, name), oldValues[name],
        undefined, this);
  }
};

/**
 * Registers a callback to be invoked whenever the named value changes.
 * The callback receives (name, oldValue, newValue, remote) where remote
 * is true when the change originated from a different sandbox.
 *
 * @param {string}   aName     - Storage key to watch.
 * @param {function} aCallback - Called on value change.
 * @returns {number} Listener ID that can be passed to removeValueChangeListener.
 */
GM_ScriptStorageFront.prototype.addValueChangeListener = function (
    aName, aCallback) {
  aName = String(aName);
  let key = cacheKey(this._script, aName);
  let id = gNextListenerId++;

  gListeners.set(id, {
    "cacheKey": key,
    "callback": aCallback,
    "name": aName,
    "storageFront": this,
  });

  if (!gListenersByKey.has(key)) {
    gListenersByKey.set(key, new Set());
  }
  gListenersByKey.get(key).add(id);

  return id;
};

/**
 * Removes a previously registered value-change listener.
 *
 * @param {number} aListenerId - The ID returned by addValueChangeListener.
 */
GM_ScriptStorageFront.prototype.removeValueChangeListener = function (
    aListenerId) {
  let entry = gListeners.get(aListenerId);
  if (!entry) {
    return undefined;
  }

  let keyListeners = gListenersByKey.get(entry.cacheKey);
  if (keyListeners) {
    keyListeners["delete"](aListenerId);
    if (keyListeners.size == 0) {
      gListenersByKey["delete"](entry.cacheKey);
    }
  }
  gListeners["delete"](aListenerId);
};
