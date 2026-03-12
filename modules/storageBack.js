/**
 * @file storageBack.js
 * @overview Back-end (privileged / component-scope) implementation of
 *   GM_ScriptStorageBack — the SQLite-based persistent key/value store for
 *   userscript GM_getValue / GM_setValue / GM_deleteValue / GM_listValues.
 *
 * Each script gets its own SQLite database file located at:
 *   <profile>/gm_scripts/<baseDirName>.db
 *
 * The database contains a single table "scriptvals" with (name TEXT, value TEXT)
 * where values are JSON-serialised to support all JS primitive types.
 *
 * This module is loaded into the privileged parent process.  The unprivileged
 * content-side counterpart is storageFront.js, which talks to this module via
 * IPC messages.
 *
 * SQLite PRAGMA notes (see bug #1879):
 *   auto_vacuum=INCREMENTAL — reclaims free pages gradually rather than on VACUUM.
 *   journal_mode=MEMORY     — keeps the write-ahead journal in memory for speed.
 *   synchronous=OFF         — trades crash safety for performance (profile data only).
 *   wal_autocheckpoint=10   — checkpoints the WAL every 10 pages.
 */

// The "back end" implementation of GM_ScriptStorageBack().
// This is loaded into the component scope and is capable of accessing
// the file based SQL store.

const EXPORTED_SYMBOLS = ["GM_ScriptStorageBack"];

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


const MESSAGE_ERROR_PREFIX = "Script storage back end: ";

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
  this._db.close();
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

  this._script.changed("val-set", aName);
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
        MESSAGE_ERROR_PREFIX + "getValue():" + "\n" + e, false,
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

  this._script.changed("val-del", aName);
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
