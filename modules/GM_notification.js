/**
 * @file GM_notification.js
 * @overview Internal (privileged) notification system used by Greasemonkey
 *   itself to display UI warnings to the user via PopupNotifications.
 *
 * This is NOT the GM_notification() API exposed to userscripts — that is
 * implemented in modules/notificationer.js.  This module handles Greasemonkey's
 * own informational popups, such as the @grant warning shown when a script
 * requests sensitive APIs.
 *
 * Notification types currently supported:
 *   "greasemonkey-grants-warning" — warns that a script requests broad grants.
 *     Can be permanently muted via the "showGrantsWarning" preference.
 *
 * All other topics support per-topic muting via:
 *   "notification.muted.<topic>" preference (boolean).
 *
 * Historical note:
 *   Pre-cleanup, this module fabricated a "Learn More" secondary action
 *   manually for Pale Moon ≤27.5, where PopupNotifications.show() did
 *   not yet understand the "learnMoreURL" option natively (added in
 *   Pale Moon 27.6, see Moonchild PR #1355 — September 2017).  The
 *   minimum supported target is now Pale Moon 28+ / Basilisk current,
 *   both of which honour learnMoreURL natively, so the fallback was
 *   removed.  Basilisk is unaffected either way: it inherits PopupNoti-
 *   fications from Firefox 52 ESR which has had learnMoreURL since Fx41.
 */

const EXPORTED_SYMBOLS = ["GM_notification"];

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

Cu.import("resource://gre/modules/PopupNotifications.jsm");

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Permanently suppresses the @grant warning notification.
 * Sets the "showGrantsWarning" preference to false.
 */
function muteGrants() {
  GM_prefRoot.setValue("showGrantsWarning", false);
}

/**
 * Permanently suppresses a notification by topic.
 * Sets the "notification.muted.<aTopic>" preference to true.
 *
 * @param {string} aTopic - The notification topic string to mute.
 */
function mute(aTopic) {
  GM_prefRoot.setValue("notification.muted." + aTopic, true);
}

/**
 * Displays a Greasemonkey internal notification popup using PopupNotifications.
 *
 * The popup always has an "OK" button and a "Never show again" secondary
 * action.  When aOptions.learnMoreURL is set, the platform's
 * PopupNotifications.show() renders a native "Learn More" link inline
 * (supported on Pale Moon 27.6+ and on Basilisk).
 *
 * Returns without showing anything if the notification topic has been muted.
 *
 * @param {string}      aMessage - The text to display in the popup.
 * @param {string}      aTopic   - Notification topic; determines muting logic
 *                                 and the popup anchor id.
 * @param {object|null} aOptions - Optional extra options:
 *   learnMoreURL {string} — URL surfaced by the platform popup.
 */
function GM_notification(aMessage, aTopic, aOptions) {
  let type = null;
  switch (aTopic) {
    case "greasemonkey-grants-warning":
      type = "grants";
      break;
  }

  let muted = false;
  switch (type) {
    case "grants":
      muted = GM_prefRoot.getValue("showGrantsWarning");
      if (!muted) {
        return undefined;
      }
      break;
    default:
      muted = GM_prefRoot.getValue("notification.muted." + aTopic, false);
      if (muted) {
        return undefined;
      }
      break;
  }

  let chromeWin = GM_util.getBrowserWindow();
  let mainAction = {
    "accessKey": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties)
        .GetStringFromName("notification.ok.accesskey"),
    "callback": function () {},
    "label": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties)
        .GetStringFromName("notification.ok.label"),
  };
  let secondaryActions = [];
  secondaryActions.push({
    "accessKey": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties)
        .GetStringFromName("notification.neverAgain.accesskey"),
    "callback": function () {
      switch (type) {
        case "grants":
          muteGrants();
          break;
        default:
          mute(aTopic);
          break;
      }
    },
    "label": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties)
        .GetStringFromName("notification.neverAgain.label"),
  });

  let id = "greasemonkey-notification";
  switch (type) {
    case "grants":
      id = id + "-" + type;
      break;
  }

  if (chromeWin) {
    chromeWin.PopupNotifications.show(
        chromeWin.gBrowser.selectedBrowser, id,
        aMessage, null, mainAction, secondaryActions,
        aOptions ? aOptions : null);
  } else {
    switch (type) {
      case "grants":
        // Ignore, this is probably a startup issue like #2294.
        break;
      default:
        GM_util.logError(
            "(internal) GM_notification():"
            + "\n" + aMessage + "\n" + "chromeWin = " + chromeWin);
        break;
    }
  }
};
