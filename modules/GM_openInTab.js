/**
 * @file GM_openInTab.js
 * @overview Implements the GM_openInTab() API for userscripts.
 *
 * Opens a URL in a new browser tab.  The URL is resolved relative to the
 * script's content window, then GM_BrowserUI.openInTab on the chrome
 * window that owns that content window is invoked directly.
 *
 * Historical note:
 *   Pre-cleanup, this module sent two IPC messages
 *   ("greasemonkey:open-in-tab" and "greasemonkey:tab-close") via the
 *   sandbox's frame message manager, which content/browser.js consumed
 *   through window.messageManager.addMessageListener.  UXP is single-
 *   process; both legs were self-loops with no benefit.  We now find
 *   the chrome window via getChromeWinForContentWin() and call
 *   GM_BrowserUI.openInTab / .tabClose directly.
 *
 * Supported option forms (mirrors the GM4 specification):
 *   GM_openInTab(url)                        — opens in background
 *   GM_openInTab(url, true)                  — opens in background (legacy bool)
 *   GM_openInTab(url, false)                 — opens in foreground (legacy bool)
 *   GM_openInTab(url, { active: true })      — opens in foreground
 *   GM_openInTab(url, { insert: true })      — inserts tab next to current
 */

const EXPORTED_SYMBOLS = ["GM_openInTab", "GM_tabClosed"];

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

Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");


// Tab tracking for .close() and .onclose support.
var gTabIdCounter = 0;
var gOpenTabs = {};

/**
 * Opens aUrl in a new browser tab and returns a tab-like object.
 *
 * @param {nsIDOMWindow} aContentWin - The script's content window; used to
 *                                     locate the owning chrome window and
 *                                     to resolve aUrl against the page URL.
 * @param {string}       aBaseUrl    - Base URL captured at sandbox creation;
 *                                     used to resolve relative aUrls.
 * @param {string}       aUrl        - The URL to open (may be relative).
 * @param {boolean|object|undefined} aOptions
 *   - If a boolean: treated as the legacy "loadInBackground" flag.
 *   - If an object: may contain:
 *       active  {boolean} — true to open in foreground (default: background).
 *       insert  {boolean} — true to insert the new tab adjacent to the current one.
 *       setParent {boolean} — true to inherit parent tab association.
 *   - If omitted/null: browser default behaviour applies.
 * @returns {object|null} Tab handle, or null when the chrome window can't
 *   be resolved.  Tab handle members:
 *   - closed  {boolean}  — true after the tab is closed.
 *   - onclose {function} — called when the tab is closed.
 *   - close() {function} — closes the tab programmatically.
 */
function GM_openInTab(aContentWin, aBaseUrl, aUrl, aOptions) {
  let loadInBackground = null;
  if ((typeof aOptions != "undefined") && (aOptions != null)) {
    if (typeof aOptions.active == "undefined") {
      if (typeof aOptions != "object") {
        loadInBackground = !!aOptions;
      }
    } else {
      loadInBackground = !aOptions.active;
    }
  }

  let insertRelatedAfterCurrent = null;
  if ((typeof aOptions != "undefined") && (aOptions != null)) {
    if (typeof aOptions.insert != "undefined") {
      insertRelatedAfterCurrent = !!aOptions.insert;
    }
  }

  // Resolve URL relative to the location of the content window.
  let baseUri = GM_CONSTANTS.ioService.newURI(aBaseUrl, null, null);
  let uri = GM_CONSTANTS.ioService.newURI(aUrl, null, baseUri);

  let tabId = ++gTabIdCounter;

  // Find the chrome window that hosts this content window.
  let chromeWin = getChromeWinForContentWin(aContentWin);
  if (!chromeWin || !chromeWin.GM_BrowserUI
      || (typeof chromeWin.GM_BrowserUI.openInTab != "function")) {
    return null;
  }

  // Build the synthetic { target, data } argument shape that
  // GM_BrowserUI.openInTab / .tabClose still accept.  Pre-cleanup that
  // shape was the IPC message envelope; on UXP single-process we just
  // pass the same structure to the same method directly.
  let scriptBrowser;
  try {
    scriptBrowser = aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIDocShell)
        .chromeEventHandler;
  } catch (e) {
    scriptBrowser = chromeWin.gBrowser
        ? chromeWin.gBrowser.selectedBrowser
        : null;
  }

  // Create the tab handle returned to the script.
  let tabHandle = {
    "closed": false,
    "onclose": null,
    "close": function () {
      try {
        chromeWin.GM_BrowserUI.tabClose({
          "target": scriptBrowser || chromeWin.gBrowser.selectedBrowser,
          "data": { "tabId": tabId },
        });
      } catch (e) {
        // Window may have closed; ignore.
      }
    },
  };
  gOpenTabs[tabId] = tabHandle;

  chromeWin.GM_BrowserUI.openInTab({
    "target": scriptBrowser || chromeWin.gBrowser.selectedBrowser,
    "data": {
      "afterCurrent": insertRelatedAfterCurrent,
      "inBackground": loadInBackground,
      "tabId": tabId,
      "url": uri.spec,
    },
  });

  return tabHandle;
};

/**
 * Called when a tab opened by GM_openInTab is closed.
 * Sets the handle's closed flag and fires onclose callback.
 *
 * @param {number} aTabId - The tab ID assigned when it was opened.
 */
function GM_tabClosed(aTabId) {
  let handle = gOpenTabs[aTabId];
  if (handle) {
    handle.closed = true;
    delete gOpenTabs[aTabId];
    if (typeof handle.onclose == "function") {
      try {
        handle.onclose();
      } catch (e) {
        // Ignore callback errors.
      }
    }
  }
};
