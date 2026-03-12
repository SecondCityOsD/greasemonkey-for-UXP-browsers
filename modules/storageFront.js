/**
 * @file storageFront.js
 * @overview Content-process (unprivileged) front end for GM_getValue /
 *   GM_setValue / GM_deleteValue / GM_listValues.
 *
 * This module mirrors the GM_ScriptStorageBack API but runs in the content
 * process.  It communicates with the privileged back end (storageBack.js) in
 * the parent process via synchronous RPC IPC messages
 * ("greasemonkey:scriptVal-get", "greasemonkey:scriptVal-set", etc.).
 *
 * Performance optimisation — read-side cache:
 *   Values are cached in memory after being read CACHE_AFTER_N_GETS (3) times.
 *   Values longer than CACHE_MAX_VALUE (4 096) characters are never cached.
 *   The cache is bounded to CACHE_SIZE (1 024) entries; when the limit is
 *   reached the entire cache is cleared to avoid unbounded growth when scripts
 *   use dynamic keys.
 *
 *   Cache keys have the form "<scriptUuid>:<valueName>" so that values from
 *   different scripts never collide.
 *
 *   Invalidation: the parent process broadcasts a "greasemonkey:value-invalidate"
 *   message whenever a value changes, so stale cache entries are removed
 *   promptly even across tabs.
 *
 * The db / dbFile / close() members are intentionally broken — they exist only
 * to satisfy the interface contract but throw a descriptive error if called,
 * since direct database access is not possible from the content process.
 */

// The "front end" implementation of GM_ScriptStorageFront().
// This is loaded into the content process scope
// and simply delegates to the back end.

const EXPORTED_SYMBOLS = ["GM_ScriptStorageFront"];

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


const MESSAGE_ERROR_PREFIX = "Script storage front end: ";
/** Start caching a value only after it has been read this many times. */
const CACHE_AFTER_N_GETS = 3;
/** Values longer than this (in characters) are never cached. */
const CACHE_MAX_VALUE = 4096;
/** Maximum number of entries in the in-memory value cache. */
const CACHE_SIZE = 1024;

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

var cache = new Map();
var cacheHitCounter = new Map();

Services.cpmm.addMessageListener("greasemonkey:value-invalidate",
    function (aMessage) {
      let data = aMessage.data;
      data.keys.forEach(invalidateCache);
    });

/**
 * Removes a single entry from both the value cache and the hit-count map.
 * Called when the parent broadcasts a value-invalidate message or when a
 * setValue / deleteValue is performed locally.
 *
 * @param {string} aKey - Cache key in the form "<uuid>:<name>".
 */
function invalidateCache(aKey) {
  cache["delete"](aKey);
  cacheHitCounter["delete"](aKey);
}

/**
 * Generates the cache key for a script/name pair.
 *
 * @param {IPCScript} aScript - The script whose value is being accessed.
 * @param {string}    aName   - The value name.
 * @returns {string} Cache key string, e.g. "abc-123:myKey".
 */
function cacheKey(aScript, aName) {
  return aScript.uuid + ":" + aName;
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Content-side storage object for a single userscript.
 *
 * @constructor
 * @param {nsIMessageSender} aMessageManager    - Frame message manager used
 *   to send RPC messages to the parent process.
 * @param {Window}           aWrappedContentWin - The content window (used to
 *   construct Error objects that point back to the script).
 * @param {Sandbox}          aSandbox           - The script's sandbox; values
 *   are cloned into it before being returned.
 * @param {IPCScript}        aScript            - The script object; provides
 *   the UUID and id used as message parameters.
 */
function GM_ScriptStorageFront(
    aMessageManager, aWrappedContentWin, aSandbox, aScript) {
  this._db = null;
  this._messageManager = aMessageManager;
  this._sandbox = aSandbox;
  this._script = aScript;
  this._wrappedContentWin = aWrappedContentWin;
}

Object.defineProperty(GM_ScriptStorageFront.prototype, "db", {
  "get": function GM_ScriptStorageFront_getDb() {
    throw new Error(
        MESSAGE_ERROR_PREFIX
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.storage.db.noConnection"));
  },
  "enumerable": true,
});

Object.defineProperty(GM_ScriptStorageFront.prototype, "dbFile", {
  "get": function GM_ScriptStorageFront_getDbFile() {
    throw new Error(
        MESSAGE_ERROR_PREFIX
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.storage.db.noFile"));
  },
  "enumerable": true,
});

GM_ScriptStorageFront.prototype.close = function () {
  throw new this._wrappedContentWin.Error(
      MESSAGE_ERROR_PREFIX
      + GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("error.storage.db.noConnection"),
      this._script.fileURL, null);
};

/**
 * Stores a value in the back-end database via IPC.
 * Invalidates the local cache entry for the key immediately.
 *
 * @param {string} aName - Storage key.
 * @param {*}      aVal  - Value to store (must be JSON-serialisable).
 *   undefined is normalised to null before sending.
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

  invalidateCache(key);

  if (typeof aVal == "undefined") {
    aVal = null;
  }
  this._messageManager.sendRpcMessage(
      "greasemonkey:scriptVal-set", {
        "scriptId": this._script.id,
        "name": aName,
        "val": aVal,
      });
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

    value = this._messageManager.sendRpcMessage(
        "greasemonkey:scriptVal-get", {
          "cacheKey": key,
          "name": aName,
          "scriptId": this._script.id,
          "willCache": intentToCache,
        });
    value = value.length && value[0];

    // Avoid caching large values.
    if ((typeof value == "string") && (value.length > CACHE_MAX_VALUE)) {
      count = 0;
      intentToCache = false;
    }

    try {
      value = JSON.parse(value);
    } catch (e) {
      GM_util.logError(
          MESSAGE_ERROR_PREFIX.trim() + "\n" + e, false,
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
 * Deletes a stored value via IPC and invalidates its cache entry.
 *
 * @param {string} aName - Storage key to delete.
 */
GM_ScriptStorageFront.prototype.deleteValue = function (aName) {
  aName = String(aName);

  let key = cacheKey(this._script, aName);

  invalidateCache(key);

  this._messageManager.sendRpcMessage(
      "greasemonkey:scriptVal-delete", {
        "cacheKey": key,
        "name": aName,
        "scriptId": this._script.id,
      });
};

/**
 * Returns all stored key names for this script.
 * The result is cloned into sandbox scope before being returned.
 *
 * @returns {string[]} Array of key names (cloned into sandbox), or [] on error.
 */
GM_ScriptStorageFront.prototype.listValues = function () {
  var value = this._messageManager.sendRpcMessage(
      "greasemonkey:scriptVal-list", {
        "scriptId": this._script.id,
      });
  value = value.length && value[0] || [];

  try {
    value = JSON.parse(JSON.stringify(value));
    return Cu.cloneInto(value, this._sandbox, {
      "wrapReflectors": true,
    });
  } catch (e) {
    GM_util.logError(
        MESSAGE_ERROR_PREFIX.trim() + "\n" + e, false,
        e.fileName, e.lineNumber);
    return Cu.cloneInto([], this._sandbox);
  }
};
