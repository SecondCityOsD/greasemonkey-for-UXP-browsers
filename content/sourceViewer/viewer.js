/**
 * @file sourceViewer/viewer.js
 * @overview Read-only, syntax-highlighted viewer for user-script source.
 *   Colours live in theme.js and the themed scrollbars in scrollbars.js,
 *   both loaded first.
 *
 * Loaded as a chrome XHTML document in a browser tab via
 *   chrome://greasemonkey/content/sourceViewer.xhtml?path=<encoded OS path>
 *       &url=<encoded address it was downloaded from>
 * The toolbar shows the script's name and version (from its metadata, or
 * the file name for a library) and that address; url is optional, and
 * without it the toolbar shows the path.
 *
 * Opened from:
 *   - RemoteScript.showSource()  — the install-time "Show Script Source"
 *     preview (replaces the old raw file:// tab).
 *   - the install window's @require / @resource lines (install.js
 *     viewDependencyFile), once that file has downloaded.
 *
 * Engine
 * ------
 * Reuses the browser's *bundled* CodeMirror (5.16) directly.  Both
 * supported targets ship it at the same chrome path (verified against the
 * installed binaries, 2026-10-29):
 *   - Pale Moon 35 — packed in browser/palemoon.res
 *   - Basilisk     — browser/omni.ja
 *     chrome://devtools/content/sourceeditor/codemirror/codemirror.bundle.js
 * Neither ships the split lib/codemirror.js layout.  The bundle defines a
 * global `CodeMirror` with the JavaScript mode baked in, so we load it with
 * the script loader and call CodeMirror() ourselves.
 * We deliberately do NOT use the DevTools `Editor` wrapper: it is a CommonJS
 * module (loadable only through the devtools `require()` loader) and drags in
 * toolbox dependencies that assume a DevTools host — neither of which we
 * want for a standalone read-only pane.
 *
 * Why this page is XHTML and not XUL
 * ----------------------------------
 * CodeMirror builds its DOM with document.createElement("div") etc.  In a
 * XUL document those calls create XUL elements, so CodeMirror can't render.
 * An XHTML document makes createElement() produce HTML elements (the same
 * reason the browser hosts its own CodeMirror inside an HTML cmiframe).
 *
 * Degradation
 * -----------
 * If the bundle can't be loaded (e.g. a build with DevTools stripped) or
 * CodeMirror fails to construct, we fall back to a plain read-only
 * <textarea>, so the viewer never renders worse than the raw file:// tab.
 *
 * Safety
 * ------
 * The path is always supplied by our own chrome code (a downloaded temp file
 * or an installed script's on-disk file), never by web content.  The url is
 * only ever displayed, as text.  No script content is ever evaluated here —
 * it is only read as text and displayed (the metadata parser reads the
 * ==UserScript== block as text too).
 */

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("chrome://greasemonkey-modules/content/constants.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

/** The browser's CodeMirror bundle, JavaScript mode included. */
const CM_BUNDLE_URL =
    "chrome://devtools/content/sourceeditor/codemirror/codemirror.bundle.js";

/** Above this source size (chars), skip CodeMirror and use the textarea —
 *  CodeMirror's per-line DOM gets sluggish on huge / minified files. */
const SV_MAX_CM_BYTES = 1500000;

/** Longest address shown in the toolbar; a data: URL can be huge. */
const SV_MAX_URL_CHARS = 200;

/** The resolved CodeMirror constructor (or null when it couldn't load). */
var gCM = null;

/** The live CodeMirror instance, kept so we can refresh() after layout. */
var gCMInstance = null;

/** Localised string bundle; lazily created in GM_sourceViewerLoad(). */
var gBundle = null;

window.addEventListener("load", GM_sourceViewerLoad, false);


/**
 * Window load entry point.  Reads the target path from the URL query, loads
 * the source text from disk, and renders it via CodeMirror (or the textarea
 * fallback).
 * @returns {void}
 */
function GM_sourceViewerLoad() {
  try {
    gBundle = GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties);
  } catch (e) {
    gBundle = null;
  }

  SvTheme.init(document.body, svString);

  let path = readQueryParam("path");
  if (!path) {
    showNote(svString("sourceViewer.error.noPath",
        "No script source to display."));
    return;
  }

  // Defense in depth: this privileged page reads whatever path it's handed,
  // so only ever read from the user-scripts directory or the OS temp area —
  // the two places our own chrome code legitimately points it at.  (The page
  // is not contentaccessible, so web content can't reach it; this guards
  // against a future caller passing an unexpected path.)
  if (!isAllowedPath(path)) {
    showNote(svString("sourceViewer.error.read",
        "Could not read the script source."));
    return;
  }

  // The address it came from, not the temp copy's path (which means nothing
  // to the reader and shows the Windows user name in screenshots).
  let url = readQueryParam("url");
  showSourceAddress(url || path);

  // Read the file as UTF-8, then render.  OS.File works in the chrome
  // document context this page runs in.
  OS.File.read(path, { "encoding": "UTF-8" }).then(
      function (text) {
        renderSource(text);
        showSourceName(text, url, path);
      },
      function (e) {
        showNote(svString("sourceViewer.error.read",
            "Could not read the script source.") + " " + e);
      });
}

/**
 * Reads one parameter out of the document's URL query string.
 * Prefers location.search, falling back to the full href.
 * @param {string} aName - "path" or "url".
 * @returns {string|null} The decoded value, or null when absent/invalid.
 */
function readQueryParam(aName) {
  let haystack = "";
  try {
    haystack = window.location.search || window.location.href || "";
  } catch (e) {
    haystack = "";
  }
  let match = new RegExp("[?&]" + aName + "=([^&]*)").exec(haystack);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Shows where the file came from in the toolbar, like the install window
 * does: the site in bold, the rest decoded, without the #fragment (where a
 * pinned hash lives).  Without an address, the on-disk path.
 * @param {string} aSource - The download address, or else the path.
 * @returns {void}
 */
function showSourceAddress(aSource) {
  let slot = document.getElementById("gm-sv-source");
  if (!slot) {
    return;
  }
  let text = aSource;
  let url = /^([a-z][a-z0-9+.-]*:\/\/)([^\/?#]*)([^#]*)/i.exec(aSource);
  if (url) {
    let rest = url[3];
    try {
      rest = decodeURI(rest);
    } catch (e) {
      // Not valid percent-encoding: show it as it is.
    }
    text = url[1] + url[2] + rest;
  }
  if (text.length > SV_MAX_URL_CHARS) {
    text = text.substring(0, SV_MAX_URL_CHARS) + "…";
  }
  slot.title = text;

  let hostEnd = url ? (url[1].length + url[2].length) : 0;
  if (!url || (hostEnd > text.length)) {
    slot.textContent = text;
    return;
  }
  let host = document.createElement("strong");
  host.textContent = url[2];
  slot.appendChild(document.createTextNode(url[1]));
  slot.appendChild(host);
  slot.appendChild(document.createTextNode(text.substring(hostEnd)));
}

/**
 * Names the file in the toolbar and the tab: the script's own (localised)
 * @name and its @version when it has a metadata block, else the file name
 * (a @require'd library, say).  Uses the real metadata parser, so the name
 * is the one Greasemonkey shows everywhere else.
 * @param {string} aText - The file's contents.
 * @param {string|null} aUrl - The address it was downloaded from.
 * @param {string} aPath - The on-disk path.
 * @returns {void}
 */
function showSourceName(aText, aUrl, aPath) {
  let name = "";
  let version = "";
  try {
    let scope = {};
    Cu.import("chrome://greasemonkey-modules/content/parseScript.js", scope);
    let script = scope.parse(
        aText, aUrl ? GM_util.getUriFromUrl(aUrl) : null,
        /* aFailWhenMissing */ true);
    if (script) {
      name = script.localized.name;
      version = script.version || "";
    }
  } catch (e) {
    // Metadata the parser can't read: name it after the file instead.
  }
  if (!name) {
    name = leafName(aUrl || aPath);
  }

  let nameSlot = document.getElementById("gm-sv-name");
  let versionSlot = document.getElementById("gm-sv-version");
  if (nameSlot) {
    nameSlot.textContent = name;
    nameSlot.title = name;
  }
  if (versionSlot) {
    versionSlot.textContent = version;
  }

  let label = version ? (name + " " + version) : name;
  // A function replacement, so a "$&" in a script's name stays as it is.
  document.title = label
      ? svString("sourceViewer.title.named", "%1 — Source")
          .replace("%1", function () { return label; })
      : svString("sourceViewer.title", "User Script Source");
}

/**
 * @param {string} aSource - An address or an OS path.
 * @returns {string} Its last part, decoded; "" for a data: URL or a
 *          trailing slash.
 */
function leafName(aSource) {
  if (/^data:/i.test(aSource)) {
    return "";
  }
  // Only an address has a query, a fragment and percent-encoding; a path's
  // "#" or "%" is part of the file name.
  let isUrl = (aSource.indexOf("://") != -1);
  let leaf = (isUrl ? aSource.replace(/[?#].*$/, "") : aSource)
      .split(/[\\\/]/).pop() || "";
  if (isUrl) {
    try {
      leaf = decodeURIComponent(leaf);
    } catch (e) {
      // Not valid percent-encoding: keep it as it is.
    }
  }
  return leaf;
}

/**
 * Renders the given source text: CodeMirror first, plain read-only textarea
 * as a fallback.
 * @param {string} aText - The script source.
 * @returns {void}
 */
function renderSource(aText) {
  let host = document.getElementById("gm-sv-host");
  if (!host) {
    return;
  }

  // CodeMirror builds per-line DOM; on very large files (often a single giant
  // minified line) that gets sluggish.  Above the threshold, use the plain
  // read-only textarea — native, fast, and the browser's own Ctrl+F still
  // searches the whole text there.
  if (aText.length > SV_MAX_CM_BYTES) {
    mountTextareaFallback(aText, /*highlighterMissing=*/ false);
    showNote(svString("sourceViewer.note.large",
        "Large file — shown as plain text for performance."));
    return;
  }

  if (loadCodeMirror()) {
    try {
      gCMInstance = gCM(host, {
        "value": aText,
        "mode": "javascript",
        "readOnly": true,
        "lineNumbers": true,
        "lineWrapping": false,
        // Drawn in the theme's colours (scrollbars.js); native ones stay
        // light in the dark palette.
        "scrollbarStyle": SV_SCROLLBAR_STYLE,
        "tabSize": 2,
      });
      // CodeMirror occasionally lays out at zero height when constructed
      // before the tab is fully visible; a refresh on the next tick fixes it.
      window.setTimeout(function () {
        try {
          if (gCMInstance) {
            gCMInstance.refresh();
          }
        } catch (e) { /* non-fatal */ }
      }, 0);
      setupFind();
      return;
    } catch (e) {
      // Construction failed — fall through to the textarea.
      gCMInstance = null;
    }
  }

  mountTextareaFallback(aText, /*highlighterMissing=*/ gCM === null);
}

/**
 * Loads the CodeMirror bundle into the page's global scope via the script
 * loader, and registers the themed scrollbar model with it.
 * @returns {boolean} true when a global CodeMirror is available.
 */
function loadCodeMirror() {
  if (!gCM) {
    try {
      Services.scriptloader.loadSubScript(CM_BUNDLE_URL, window);
      gCM = window.CodeMirror || null;
      if (gCM) {
        gCM.scrollbarModel[SV_SCROLLBAR_STYLE] = SvScrollbars;
      }
    } catch (e) {
      // A build without DevTools: the textarea fallback takes over.
    }
  }
  return gCM !== null;
}

/**
 * Renders the source in a plain read-only <textarea>.  Used whenever
 * CodeMirror is unavailable or fails to construct, so the viewer always
 * shows the source rather than an empty pane.
 * @param {string} aText
 * @param {boolean} aHighlighterMissing - When true, surface a short note
 *        explaining why there's no syntax highlighting.
 * @returns {void}
 */
function mountTextareaFallback(aText, aHighlighterMissing) {
  let host = document.getElementById("gm-sv-host");
  if (!host) {
    return;
  }
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }

  let ta = document.createElement("textarea");
  ta.id = "gm-sv-textarea";
  ta.readOnly = true;
  ta.setAttribute("wrap", "off");
  ta.spellcheck = false;
  ta.value = aText;
  host.appendChild(ta);

  if (aHighlighterMissing) {
    showNote(svString("sourceViewer.note.plainText",
        "Plain text — syntax highlighter unavailable on this build."));
  }
}

/**
 * Shows a short message in the status strip's note slot (and reveals the
 * strip if it was hidden).
 * @param {string} aMessage
 * @returns {void}
 */
function showNote(aMessage) {
  let note = document.getElementById("gm-sv-note");
  let strip = document.getElementById("gm-sv-status");
  if (note) {
    note.textContent = aMessage;
  }
  if (strip) {
    strip.removeAttribute("hidden");
  }
}

/**
 * Looks up a localised string, returning an English fallback when the key
 * isn't present in the bundle (so this feature ships without touching the
 * 34 locale files; keys can be added later).
 * @param {string} aKey
 * @param {string} aFallback
 * @returns {string}
 */
function svString(aKey, aFallback) {
  if (!gBundle) {
    return aFallback;
  }
  try {
    return gBundle.GetStringFromName(aKey);
  } catch (e) {
    return aFallback;
  }
}

/**
 * True iff aPath is inside the user-scripts directory or the OS temp area —
 * the only places our chrome code legitimately points the viewer (an
 * installed script's file, or a freshly-downloaded temp file).  Compared as
 * path prefixes with the platform separator so "/foo" can't match "/foobar".
 * @param {string} aPath
 * @returns {boolean}
 */
function isAllowedPath(aPath) {
  let sep = "/";
  try {
    if (GM_util.getEnvironment().osWindows) {
      sep = "\\";
    }
  } catch (e) { /* default to "/" */ }

  let roots = [];
  try { roots.push(GM_util.scriptDir().path); } catch (e) { /* ignore */ }
  try {
    roots.push(Services.dirsvc.get("TmpD", Ci.nsIFile).path);
  } catch (e) { /* ignore */ }

  for (let i = 0, iLen = roots.length; i < iLen; i++) {
    let root = roots[i];
    if (root && (aPath === root || aPath.lastIndexOf(root + sep, 0) === 0)) {
      return true;
    }
  }
  return false;
}

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //
// ─── Find ────────────────────────────────────────────────────────────────
// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //
//
// A small find bar for the CodeMirror surface.  CodeMirror virtualises its
// DOM (only the visible lines exist), so the browser's native Ctrl+F can't
// see off-screen matches; we search the full document model ourselves and
// drive the selection.  The textarea fallback keeps native find (all of its
// text is in the DOM), so this bar is only wired when CodeMirror is active.

var gFindMatches = [];
var gFindIdx = -1;

function setupFind() {
  let input = document.getElementById("gm-sv-find-input");
  if (!input) {
    return;
  }
  input.setAttribute("placeholder",
      svString("sourceViewer.find.placeholder", "Find"));

  // A visible "Find" button in the toolbar is the reliable way to open
  // the bar: in a chrome page hosted in a tab, Ctrl+F may be claimed by the
  // browser's own (CodeMirror-blind) findbar, so we don't depend on it.
  let openBtn = document.getElementById("gm-sv-find-open");
  if (openBtn) {
    openBtn.textContent = svString("sourceViewer.find.open", "Find");
    openBtn.removeAttribute("hidden");
    openBtn.addEventListener("click", showFind, false);
  }

  input.addEventListener("input", function () {
    recomputeFind(input.value);
    gotoMatch(1);
  }, false);
  input.addEventListener("keydown", function (aEvent) {
    if (aEvent.keyCode == 13) {          // Enter
      aEvent.preventDefault();
      gotoMatch(aEvent.shiftKey ? -1 : 1);
    } else if (aEvent.keyCode == 27) {   // Escape
      aEvent.preventDefault();
      hideFind();
    }
  }, false);

  bindFindClick("gm-sv-find-next", function () { gotoMatch(1); });
  bindFindClick("gm-sv-find-prev", function () { gotoMatch(-1); });
  bindFindClick("gm-sv-find-close", hideFind);

  // Ctrl+F / Cmd+F opens the bar (only meaningful with CodeMirror active).
  window.addEventListener("keydown", function (aEvent) {
    if ((aEvent.ctrlKey || aEvent.metaKey) && !aEvent.altKey
        && (aEvent.keyCode == 70 /* F */)) {
      if (gCMInstance) {
        aEvent.preventDefault();
        aEvent.stopPropagation();
        showFind();
      }
    }
  }, true);
}

function bindFindClick(aId, aFn) {
  let el = document.getElementById(aId);
  if (el) {
    el.addEventListener("click", aFn, false);
  }
}

function recomputeFind(aQuery) {
  gFindMatches = [];
  gFindIdx = -1;
  if (aQuery && gCMInstance) {
    let text = gCMInstance.getValue();
    // A /pattern/flags query is treated as a regular expression; anything
    // else is a plain case-insensitive substring search.  Each match is
    // stored as {index, length} so variable-length regex matches select
    // correctly.
    let re = parseRegexQuery(aQuery);
    if (re) {
      let m;
      while ((m = re.exec(text)) !== null) {
        gFindMatches.push({ "index": m.index, "length": m[0].length });
        // Guard against an infinite loop on a zero-width match.
        if (m.index === re.lastIndex) {
          re.lastIndex++;
        }
      }
    } else {
      let hay = text.toLowerCase();
      let needle = aQuery.toLowerCase();
      let from = 0;
      let at;
      while ((at = hay.indexOf(needle, from)) !== -1) {
        gFindMatches.push({ "index": at, "length": needle.length });
        from = at + (needle.length || 1);
      }
    }
  }
  updateFindCount();
}

/**
 * Parses a /pattern/flags find query into a global RegExp, or returns null
 * when the query is not in /.../ form (so it's a plain substring search) or
 * the pattern doesn't compile.
 *
 * @param {string} aQuery
 * @returns {RegExp|null}
 */
function parseRegexQuery(aQuery) {
  let m = (/^\/(.+)\/([gimsuy]*)$/).exec(aQuery);
  if (!m) {
    return null;
  }
  let flags = m[2];
  if (flags.indexOf("g") === -1) {
    flags += "g";
  }
  try {
    return new RegExp(m[1], flags);
  } catch (e) {
    return null;
  }
}

function gotoMatch(aDir) {
  if (!gCMInstance || !gFindMatches.length) {
    updateFindCount();
    return;
  }
  let len = gFindMatches.length;
  gFindIdx = ((gFindIdx + aDir) % len + len) % len;
  let match = gFindMatches[gFindIdx];
  let from = gCMInstance.posFromIndex(match.index);
  let to = gCMInstance.posFromIndex(match.index + match.length);
  gCMInstance.setSelection(from, to);
  gCMInstance.scrollIntoView({ "from": from, "to": to }, 40);
  updateFindCount();
}

function updateFindCount() {
  let countEl = document.getElementById("gm-sv-find-count");
  if (!countEl) {
    return;
  }
  let input = document.getElementById("gm-sv-find-input");
  if (!input || !input.value) {
    countEl.textContent = "";
  } else if (!gFindMatches.length) {
    countEl.textContent = "0/0";
  } else {
    countEl.textContent = (gFindIdx + 1) + "/" + gFindMatches.length;
  }
}

function showFind() {
  let bar = document.getElementById("gm-sv-find");
  let input = document.getElementById("gm-sv-find-input");
  if (bar) {
    bar.removeAttribute("hidden");
  }
  if (input) {
    input.focus();
    input.select();
  }
}

function hideFind() {
  let bar = document.getElementById("gm-sv-find");
  if (bar) {
    bar.setAttribute("hidden", "hidden");
  }
  if (gCMInstance) {
    gCMInstance.focus();
  }
}
