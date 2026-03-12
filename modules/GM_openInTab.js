/**
 * @file GM_openInTab.js
 * @overview Implements the GM_openInTab() API for userscripts.
 *
 * Opens a URL in a new browser tab.  The URL is resolved relative to the
 * current content window's location before being sent to the parent process
 * via an async IPC message ("greasemonkey:open-in-tab").
 *
 * Supported option forms (mirrors the GM4 specification):
 *   GM_openInTab(url)                        — opens in background
 *   GM_openInTab(url, true)                  — opens in background (legacy bool)
 *   GM_openInTab(url, false)                 — opens in foreground (legacy bool)
 *   GM_openInTab(url, { active: true })      — opens in foreground
 *   GM_openInTab(url, { insert: true })      — inserts tab next to current
 */

const EXPORTED_SYMBOLS = ["GM_openInTab"];

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


/**
 * Opens aUrl in a new browser tab.
 *
 * @param {nsIMessageSender} aFrame   - The frame's message manager, used to
 *                                      send the open-in-tab IPC message.
 * @param {string}           aBaseUrl - Base URL of the current content window,
 *                                      used to resolve relative URLs.
 * @param {string}           aUrl     - The URL to open (may be relative).
 * @param {boolean|object|undefined} aOptions
 *   - If a boolean: treated as the legacy "loadInBackground" flag.
 *   - If an object: may contain:
 *       active  {boolean} — true to open in foreground (default: background).
 *       insert  {boolean} — true to insert the new tab adjacent to the current one.
 *   - If omitted/null: browser default behaviour applies.
 */
function GM_openInTab(aFrame, aBaseUrl, aUrl, aOptions) {
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

  aFrame.sendAsyncMessage("greasemonkey:open-in-tab", {
    "afterCurrent": insertRelatedAfterCurrent,
    "inBackground": loadInBackground,
    "url": uri.spec,
  });
};
