/**
 * @file backupScheduler.js
 * @overview Scheduled, rotating, on-disk backups of all user scripts.
 *
 * No mainstream userscript manager offers timed backups (Tampermonkey's
 * cloud backups are manual-only); it's trivial here because XPCOM writes
 * real files to arbitrary paths.  Pointing the folder at a directory some
 * sync client watches (Dropbox, Syncthing, OneDrive…) gives cloud backup
 * with zero OAuth code — the OS sync client does the upload.
 *
 *   extensions.greasemonkey.backup.auto.intervalDays (default 0)
 *     How often to write a backup, in days.  0 = automatic backups off
 *     (the feature is opt-in).
 *   extensions.greasemonkey.backup.auto.folder (default "")
 *     Destination directory path; empty = <profile>/gm_backups.
 *   extensions.greasemonkey.backup.auto.keep (default 5)
 *     How many greasemonkey-auto-*.zip files to retain before pruning the
 *     oldest.
 *   extensions.greasemonkey.backup.auto.lastBackup
 *     Epoch-ms of the last successful backup (string: exceeds int32).
 *
 * Same lifecycle pattern as updateScheduler.js: hourly heartbeat plus a
 * delayed first tick, started/stopped by the service at
 * profile-after-change / quit-application.  The heavy backup module is
 * only imported when a backup actually runs.
 */

const EXPORTED_SYMBOLS = ["GM_backupScheduler"];

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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 5 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 60 * 1000;

const AUTO_PREFIX = "greasemonkey-auto-";
const KEEP_DEFAULT = 5;
const KEEP_MAX = 50;

var GM_backupScheduler = {
  "_startupTimer": null,
  "_tickTimer": null,

  /** Arms the timers; idempotent. */
  "start": function () {
    if (this._tickTimer) {
      return undefined;
    }

    this._startupTimer = Cc["@mozilla.org/timer;1"]
        .createInstance(Ci.nsITimer);
    this._startupTimer.initWithCallback({
      "notify": GM_backupScheduler.tick.bind(GM_backupScheduler),
    }, STARTUP_DELAY_MS, Ci.nsITimer.TYPE_ONE_SHOT);

    this._tickTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._tickTimer.initWithCallback({
      "notify": GM_backupScheduler.tick.bind(GM_backupScheduler),
    }, TICK_INTERVAL_MS, Ci.nsITimer.TYPE_REPEATING_SLACK);
  },

  "stop": function () {
    if (this._startupTimer) {
      this._startupTimer.cancel();
      this._startupTimer = null;
    }
    if (this._tickTimer) {
      this._tickTimer.cancel();
      this._tickTimer = null;
    }
  },

  /**
   * Hourly heartbeat: writes a backup when the configured interval has
   * elapsed since the last successful one.  lastBackup is only stamped on
   * success, so a failing destination (unplugged drive, bad path) retries
   * every tick — visibly, via the error console — instead of silently
   * waiting out a whole interval.
   */
  "tick": function () {
    let days = parseInt(
        GM_prefRoot.getValue("backup.auto.intervalDays", 0), 10);
    if (isNaN(days) || (days <= 0)) {
      return undefined;
    }

    let last = parseInt(
        GM_prefRoot.getValue("backup.auto.lastBackup", "0"), 10);
    if (isNaN(last) || (last < 0)) {
      last = 0;
    }
    let now = Date.now();
    if (last > now) {
      // Clock moved backwards past the recorded backup; don't stall.
      last = 0;
    }
    if ((now - last) < (days * MS_PER_DAY)) {
      return undefined;
    }

    this.backupNow(null, function (aOk, aPath, aErr) {
      if (!aOk) {
        GM_util.logError(
            "Backup scheduler: automatic backup failed: " + aErr, false);
      }
    });
  },

  /**
   * Resolves (and creates if needed) the destination directory:
   * aOverridePath, else the backup.auto.folder pref, else
   * <profile>/gm_backups.
   */
  "resolveFolder": function (aOverridePath) {
    let path = aOverridePath
        || GM_prefRoot.getValue("backup.auto.folder", "");
    let dir;
    if (path) {
      dir = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
      dir.initWithPath(path);
    } else {
      dir = GM_util.scriptDir().parent;
      dir.append("gm_backups");
    }
    if (!dir.exists()) {
      dir.create(Ci.nsIFile.DIRECTORY_TYPE, GM_CONSTANTS.directoryMask);
    }
    return dir;
  },

  /**
   * Writes a dated backup zip immediately (scripts + values + settings,
   * via GM_BackupExport), prunes old automatic backups, and stamps
   * lastBackup on success.  Also driven by the options dialog's
   * "Back up now" button.
   *
   * @param {string|null} aFolderPath - Destination override, or null for
   *   the configured/default folder.
   * @param {function} [aCallback] - Called (success, filePath, errorMsg).
   */
  "backupNow": function (aFolderPath, aCallback) {
    aCallback = aCallback || function () {};

    let scope = {};
    let file;
    try {
      // Lazy: don't load the zip machinery at browser startup.
      Cu.import("chrome://greasemonkey-modules/content/backup.js", scope);

      let dir = this.resolveFolder(aFolderPath);
      let stamp = new Date().toISOString()
          .replace(/[:.]/g, "-")
          .replace("T", "_")
          .slice(0, 19);
      file = dir.clone();
      file.append(AUTO_PREFIX + stamp + ".zip");

      scope.GM_BackupExport(file, /* includeValues */ true,
          function (aOk, aCount, aErr) {
        if (aOk && file.exists()) {
          GM_prefRoot.setValue("backup.auto.lastBackup", String(Date.now()));
          try {
            GM_backupScheduler._prune(file.parent);
          } catch (e) {
            // Pruning is best-effort.
          }
          aCallback(true, file.path, aErr || null);
        } else {
          aCallback(false, null, aErr || "export failed");
        }
      });
    } catch (e) {
      GM_util.logError("Backup scheduler: " + e, false);
      aCallback(false, null, "" + e);
    }
  },

  /** Keeps only the newest backup.auto.keep automatic backups. */
  "_prune": function (aDir) {
    let keep = parseInt(GM_prefRoot.getValue("backup.auto.keep", 5), 10);
    if (isNaN(keep) || (keep < 1)) {
      keep = KEEP_DEFAULT;
    }
    keep = Math.min(keep, KEEP_MAX);

    let names = [];
    let entries = aDir.directoryEntries;
    while (entries.hasMoreElements()) {
      let file = entries.getNext().QueryInterface(Ci.nsIFile);
      if (file.leafName.indexOf(AUTO_PREFIX) === 0
          && /\.zip$/.test(file.leafName)) {
        names.push(file.leafName);
      }
    }
    // Timestamped names sort lexically = chronologically.
    names.sort();
    while (names.length > keep) {
      let victim = aDir.clone();
      victim.append(names.shift());
      try {
        victim.remove(false);
      } catch (e) {
        // Best effort.
      }
    }
  },
};
