/**
 * @file sourceViewer/viewer.js
 * @overview Read-only, syntax-highlighted viewer for user-script source.
 *   Colours live in theme.js, the themed scrollbars in scrollbars.js, the
 *   metadata header in meta.js, find / go to line in find.js, and folding,
 *   wrap and text size in view.js, all loaded first.  This file loads the
 *   file, CodeMirror, the toolbar and the status bar.
 *
 * Loaded as a chrome XHTML document in a browser tab, opened through
 * GM_openSourceViewer() (modules/sourceViewerTabs.js) as
 *   chrome://greasemonkey/content/sourceViewer.xhtml?id=<id>
 * where the id stands for the file's path, the address it came from and
 * its icon, so the path (and the Windows user name in it) stays out of the
 * address bar.  The older ?path=&url=&icon= form still works, for viewer
 * tabs restored from an earlier version.
 * The toolbar shows the script's icon, name and version (from its
 * metadata, or the file name for a library) and that address; without an
 * address it shows the path.
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

if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("chrome://greasemonkey-modules/content/constants.js");
Cu.import("chrome://greasemonkey-modules/content/sourceViewerTabs.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

/** The browser's CodeMirror bundle, JavaScript mode included. */
const CM_BUNDLE_URL =
    "chrome://devtools/content/sourceeditor/codemirror/codemirror.bundle.js";

/** Above this source size (chars), skip CodeMirror and use the textarea —
 *  CodeMirror's per-line DOM gets sluggish on huge / minified files. */
const SV_MAX_CM_BYTES = 1500000;

/** Longest address shown in the toolbar; a data: URL can be huge. */
const SV_MAX_URL_CHARS = 200;

/** A line this long makes the status bar call the file minified. */
const SV_MINIFIED_LINE = 1000;

/** The resolved CodeMirror constructor (or null when it couldn't load). */
var gCM = null;

/** The live CodeMirror instance, kept so we can refresh() after layout. */
var gCMInstance = null;

/** Localised string bundles, created in GM_sourceViewerLoad(): the
 *  viewer's own strings (greasemonkey.properties), then the install
 *  window's (gmBrowser.properties), whose labels the metadata header
 *  reuses. */
var gBundles = [];

window.addEventListener("load", GM_sourceViewerLoad, false);


/**
 * Window load entry point.  Reads the target path from the URL query, loads
 * the source text from disk, and renders it via CodeMirror (or the textarea
 * fallback).
 * @returns {void}
 */
function GM_sourceViewerLoad() {
  gBundles = [];
  [GM_CONSTANTS.localeGreasemonkeyProperties,
      GM_CONSTANTS.localeGmBrowserProperties].forEach(function (aUrl) {
    try {
      gBundles.push(GM_CONSTANTS.localeStringBundle.createBundle(aUrl));
    } catch (e) {
      // Fallback strings cover it.
    }
  });

  SvTheme.init(document.body, svString);

  let target = readTarget();
  if (!target) {
    showNote(readQueryParam("id")
        ? svString("sourceViewer.error.expired",
            "This view is from an earlier session.  Open the source again.")
        : svString("sourceViewer.error.noPath",
            "No script source to display."));
    return;
  }
  let path = target.path;

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
  let url = target.url;
  showSourceAddress(url || path);

  // Read the raw bytes (the status bar shows the size and any byte-order
  // mark), decode them as UTF-8 (TextDecoder drops the mark), then render.
  // OS.File works in the chrome document context this page runs in.
  OS.File.read(path).then(
      function (bytes) {
        let text = new TextDecoder("utf-8").decode(bytes);
        renderSource(text);
        showStatus(text, bytes);
        let script = parseSource(text, url);
        showSourceName(script, url, path);
        showSourceIcon(target.icon, script);
        SvMeta.init({
          "jumpTo": jumpToLine,
          "relayout": function () {
            if (gCMInstance) {
              gCMInstance.refresh();
            }
          },
          "script": script,
          "string": svString,
          "text": text,
          "url": url,
        });
      },
      function (e) {
        showNote(svString("sourceViewer.error.read",
            "Could not read the script source.") + " " + e);
      });
}

/**
 * What to show: the file, the address it came from and its icon, from
 * the ?id= that GM_openSourceViewer() opened this page with (or from the
 * older ?path=&url=&icon= form).
 * @returns {{icon: string|null, path: string, url: string|null}|null}
 *          null without either, or for an id this session doesn't know.
 */
function readTarget() {
  let id = readQueryParam("id");
  if (id) {
    return GM_sourceViewerTarget(id);
  }
  let path = readQueryParam("path");
  return path ? {
    "icon": readQueryParam("icon"),
    "path": path,
    "url": readQueryParam("url"),
  } : null;
}

/**
 * Reads one parameter out of the document's URL query string.
 * Prefers location.search, falling back to the full href.
 * @param {string} aName - "id", or the older "path", "url" and "icon".
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
 * Reads the file's metadata with the real parser, so names and warnings
 * are the ones Greasemonkey shows everywhere else.
 * @param {string} aText - The file's contents.
 * @param {string|null} aUrl - The address it was downloaded from.
 * @returns {Script|null} null without a metadata block (a @require'd
 *          library, say) or when the parser can't read it.
 */
function parseSource(aText, aUrl) {
  try {
    let scope = {};
    Cu.import("chrome://greasemonkey-modules/content/parseScript.js", scope);
    return scope.parse(aText, aUrl ? GM_util.getUriFromUrl(aUrl) : null,
        /* aFailWhenMissing */ true);
  } catch (e) {
    return null;
  }
}

/**
 * Names the file in the toolbar and the tab: the script's own (localised)
 * @name and its @version, else the file name.
 * @param {Script|null} aScript - From parseSource().
 * @param {string|null} aUrl - The address it was downloaded from.
 * @param {string} aPath - The on-disk path.
 * @returns {void}
 */
function showSourceName(aScript, aUrl, aPath) {
  let name = aScript ? aScript.localized.name : "";
  let version = (aScript && aScript.version) || "";
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
 * Puts the script's @icon beside its name, as the install window does:
 * the downloaded copy the caller passed, else a data: icon from the
 * metadata.  An icon that fails to load is hidden again.
 * @param {string|null} aIconUrl - A file: URL; only one inside the
 *        user-scripts folder or the temp area is used (see isAllowedPath).
 * @param {Script|null} aScript - From parseSource().
 * @returns {void}
 */
function showSourceIcon(aIconUrl, aScript) {
  let image = document.getElementById("gm-sv-icon");
  if (!image) {
    return;
  }
  let src = null;
  if (aIconUrl) {
    try {
      let file = GM_util.getUriFromUrl(aIconUrl)
          .QueryInterface(Ci.nsIFileURL).file;
      if (isAllowedPath(file.path)) {
        src = aIconUrl;
      }
    } catch (e) {
      // Not a local file: no icon from it.
    }
  }
  let dataUri = aScript && aScript.icon && aScript.icon._dataURI;
  if (!src && dataUri && /^data:image\//i.test(dataUri)) {
    src = dataUri;
  }
  if (!src) {
    return;
  }
  image.addEventListener("error", function () {
    image.setAttribute("hidden", "hidden");
  }, false);
  image.src = src;
  image.removeAttribute("hidden");
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
      SvFind.init(gCMInstance, svString);
      SvView.init({"cm": gCMInstance, "string": svString, "textarea": null});
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
  SvView.init({"cm": null, "string": svString, "textarea": ta});

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
 * Fills the status bar: the cursor position (with CodeMirror), the number
 * of lines, the size, the line endings, a byte-order mark and a hint that
 * the file is minified.
 * @param {string} aText - The decoded contents.
 * @param {Uint8Array} aBytes - The file as read.
 * @returns {void}
 */
function showStatus(aText, aBytes) {
  let breaks = aText.match(/\r\n|\r|\n/g) || [];
  let endings = {"CRLF": 0, "LF": 0, "CR": 0};
  breaks.forEach(function (aBreak) {
    endings[(aBreak == "\r\n") ? "CRLF" : ((aBreak == "\n") ? "LF" : "CR")]++;
  });
  let kinds = Object.keys(endings).filter(function (aKind) {
    return endings[aKind] > 0;
  });
  let longest = 0;
  aText.split(/\r\n|\r|\n/).forEach(function (aLine) {
    longest = Math.max(longest, aLine.length);
  });

  let lines = breaks.length + 1;
  setStatus("gm-sv-lines", (lines == 1)
      ? svString("sourceViewer.status.line", "1 line")
      : svString("sourceViewer.status.lines", "%1 lines")
          .replace("%1", lines.toLocaleString()));
  setStatus("gm-sv-size", svString("install.size.kb", "%1 KB")
      .replace("%1", Math.ceil(aBytes.length / 1024).toLocaleString()),
      svString("sourceViewer.status.bytes", "%1 bytes")
          .replace("%1", aBytes.length.toLocaleString()));
  if (kinds.length > 1) {
    setStatus("gm-sv-eol", svString(
        "sourceViewer.status.eol.mixed", "Mixed line endings"),
        kinds.map(function (aKind) {
          return aKind + " " + endings[aKind].toLocaleString();
        }).join(", "));
  } else {
    setStatus("gm-sv-eol", kinds[0] || "", svString(
        "sourceViewer.status.eol.tooltip", "Line endings"));
  }
  let bom = (aBytes.length >= 3) && (aBytes[0] == 0xEF)
      && (aBytes[1] == 0xBB) && (aBytes[2] == 0xBF);
  setStatus("gm-sv-bom", bom ? "BOM" : "", svString(
      "sourceViewer.status.bom.tooltip", "Starts with a UTF-8 byte order mark"));
  setStatus("gm-sv-minified", (longest >= SV_MINIFIED_LINE)
      ? svString("sourceViewer.status.minified", "minified") : "",
      svString("sourceViewer.status.minified.tooltip",
          "Its longest line has %1 characters, so it's probably minified.")
          .replace("%1", longest.toLocaleString()));

  if (gCMInstance) {
    showCursor();
    gCMInstance.on("cursorActivity", showCursor);
  }
  document.getElementById("gm-sv-status").removeAttribute("hidden");
}

/** The status bar's "Ln, Col" (from 1), and how much is selected. */
function showCursor() {
  let cursor = gCMInstance.getCursor("head");
  let text = svString("sourceViewer.status.cursor", "Ln %1, Col %2")
      .replace("%1", (cursor.line + 1).toLocaleString())
      .replace("%2", (cursor.ch + 1).toLocaleString());
  let selected = gCMInstance.getSelection().length;
  if (selected) {
    text += " " + svString("sourceViewer.status.selected", "(%1 selected)")
        .replace("%1", selected.toLocaleString());
  }
  setStatus("gm-sv-cursor", text);
}

/**
 * @param {string} aId - A status bar slot.
 * @param {string} aText - "" hides it.
 * @param {string} [aTooltip]
 */
function setStatus(aId, aText, aTooltip) {
  let slot = document.getElementById(aId);
  if (slot) {
    slot.textContent = aText;
    slot.title = aTooltip || "";
  }
}

/**
 * Looks up a localised string in the viewer's bundles, returning an English
 * fallback when no bundle has the key (so this feature ships without
 * touching the 34 locale files; keys can be added later).
 * @param {string} aKey
 * @param {string} aFallback
 * @returns {string}
 */
function svString(aKey, aFallback) {
  for (let i = 0, iLen = gBundles.length; i < iLen; i++) {
    try {
      return gBundles[i].GetStringFromName(aKey);
    } catch (e) {
      // Not in this bundle: try the next.
    }
  }
  return aFallback;
}

/**
 * Selects a line of the code and scrolls it into view: the metadata
 * header's values jump to the line that declares them.
 * @param {number} aLine - 0-based, as CodeMirror counts.
 * @returns {void}
 */
function jumpToLine(aLine) {
  if (gCMInstance) {
    let from = {"ch": 0, "line": aLine};
    let to = {"ch": gCMInstance.getLine(aLine).length, "line": aLine};
    gCMInstance.setSelection(from, to);
    gCMInstance.scrollIntoView({"from": from, "to": to}, 60);
    gCMInstance.focus();
    return;
  }
  // The plain-text fallback: its value has its line breaks as "\n".
  let textarea = document.getElementById("gm-sv-textarea");
  if (!textarea) {
    return;
  }
  let lines = textarea.value.split("\n");
  let start = 0;
  for (let i = 0; (i < aLine) && (i < lines.length); i++) {
    start += lines[i].length + 1;
  }
  let length = (aLine < lines.length) ? lines[aLine].length : 0;
  textarea.focus();
  textarea.setSelectionRange(start, start + length);
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
