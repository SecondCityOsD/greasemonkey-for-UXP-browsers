/**
 * @file sourceViewer.js
 * @overview Read-only, syntax-highlighted viewer for user-script source.
 *
 * Loaded as a chrome XHTML document in a browser tab via
 *   chrome://greasemonkey/content/sourceViewer.xhtml?path=<encoded OS path>
 *
 * Opened from:
 *   - RemoteScript.showSource()  — the install-time "Show Script Source"
 *     preview (replaces the old raw file:// tab).
 *   - [Phase 2] the Add-ons Manager "View Source" command for an already
 *     installed user script.
 *
 * Engine
 * ------
 * Reuses the browser's *bundled* CodeMirror directly.  Both supported
 * targets ship it at the same chrome path (verified against the installed
 * binaries):
 *   - Pale Moon 34 — packed in browser/palemoon.res
 *   - Basilisk 52  — browser/omni.ja
 *     chrome://devtools/content/sourceeditor/codemirror/codemirror.bundle.js
 * That bundle defines a global `CodeMirror` with the JavaScript mode baked
 * in, so we load it with the script loader and call CodeMirror() ourselves.
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
 * or an installed script's on-disk file), never by web content.  No script
 * content is ever evaluated here — it is only read as text and displayed.
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

/** Candidate URLs for the CodeMirror core.  The first that defines a global
 *  `CodeMirror` wins.  The bundle (Pale Moon 34 / Basilisk 52) ships the JS
 *  mode inside it; the split `lib/codemirror.js` fallback needs the mode
 *  loaded separately (handled below). */
const CM_CORE_URLS = [
  "chrome://devtools/content/sourceeditor/codemirror/codemirror.bundle.js",
  "chrome://devtools/content/sourceeditor/codemirror/lib/codemirror.js",
];

/** JS-mode URL, only needed when the split (non-bundle) core was loaded. */
const CM_MODE_URLS = [
  "chrome://devtools/content/sourceeditor/codemirror/mode/javascript/javascript.js",
];

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

  applyViewerTheme(document.body);

  let path = readPathFromQuery();
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

  let pathLabel = document.getElementById("gm-sv-path");
  if (pathLabel) {
    pathLabel.textContent = path;
    document.getElementById("gm-sv-status").removeAttribute("hidden");
  }

  // Read the file as UTF-8, then render.  OS.File works in the chrome
  // document context this page runs in.
  OS.File.read(path, { "encoding": "UTF-8" }).then(
      function (text) {
        document.title = svString("sourceViewer.title", "User Script Source");
        renderSource(text);
      },
      function (e) {
        showNote(svString("sourceViewer.error.read",
            "Could not read the script source.") + " " + e);
      });
}

/**
 * Parses the `path` parameter out of the document's URL query string.
 * Prefers location.search, falling back to the full href.
 * @returns {string|null} The decoded OS path, or null when absent/invalid.
 */
function readPathFromQuery() {
  let haystack = "";
  try {
    haystack = window.location.search || window.location.href || "";
  } catch (e) {
    haystack = "";
  }
  let match = /[?&]path=([^&]*)/.exec(haystack);
  if (!match) {
    return null;
  }
  try {
    return decodeURIComponent(match[1]);
  } catch (e) {
    return null;
  }
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
 * Loads the CodeMirror core (and, for the split layout, the JS mode) into
 * the page's global scope via the script loader.
 * @returns {boolean} true when a global CodeMirror is available.
 */
function loadCodeMirror() {
  if (gCM) {
    return true;
  }
  for (let i = 0, iLen = CM_CORE_URLS.length; i < iLen; i++) {
    try {
      Services.scriptloader.loadSubScript(CM_CORE_URLS[i], window);
      if (window.CodeMirror) {
        gCM = window.CodeMirror;
        break;
      }
    } catch (e) {
      // Not at this URL on this build — try the next candidate.
    }
  }
  if (!gCM) {
    return false;
  }
  // The bundle already includes the JS mode; only the split core needs it.
  try {
    if (gCM.modes && !gCM.modes.javascript) {
      for (let j = 0, jLen = CM_MODE_URLS.length; j < jLen; j++) {
        try {
          Services.scriptloader.loadSubScript(CM_MODE_URLS[j], window);
        } catch (e) { /* mode not present at this URL — try the next */ }
      }
    }
  } catch (e) { /* modes table not exposed — leave as-is */ }
  return true;
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
 * Resolves a theme ("light"/"dark") and applies it as a class on the target.
 * "auto" follows the host prefers-color-scheme when the build supports it,
 * otherwise it defaults to light.
 * @param {Element} aTarget
 * @returns {void}
 */
function applyViewerTheme(aTarget) {
  if (!aTarget) {
    return;
  }
  let resolved = "light";
  try {
    let mql = window.matchMedia("(prefers-color-scheme: dark)");
    if (mql && mql.matches) {
      resolved = "dark";
    }
  } catch (e) {
    resolved = "light";
  }
  aTarget.classList.remove("theme-light");
  aTarget.classList.remove("theme-dark");
  aTarget.classList.add("theme-" + resolved);
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

/** Above this source size (chars), skip CodeMirror and use the textarea —
 *  CodeMirror's per-line DOM gets sluggish on huge / minified files. */
const SV_MAX_CM_BYTES = 1500000;

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

  // A visible "Find" button in the status strip is the reliable way to open
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
