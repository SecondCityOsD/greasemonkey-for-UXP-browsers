/**
 * @file sourceViewerTabs.js
 * @overview Opens the source viewer in a browser tab, and tells the viewer
 *   what to show.
 *
 * The viewer used to get its file in its own address
 * (sourceViewer.xhtml?path=<OS path>), which put the Windows user name in
 * the address bar, and so in screenshots.  Now every caller hands the
 * file, the address it came from and its icon to GM_openSourceViewer(),
 * which keeps them here under a random id and opens
 * sourceViewer.xhtml?id=<id>; the viewer asks GM_sourceViewerTarget(id).
 *
 * The ids last as long as the browser runs, so reloading a viewer tab or
 * reopening a closed one still works (a few strings each).  After a
 * restart, a restored viewer tab says to open the source again.
 *
 * Callers: RemoteScript.showSource (the install window's "Show Script
 * Source" and the page context menu's "View User Script Source"), the
 * install window's @require / @resource lines, and about:addons' "View
 * Source".
 */

const EXPORTED_SYMBOLS = ["GM_openSourceViewer", "GM_sourceViewerTarget"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}

const VIEWER_URL = "chrome://greasemonkey/content/sourceViewer.xhtml";

/** id -> {icon, path, url}, for this browser session. */
var gTargets = new Map();

/**
 * Opens a file in the source viewer, in a new tab that is selected.
 * @param {tabbrowser} aTabBrowser - The browser window's gBrowser.
 * @param {object} aTarget
 * @param {string} aTarget.path - The file to show (an OS path; the viewer
 *        only reads one inside the user-scripts folder or the temp area).
 * @param {string} [aTarget.url] - Where it was downloaded from.
 * @param {string} [aTarget.icon] - A file: URL of the script's @icon.
 * @returns {tab} The new tab.
 */
function GM_openSourceViewer(aTabBrowser, aTarget) {
  let id = Cc["@mozilla.org/uuid-generator;1"]
      .getService(Ci.nsIUUIDGenerator).generateUUID().toString()
      .replace(/[{}]/g, "");
  gTargets.set(id, {
    "icon": aTarget.icon || null,
    "path": aTarget.path,
    "url": aTarget.url || null,
  });
  let tab = aTabBrowser.addTab(VIEWER_URL + "?id=" + id);
  aTabBrowser.selectedTab = tab;
  return tab;
}

/**
 * @param {string} aId - From the viewer's ?id=.
 * @returns {{icon: string|null, path: string, url: string|null}|null} A
 *          copy of what was opened under aId; null for an id this session
 *          doesn't know (a tab restored after a restart).
 */
function GM_sourceViewerTarget(aId) {
  let target = gTargets.get(aId);
  return target ? Object.assign({}, target) : null;
}
