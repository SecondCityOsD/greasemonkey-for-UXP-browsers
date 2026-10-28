/**
 * @file updateScheduler.js
 * @overview Greasemonkey-owned periodic script-update scheduler.
 *
 * The browser's Add-ons Manager runs its own daily background update sweep
 * for every add-on provider.  That cadence is browser-global
 * (extensions.update.interval) and can't be configured per provider, so this
 * module owns userscript update timing instead:
 *
 *   extensions.greasemonkey.update.intervalDays (default 1)
 *     How often scripts are checked, in days.  0 disables scheduled checks
 *     entirely — the master off-switch.
 *   extensions.greasemonkey.update.lastCheck
 *     Epoch-ms of the last completed sweep, stored as a string because the
 *     value exceeds the int32 pref range.
 *
 * The scheduler ticks hourly (first tick a few minutes after startup, so it
 * never competes with session restore) and runs a sweep once the interval
 * has elapsed, unless the browser-wide extensions.update.enabled switch is
 * off.  Sweeps drive the SAME check pipeline as the Add-ons Manager
 * (ScriptAddon.findUpdates → Script.checkForRemoteUpdate), so the
 * disabled-scripts / secure-scheme gates apply.  A found update is
 * installed only under the platform's own background-update rule
 * (PERM_CAN_UPGRADE + AddonManager.shouldAutoUpdate, i.e. the per-script
 * "Automatic Updates" radio), and never over local edits the user hasn't
 * agreed to lose.  Anything else stays listed in about:addons for the user.
 *
 * ScriptAddon.findUpdates suppresses the AOM's own periodic sweep so
 * scripts aren't checked on two cadences; scheduler-driven checks pass
 * through via the _gmScheduledCheck flag, which is only ever set around the
 * synchronous portion of the findUpdates call below.
 *
 * Lifecycle: started from the service's profile-after-change startup and
 * stopped from its quit-application shutdown (components/greasemonkey.js).
 */

const EXPORTED_SYMBOLS = ["GM_updateScheduler"];

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

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


const MS_PER_DAY = 24 * 60 * 60 * 1000;
const STARTUP_DELAY_MS = 3 * 60 * 1000;
const TICK_INTERVAL_MS = 60 * 60 * 1000;

var GM_updateScheduler = {
  "_startupTimer": null,
  "_tickTimer": null,

  /**
   * Arms the timers.  Idempotent — only the first call does anything, so
   * it's safe no matter how many times the service startup path runs.
   */
  "start": function () {
    if (this._tickTimer) {
      return undefined;
    }

    // Timers are kept on this (module-lifetime) object so they can't be
    // garbage-collected while armed.
    this._startupTimer = Cc["@mozilla.org/timer;1"]
        .createInstance(Ci.nsITimer);
    this._startupTimer.initWithCallback({
      "notify": GM_updateScheduler.tick.bind(GM_updateScheduler),
    }, STARTUP_DELAY_MS, Ci.nsITimer.TYPE_ONE_SHOT);

    this._tickTimer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
    this._tickTimer.initWithCallback({
      "notify": GM_updateScheduler.tick.bind(GM_updateScheduler),
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
   * Hourly heartbeat: runs a sweep when the configured interval has
   * elapsed since the last one.  intervalDays <= 0 (or junk) disables
   * scheduled checking entirely, and so does the browser-wide
   * extensions.update.enabled switch, as it does for the platform's own
   * background update check.  lastCheck isn't stamped while disabled, so
   * re-enabling catches up on the next tick.
   */
  "tick": function () {
    if (!AddonManager.updateEnabled) {
      return undefined;
    }

    let days = parseInt(GM_prefRoot.getValue("update.intervalDays", 1), 10);
    if (isNaN(days) || (days <= 0)) {
      return undefined;
    }

    let last = parseInt(GM_prefRoot.getValue("update.lastCheck", "0"), 10);
    if (isNaN(last) || (last < 0)) {
      last = 0;
    }
    let now = Date.now();
    if (last > now) {
      // System clock moved backwards past the recorded check; reset so
      // updates don't stall until the old "future" timestamp is reached.
      last = 0;
    }
    if ((now - last) < (days * MS_PER_DAY)) {
      return undefined;
    }

    this.checkNow();
  },

  /**
   * Stamps update.lastCheck and sweeps every installed script through the
   * standard update pipeline immediately.  Also called directly by the
   * "Check now" button in the options dialog.  That click is an explicit
   * request, so it isn't subject to extensions.update.enabled, but it
   * installs under exactly the same rule as a scheduled sweep.
   */
  "checkNow": function () {
    GM_prefRoot.setValue("update.lastCheck", String(Date.now()));

    // The platform's background updater installs only when
    // PERM_CAN_UPGRADE && AddonManager.shouldAutoUpdate(); mirror it.  An
    // update that doesn't qualify stays listed in about:addons, where the
    // user decides.  Local edits are checked too: ScriptInstall.install()
    // would ask before overwriting them, and a timer must never prompt.
    // findUpdates() has already switched Automatic Updates Off for any
    // edit made since the last page load, so this is belt and braces.
    let listener = {
      "onUpdateAvailable": function (aAddon, aInstall) {
        if ((aAddon.permissions & AddonManager.PERM_CAN_UPGRADE)
            && AddonManager.shouldAutoUpdate(aAddon)
            && !aAddon._script.hasUnacceptedLocalEdits()) {
          aInstall.install();
        }
      },
    };

    AddonManager.getAddonsByTypes(
        [GM_CONSTANTS.scriptAddonType],
        function (aAddons) {
          for (let i = 0, iLen = aAddons.length; i < iLen; i++) {
            let addon = aAddons[i];
            // No update URL / unsafe scheme — reading permissions also
            // refreshes the addon's isCompatible flag as a side effect.
            if (!(addon.permissions & AddonManager.PERM_CAN_UPGRADE)) {
              continue;
            }
            addon._gmScheduledCheck = true;
            try {
              addon.findUpdates(
                  listener, AddonManager.UPDATE_WHEN_PERIODIC_UPDATE);
            } finally {
              addon._gmScheduledCheck = false;
            }
          }
        });
  },
};
