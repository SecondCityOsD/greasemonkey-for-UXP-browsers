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
 * Pale Moon 27.5.x compat note:
 *   PopupNotifications.show() gained "learnMoreURL" support in 27.6+
 *   (Moonchild PR #1355).  On older builds the Learn More button is added
 *   as a secondary action instead.
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
 * The popup always has an "OK" button and a "Never show again" secondary action.
 * A "Learn More" secondary action is added when aOptions.learnMoreURL is set,
 * but only on Pale Moon 27.5 and earlier (where PopupNotifications does not
 * support a native learnMoreURL option).
 *
 * Returns without showing anything if the notification topic has been muted.
 *
 * @param {string}      aMessage - The text to display in the popup.
 * @param {string}      aTopic   - Notification topic; determines muting logic
 *                                 and the popup anchor id.
 * @param {object|null} aOptions - Optional extra options:
 *   learnMoreURL {string} — URL to open in a new tab from the secondary action.
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

  let supportLearnMoreURL = true;
  // Pale Moon 27.5.x-
  // https://github.com/MoonchildProductions/Pale-Moon/pull/1355
  if (((Services.appinfo.ID == GM_CONSTANTS.browserIDPalemoon)
      && (GM_util.compareVersion("27.6.0a1", "20170919000000") < 0))) {
    supportLearnMoreURL = false;
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
  if (aOptions && aOptions.learnMoreURL && !supportLearnMoreURL) {
    secondaryActions.push({
      "accessKey": GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("notification.learnMore.accesskey"),
      "callback": function () {
        chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(
            aOptions.learnMoreURL, {
              "ownerTab": chromeWin.gBrowser.selectedTab,
            });
        /*
        switch (type) {
          case "grants":
            muteGrants();
            break;
          default:
            mute(aTopic);
            break;
        }
        */
      },
      "label": GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("notification.learnMore.label"),
    });      
  }
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
