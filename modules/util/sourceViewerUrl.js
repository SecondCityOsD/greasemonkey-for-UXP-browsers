/**
 * @file sourceViewerUrl.js
 * @overview The source viewer's address for a file.  The file, the
 *   address it was downloaded from and its icon are kept here under a
 *   short id, and the viewer looks them up: the tab's address bar shows
 *   chrome://greasemonkey/content/sourceViewer.xhtml?id=k3x9q2ab instead
 *   of the file's full path, with the Windows user name in it.
 */

const EXPORTED_SYMBOLS = ["sourceViewerEntry", "sourceViewerUrl"];

const SOURCE_VIEWER_URL = "chrome://greasemonkey/content/sourceViewer.xhtml";

/** Files kept for the viewer; past this the oldest go.  A tab of one of
 *  those, reloaded, says there is nothing to show. */
const MAX_ENTRIES = 100;

/** id -> {"path", "url", "icon"}, oldest first. */
var gEntries = new Map();

/**
 * @param {nsIFile} aFile - The file to show.
 * @param {string} [aUrl] - The address it was downloaded from, shown in
 *     the viewer's toolbar.
 * @param {string} [aIconUrl] - A file: URL of the script's downloaded
 *     @icon, shown beside its name.
 * @returns {string} The viewer's address for it.
 */
function sourceViewerUrl(aFile, aUrl, aIconUrl) {
  let id;
  do {
    id = Math.random().toString(36).slice(2, 10);
  } while ((id.length < 8) || gEntries.has(id));
  gEntries.set(id, {
    "icon": aIconUrl || null,
    "path": aFile.path,
    "url": aUrl || null,
  });
  if (gEntries.size > MAX_ENTRIES) {
    gEntries.delete(gEntries.keys().next().value);
  }

  return SOURCE_VIEWER_URL + "?id=" + id;
}

/**
 * @param {string} aId - The id in the viewer's address.
 * @returns {object|null} {"path", "url", "icon"}, or null when unknown
 *     (a tab restored after a restart, say).
 */
function sourceViewerEntry(aId) {
  return (aId && gEntries.get(aId)) || null;
}
