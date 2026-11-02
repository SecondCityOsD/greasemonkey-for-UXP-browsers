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
 *     values.  Every write, whoever makes it (a page, the Values tab, a
 *     backup restore, Sync), goes through its _change(), which keeps the
 *     shared read cache in step and fires the value-change listeners.
 *     Each script's database lives at:
 *       <profile>/gm_scripts/<baseDirName>.db
 *
 *   GM_ScriptStorageFront(aWrappedContentWin, aSandbox, aScript)
 *     Per-sandbox wrapper around a Back instance.  Adds:
 *       - Reads through the shared cache with hit-counter promotion
 *         (avoids hitting SQLite for hot keys; large values bypass it).
 *       - Sandbox-cloning of returned values (Cu.cloneInto) so scripts
 *         cannot hold privileged references.
 *       - Value-change listeners (addValueChangeListener / removeValue-
 *         ChangeListener), which last as long as the page.  The "remote"
 *         flag is false only for the page's own writes.
 *       - Batched getValues / setValues / deleteValues helpers.
 *
 *   getStorageBackForScript(aScript)
 *     Returns the singleton Back for the script, creating it on first use.
 *
 *   releaseStorageForScript(aScriptId)
 *     Closes and forgets a script's Back, cache and listeners (uninstall).
 *
 *   closeAllStorageBacks()
 *     Closes every Back this module has opened.  Called on quit-application.
 *
 * UXP runs chrome and content in the same JS runtime, so the Front talks
 * to the Back via direct method calls.  The Back registry is module-private
 * and accessed through the three functions above.  Code outside this module
 * should use getStorageBackForScript rather than a private Back: a second
 * connection to the same file is never needed.
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
  "releaseStorageForScript",
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
// ─── Shared value cache and change listeners ────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Module-level value cache: cacheKey() → the parsed value (undefined for
 * a key known to be absent).  Shared by every Front and kept in step by
 * every Back write, so a value changed anywhere (another tab, the Values
 * tab, a backup restore, Sync) is never served stale.
 */
var cache = new Map();
/** cacheKey() → disk reads so far, for promotion into the cache. */
var cacheHitCounter = new Map();

/**
 * Listener registry.
 *   gListeners:         id → {cacheKey, name, callback, storageFront,
 *                             scriptId, windowId}
 *   gListenersByKey:    cacheKey → Set<id>
 *   gListenersByWindow: inner window id → Set<id>, so a page's listeners
 *                       go when the page does (see onInnerWindowDestroyed)
 * Ids start at 1, so none is falsy.
 */
var gListeners = new Map();
var gListenersByKey = new Map();
var gListenersByWindow = new Map();
var gNextListenerId = 1;
var gWatchingWindows = false;

/**
 * Generates the cache key for a script/name pair.  A script id
 * (namespace/name, both single metadata lines) never contains "\n", so
 * the key is unambiguous: ns/V + "pre:token" and ns/V:pre + "token" no
 * longer meet.
 *
 * @param {Script|string} aScript - The script, or its id.
 * @param {string}        aName   - The value name.
 * @returns {string}
 */
function cacheKey(aScript, aName) {
  return ((typeof aScript == "string") ? aScript : aScript.id) + "\n" + aName;
}

/**
 * Returns true iff aOld and aNew are equivalent for value-change-listener
 * deduplication purposes.  Mirrors Violentmonkey's gm-values.js:49
 * "raw !== oldRaw" semantics: compares via JSON.stringify so structural
 * equality of objects / arrays is honoured.  Property-order differences
 * inside objects WILL register as a change — matching VM's behaviour and
 * a deliberate trade-off (a deep-equal comparator would be heavier and
 * still not perfectly catch Date / RegExp / Map edge cases).
 *
 * @param {*} aOld
 * @param {*} aNew
 * @returns {boolean}
 */
function valuesEqualForListener(aOld, aNew) {
  if (aOld === aNew) {
    return true;
  }
  if (typeof aOld !== typeof aNew) {
    return false;
  }
  if (aOld === null || aNew === null) {
    return aOld === aNew;
  }
  try {
    return JSON.stringify(aOld) === JSON.stringify(aNew);
  } catch (e) {
    return false;
  }
}

/**
 * Parses a raw stored value.  A missing row (null) is undefined.
 *
 * @param {string|null} aRaw
 * @returns {*}
 * @throws {SyntaxError} for a row that isn't JSON.
 */
function parseStored(aRaw) {
  return ((aRaw === null) || (typeof aRaw == "undefined"))
      ? undefined
      : JSON.parse(aRaw);
}

/**
 * Resolves the current stored value for a key, preferring the in-memory
 * cache when present and falling back to a single SQLite read when not.
 * Returns undefined for absent keys.
 *
 * Used by the change-listener deduplication path so we can decide
 * "did this set actually change anything?" without firing the listener
 * spuriously on identical re-sets.  Only called when someone listens to
 * the key, so unwatched writes never pay for the read.
 *
 * @param {GM_ScriptStorageBack} aBack
 * @param {string}               aName
 * @param {string}               aKey  - Pre-computed cacheKey() value.
 * @returns {*} The current value, or undefined if the key is absent.
 */
function readCurrentValue(aBack, aName, aKey) {
  if (cache.has(aKey)) {
    return cache.get(aKey);
  }
  try {
    return parseStored(aBack.getValue(aName));
  } catch (e) {
    return undefined;
  }
}

/**
 * Counts a disk read of aKey and caches its value once the key has been
 * read more than CACHE_AFTER_N_GETS times.  Values longer than
 * CACHE_MAX_VALUE characters are never cached.  Both maps are bounded:
 * the cache by CACHE_SIZE, and the counter (which also holds keys read
 * only a few times, such as per-page keys) by four times that.
 *
 * @param {string}      aKey   - cacheKey() value.
 * @param {string|null} aRaw   - The raw row, null when absent.
 * @param {*}           aValue - parseStored(aRaw).
 */
function noteDiskRead(aKey, aRaw, aValue) {
  let count = (cacheHitCounter.get(aKey) || 0) + 1;
  if ((typeof aRaw == "string") && (aRaw.length > CACHE_MAX_VALUE)) {
    count = 0;
  } else if (count > CACHE_AFTER_N_GETS) {
    if (cache.size > CACHE_SIZE) {
      cache.clear();
      cacheHitCounter.clear();
    }
    cache.set(aKey, aValue);
  }
  if (cacheHitCounter.size > (CACHE_SIZE * 4)) {
    cacheHitCounter.clear();
  }
  cacheHitCounter.set(aKey, count);
}

/**
 * Removes a single entry from both the value cache and the hit-count map.
 *
 * @param {string} aKey - cacheKey() value.
 */
function invalidateCache(aKey) {
  cache["delete"](aKey);
  cacheHitCounter["delete"](aKey);
}

/**
 * Clones a stored value into a script sandbox before it crosses the
 * chrome -> sandbox boundary.  Primitives (string/number/boolean) and
 * null/undefined cross compartments safely by value, so only objects and
 * arrays take the Cu.cloneInto round-trip.  Mirrors the fast-path used by
 * getValue()/listValues(); handing an un-cloned chrome-realm object to a
 * sandbox callback is a cross-compartment escape foothold (finding S7).
 *
 * @param {*}       aValue   - Chrome-side value to hand to the sandbox.
 * @param {Sandbox} aSandbox - Target script sandbox.
 * @returns {*} A sandbox-owned copy (or the value itself if primitive).
 */
function cloneValueForSandbox(aValue, aSandbox) {
  if ((aValue === null) || (typeof aValue === "undefined") || !aSandbox) {
    return aValue;
  }
  let t = typeof aValue;
  if ((t === "string") || (t === "number") || (t === "boolean")) {
    return aValue;
  }
  return Cu.cloneInto(aValue, aSandbox, {
    "wrapReflectors": true,
  });
}

/**
 * Drops one listener from all three registry maps.
 *
 * @param {number} aListenerId
 */
function removeListener(aListenerId) {
  let entry = gListeners.get(aListenerId);
  if (!entry) {
    return undefined;
  }
  gListeners["delete"](aListenerId);
  [[gListenersByKey, entry.cacheKey], [gListenersByWindow, entry.windowId]]
      .forEach(function (aIndex) {
        let ids = aIndex[0].get(aIndex[1]);
        if (ids) {
          ids["delete"](aListenerId);
          if (ids.size == 0) {
            aIndex[0]["delete"](aIndex[1]);
          }
        }
      });
}

/**
 * "inner-window-destroyed": the page is gone (navigated away and out of
 * the back-forward cache, or its tab closed), so its listeners go too.
 * Without this, every page view of a script that listens to a value left
 * a callback (and its sandbox and window) behind for the whole session,
 * still called on every later change.
 */
var gWindowObserver = {
  "observe": function (aSubject, aTopic, aData) {
    let windowId;
    try {
      windowId = aSubject.QueryInterface(Ci.nsISupportsPRUint64).data;
    } catch (e) {
      return undefined;
    }
    let ids = gListenersByWindow.get(windowId);
    if (ids) {
      Array.from(ids).forEach(removeListener);
    }
  },
};

/**
 * The inner window id of the page a Front serves, or null.
 *
 * @param {Window} aWin
 * @returns {number|null}
 */
function innerWindowIdOf(aWin) {
  try {
    return aWin.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDOMWindowUtils).currentInnerWindowID;
  } catch (e) {
    return null;
  }
}

/**
 * Fires every listener registered for the given key.  Listeners whose
 * owning Front matches aSetterFront receive aRemote=false; every other
 * listener (other tabs, or a write from the Values tab, a backup restore
 * or Sync, which have no Front) receives aRemote=true.
 *
 * @param {string}  aKey          - cacheKey() value.
 * @param {*}       aOldValue     - Previous value (may be undefined).
 * @param {*}       aNewValue     - New value (may be undefined).
 * @param {GM_ScriptStorageFront} [aSetterFront] - The Front that wrote.
 */
function fireValueChangeListeners(aKey, aOldValue, aNewValue, aSetterFront) {
  let listenerIds = gListenersByKey.get(aKey);
  if (!listenerIds || listenerIds.size == 0) {
    return undefined;
  }
  Array.from(listenerIds).forEach(function (aListenerId) {
    let entry = gListeners.get(aListenerId);
    if (!entry) {
      return undefined;
    }
    let front = entry.storageFront;
    if (GM_util.windowIsClosed(front._wrappedContentWin)) {
      // Its page is gone and the destroyed-window notice hasn't come yet.
      removeListener(aListenerId);
      return undefined;
    }
    let aRemote = front !== aSetterFront;
    // Clone the values into the LISTENER's own sandbox before dispatch:
    // aOldValue/aNewValue are chrome-realm objects (JSON.parse results from
    // chrome scope), and handing those straight to a sandbox callback is a
    // cross-compartment escape foothold (finding S7).  Different listeners
    // may own different sandboxes, so this clones per-listener.
    let oldForListener = cloneValueForSandbox(aOldValue, front._sandbox);
    let newForListener = cloneValueForSandbox(aNewValue, front._sandbox);
    try {
      entry.callback(entry.name, oldForListener, newForListener, aRemote);
    } catch (e) {
      GM_util.logError(e, false, e.fileName, e.lineNumber);
    }
  });
}

/**
 * Forgets everything this module holds for one script: its cached
 * values, its listeners, and its Back (whose connection is closed).
 * Called by Script.uninstall before the script's .db is deleted: an open
 * connection made that delete fail on Windows (so it was queued and then
 * hit a reinstalled script's values at the next start), and a cached Back
 * kept a reinstall in the same session writing to the old file.
 *
 * @param {string} aScriptId
 */
function releaseStorageForScript(aScriptId) {
  let back = gBackByScriptId.get(aScriptId);
  if (back) {
    gBackByScriptId["delete"](aScriptId);
    // A page the script still runs in keeps this Back; it must not
    // reopen (and so recreate) the file being deleted.
    back._released = true;
    try {
      back.close();
    } catch (e) {
      // A statement may still be pending; the file is queued either way.
    }
  }
  let prefix = cacheKey(aScriptId, "");
  [cache, cacheHitCounter].forEach(function (aMap) {
    Array.from(aMap.keys()).forEach(function (aKey) {
      if (aKey.startsWith(prefix)) {
        aMap["delete"](aKey);
      }
    });
  });
  Array.from(gListeners.keys()).forEach(function (aListenerId) {
    if (gListeners.get(aListenerId).scriptId === aScriptId) {
      removeListener(aListenerId);
    }
  });
}

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
      if (this._released) {
        throw new Error(MESSAGE_ERROR_PREFIX_BACK
            + "the script was uninstalled: " + this._script.id);
      }
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
 * The one way values change.  Runs aWrite (the SQL) inside the
 * bookkeeping every writer needs, so a write from a page, the Values tab,
 * a backup restore or Sync looks the same to running scripts: the shared
 * cache drops the keys, the owning Script gets "val-set" / "val-del", and
 * the listeners of every key whose value really changed are told.
 *
 * @private
 * @param {Array} aChanges - [name, new value] pairs; an undefined new
 *   value means the key is deleted.
 * @param {GM_ScriptStorageFront} [aSource] - The Front that wrote, if any
 *   (its own listeners get remote=false).
 * @param {function} aWrite - Performs the SQL; called with this Back.
 */
GM_ScriptStorageBack.prototype._change = function (aChanges, aSource, aWrite) {
  let back = this;
  let id = this._script.id;
  // Old values are read only for keys someone listens to.
  let watched = [];
  aChanges.forEach(function (aChange) {
    let key = cacheKey(id, aChange[0]);
    if (gListenersByKey.has(key)) {
      watched.push({
        "key": key,
        "old": readCurrentValue(back, aChange[0], key),
        "value": aChange[1],
      });
    }
    invalidateCache(key);
  });

  aWrite.call(this);

  // Defensive: getStorageBackForScript() resolves the IPCScript view
  // back to the full Script via the service, but on very early startup
  // it may fall back to the IPCScript which lacks .changed().  Skip
  // the notification rather than throwing.
  if (typeof this._script.changed == "function") {
    aChanges.forEach(function (aChange) {
      back._script.changed(
          (typeof aChange[1] == "undefined") ? "val-del" : "val-set",
          aChange[0]);
    });
  }
  // As in Violentmonkey (gm-values.js): only a real change wakes a
  // listener, so re-setting the same value or deleting an absent key
  // doesn't.
  watched.forEach(function (aWatched) {
    if (!valuesEqualForListener(aWatched.old, aWatched.value)) {
      fireValueChangeListeners(
          aWatched.key, aWatched.old, aWatched.value, aSource);
    }
  });
};

/**
 * Persists a key/value pair for this script.
 * The value is JSON-serialised, so any JSON-safe JS value is accepted;
 * undefined is stored as null.
 *
 * @param {string} aName - The storage key.
 * @param {*}      aVal  - The value to store (must be JSON-serialisable).
 * @param {GM_ScriptStorageFront} [aSource] - The Front that wrote, if any.
 * @throws {Error} If called with fewer than 2 arguments.
 */
GM_ScriptStorageBack.prototype.setValue = function (aName, aVal, aSource) {
  if (arguments.length < 2) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.setValue.arguments"));
  }
  if (typeof aVal == "undefined") {
    aVal = null;
  }

  this._change([[aName, aVal]], aSource, function () {
    let stmt = this.db.createStatement(
        "INSERT OR REPLACE INTO scriptvals (name, value)"
        + " VALUES (:name, :value)");
    try {
      stmt.params.name = aName;
      stmt.params.value = JSON.stringify(aVal);
      stmt.execute();
    } finally {
      stmt.reset();
    }
  });
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
 *
 * @param {string} aName - The storage key to delete.
 * @param {GM_ScriptStorageFront} [aSource] - The Front that wrote, if any.
 */
GM_ScriptStorageBack.prototype.deleteValue = function (aName, aSource) {
  this._change([[aName, undefined]], aSource, function () {
    let stmt = this.db.createStatement(
        "DELETE FROM scriptvals WHERE name = :name");
    try {
      stmt.params.name = aName;
      stmt.execute();
    } finally {
      stmt.reset();
    }
  });
};

/**
 * Batched fetch of multiple stored values in a single SQL query.
 * Returns a plain object mapping each requested name to its raw JSON
 * string (the value as stored), or omits names that don't exist.
 *
 * Issues one SELECT … WHERE name IN (…) instead of N separate getValue()
 * calls, which is measurable on slow disks even with synchronous=OFF.
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
 * One BEGIN … COMMIT covers the whole batch, with statement reuse across
 * the loop, instead of N implicit transactions.
 *
 * @param {object} aMap - { name: value } map.  Values are JSON-
 *                        serialised here; undefined is stored as null.
 * @param {GM_ScriptStorageFront} [aSource] - The Front that wrote, if any.
 */
GM_ScriptStorageBack.prototype.setValuesBatch = function (aMap, aSource) {
  let changes = Object.keys(aMap || {}).map(function (aName) {
    let value = aMap[aName];
    return [aName, (typeof value == "undefined") ? null : value];
  });
  if (!changes.length) {
    return;
  }

  this._change(changes, aSource, function () {
    let stmt = this.db.createStatement(
        "INSERT OR REPLACE INTO scriptvals (name, value)"
        + " VALUES (:name, :value)");
    let inTx = false;
    try {
      this.db.beginTransaction();
      inTx = true;
      for (let i = 0; i < changes.length; i++) {
        stmt.params.name = changes[i][0];
        stmt.params.value = JSON.stringify(changes[i][1]);
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
  });
};

/**
 * Batched deletion of multiple stored values in a single SQL statement.
 *
 * @param {string[]} aNames - Storage keys to delete.
 * @param {GM_ScriptStorageFront} [aSource] - The Front that wrote, if any.
 */
GM_ScriptStorageBack.prototype.deleteValuesBatch = function (aNames, aSource) {
  if (!aNames || !aNames.length) {
    return;
  }

  let changes = aNames.map(function (aName) {
    return [aName, undefined];
  });
  this._change(changes, aSource, function () {
    let placeholders = aNames
        .map(function (_, i) { return ":n" + i; })
        .join(", ");
    let stmt = this.db.createStatement(
        "DELETE FROM scriptvals WHERE name IN (" + placeholders + ")");
    try {
      for (let i = 0; i < aNames.length; i++) {
        stmt.params["n" + i] = aNames[i];
      }
      stmt.execute();
    } finally {
      stmt.reset();
    }
  });
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
 * _change() to typeof-check before calling .changed().
 *
 * The lookup runs on every call, not only the first: an update installs
 * a new Script object under the same id, and a Back still holding the
 * old one would send its notifications to a script no longer installed.
 *
 * @param {Script|IPCScript} aScript - Either a full Script or its IPC view.
 *                                     Must expose at least .id and .baseDirName.
 * @returns {GM_ScriptStorageBack}
 */
function getStorageBackForScript(aScript) {
  let id = aScript.id;
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
    // Service not ready yet; use whatever we got.
  }
  let back = gBackByScriptId.get(id);
  if (!back) {
    back = new GM_ScriptStorageBack(fullScript);
    gBackByScriptId.set(id, back);
  } else if ((fullScript !== back._script)
      && (typeof fullScript.changed == "function")) {
    if (fullScript.baseDirName != back._script.baseDirName) {
      // Its values file moved with it; reopen there on next use.
      back.close();
    }
    back._script = fullScript;
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
// ─── Front: one per sandbox ─────────────────────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

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
 * Throws an Error constructed in the SCRIPT's JS realm so that the
 * script's own `catch (e) { e instanceof Error }` check matches.
 *
 * A script @granted into a sandbox runs in a `Cu.Sandbox` with
 * `wantXrays: true` — its own realm with its own `Error` constructor,
 * distinct from both chrome and the content window.  Pre-fix, the
 * Front's throws used a mix of `new Error(...)` (chrome realm) and
 * `new this._wrappedContentWin.Error(...)` (content-window realm),
 * neither of which the script's identifier `Error` resolves to.  A
 * try-catch in the script that branched on `e instanceof Error`
 * silently took the false branch every time, masking failures.
 *
 * Falls back through Error sources in order of preference (defensive
 * only: `_sandbox` is set in the Front constructor and shouldn't be
 * missing during normal operation).
 *
 * @private
 * @param {string} aMessage - Localised error message text.
 */
GM_ScriptStorageFront.prototype._throwSandboxError = function (aMessage) {
  let ErrorCtor = (this._sandbox && this._sandbox.Error)
      || (this._wrappedContentWin && this._wrappedContentWin.Error)
      || Error;
  let fileURL = this._script ? this._script.fileURL : null;
  throw new ErrorCtor(aMessage, fileURL, null);
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
    this._throwSandboxError(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.setValue.arguments"));
  }

  aName = String(aName);

  let key = cacheKey(this._script, aName);

  if (typeof aVal == "undefined") {
    aVal = null;
  }

  // Reject non-JSON-serialisable values up front (circular structures,
  // BigInt, etc.) so the script gets a sandbox-realm Error it can
  // recognise via `instanceof Error`.  Pre-fix, JSON.stringify threw a
  // chrome-realm TypeError from inside _back.setValue, which the
  // script's catch block couldn't match against its own Error type.
  //
  // Use the SANDBOX's Error constructor — not the content window's —
  // because a script @granted into a sandbox runs in its own JS realm
  // (`Cu.Sandbox` with `wantXrays: true`) whose `Error` global is
  // distinct from the content window's.  `new sandbox.Error(...)`
  // produces an object the script's `e instanceof Error` check
  // matches; `new wrappedContentWin.Error(...)` does not.
  try {
    JSON.stringify(aVal);
  } catch (e) {
    this._throwSandboxError(
        "GM_setValue: value is not JSON-serialisable: " + e.message);
  }

  // No-op identical-write fast path: if the value held in the cache
  // is structurally equal to the new value, skip the SQL write and
  // the listener fire entirely.  Matches VM's deepCopyDiff behaviour
  // (src/common/object.js:114-172) — scripts that defensively re-
  // setValue the same config on every page navigation pay zero cost.
  //
  // Only safe to check against the cache, not against disk: a cache
  // miss could mean the disk has a different value, so falling
  // through to the normal path is correct in that case.
  if (cache.has(key) && valuesEqualForListener(cache.get(key), aVal)) {
    return;
  }

  // The Back keeps the cache in step and tells the listeners.
  this._back.setValue(aName, aVal, this);
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
    let raw = this._back.getValue(aName);
    try {
      value = parseStored(raw);
    } catch (e) {
      GM_util.logError(
          MESSAGE_ERROR_PREFIX_FRONT.trim() + "\n" + e, false,
          e.fileName, e.lineNumber);
      return aDefVal;
    }
    noteDiskRead(key, raw, value);
  }

  if ((typeof value == "undefined") || (value === null)) {
    return aDefVal;
  }

  // Skip the cross-compartment clone for primitives.  SpiderMonkey
  // passes strings / numbers / booleans across compartments by value
  // already — primitives are immutable, so there's no aliasing risk
  // a clone would defend against, and Cu.cloneInto's compartment
  // round-trip costs ~10-50µs per call even for a single short string.
  // For object / array values the clone is still required so the
  // script can't mutate the cached entry held by the Back.
  let t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return value;
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
  this._back.deleteValue(String(aName), this);
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
    // `_back.listValues()` returns a fresh chrome-side array of
    // primitive strings; Cu.cloneInto already deep-copies it into the
    // sandbox, so no JSON.parse(JSON.stringify(...)) round-trip is
    // needed.
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

  // Cache hits are served from the module-level Map; only the cache
  // MISSES go to the Back, in a single batched SELECT.
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
      // A missing row comes back as no property: null, as getValue sees it.
      let rawVal = (name in raw) ? raw[name] : null;
      let parsed;
      try {
        parsed = parseStored(rawVal);
        noteDiskRead(cacheKey(this._script, name), rawVal, parsed);
      } catch (e) {
        GM_util.logError(
            MESSAGE_ERROR_PREFIX_FRONT.trim() + " getValues parse:\n" + e,
            false, e.fileName, e.lineNumber);
        parsed = undefined;
      }
      result[name] = parsed;
    }
  }

  // Absent (or null) values take their defaults, cached or not.
  Object.keys(result).forEach(function (aName) {
    if ((result[aName] === null) || (typeof result[aName] == "undefined")) {
      result[aName] = defaults[aName];
    }
  });

  return Cu.cloneInto(result, this._sandbox, {
    "wrapReflectors": true,
  });
};

/**
 * Stores multiple values at once.  Routes through the Back's
 * setValuesBatch so all writes commit in a single SQLite transaction;
 * the Back keeps the cache in step and tells the listeners.
 *
 * @param {object} aObj - Object whose keys/values are stored.
 */
GM_ScriptStorageFront.prototype.setValues = function (aObj) {
  if (!aObj || typeof aObj != "object") {
    return undefined;
  }
  let normalized = {};
  Object.keys(aObj).forEach(function (aKey) {
    normalized[String(aKey)] = aObj[aKey];
  });
  this._back.setValuesBatch(normalized, this);
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
  this._back.deleteValuesBatch(aKeys.map(String), this);
};

/**
 * Registers a callback to be invoked whenever the named value changes.
 * The callback receives (name, oldValue, newValue, remote) where remote
 * is true when the change came from anywhere but this page.  The
 * listener lasts as long as the page: it goes when the page's window is
 * destroyed.
 *
 * @param {string}   aName     - Storage key to watch.
 * @param {function} aCallback - Called on value change.
 * @returns {number} Listener ID (never 0) for removeValueChangeListener.
 */
GM_ScriptStorageFront.prototype.addValueChangeListener = function (
    aName, aCallback) {
  aName = String(aName);
  let key = cacheKey(this._script, aName);
  let id = gNextListenerId++;
  if (typeof this._windowId == "undefined") {
    this._windowId = innerWindowIdOf(this._wrappedContentWin);
  }
  if (!gWatchingWindows) {
    Services.obs.addObserver(gWindowObserver, "inner-window-destroyed", false);
    gWatchingWindows = true;
  }

  gListeners.set(id, {
    "cacheKey": key,
    "callback": aCallback,
    "name": aName,
    "scriptId": this._script.id,
    "storageFront": this,
    "windowId": this._windowId,
  });
  [[gListenersByKey, key], [gListenersByWindow, this._windowId]]
      .forEach(function (aIndex) {
        if (!aIndex[0].has(aIndex[1])) {
          aIndex[0].set(aIndex[1], new Set());
        }
        aIndex[0].get(aIndex[1]).add(id);
      });

  return id;
};

/**
 * Removes a previously registered value-change listener.  Only the
 * script's own: ids are sequential, and any script could otherwise
 * remove every other script's listeners.
 *
 * @param {number} aListenerId - The ID returned by addValueChangeListener.
 */
GM_ScriptStorageFront.prototype.removeValueChangeListener = function (
    aListenerId) {
  let entry = gListeners.get(aListenerId);
  if (entry && (entry.scriptId === this._script.id)) {
    removeListener(aListenerId);
  }
};
