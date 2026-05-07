/**
 * @file editor.js
 * @overview Built-in CodeMirror-based editor for Greasemonkey user scripts.
 *
 * Opens as a standalone XUL window (chrome://greasemonkey/content/editor.xul)
 * via openInEditor.js when the user has not configured an external editor.
 * Replaces the previous Scratchpad fallback.
 *
 * Capabilities (matched against Violentmonkey's editor as reference):
 *   - Top toolbar with Save / Save&Close / Undo / Redo / Find toggle /
 *     Fold / Unfold / Theme dropdown / Word Wrap / Line Numbers.
 *   - Inline Find/Replace bar (Ctrl+F = find, Ctrl+H = replace, Esc = close).
 *     Match-case and regex toggles.  Match-N-of-M counter.
 *   - Status bar with file path · cursor pos · modified · charset · EOL · lang.
 *   - JavaScript syntax highlighting via Pale Moon's bundled CodeMirror.
 *   - Light / Dark / Auto theme via toolbar dropdown.  "Auto" follows the
 *     host `prefers-color-scheme` media query.  All view prefs persisted
 *     under extensions.greasemonkey.editor.builtin.*
 *   - Code folding (foldcode + foldgutter) when the addon ships with the
 *     host CodeMirror; gracefully degrades when it doesn't.
 *   - Save (Ctrl+S) writes the current text to disk via OS.File.writeAtomic
 *     and notifies the GM service so any open page reloads the script via
 *     the existing config.updateModifiedScripts() flow.
 *   - Save & Close (Ctrl+Shift+W), Revert (re-read from disk), Undo / Redo,
 *     all wired to CodeMirror's built-in editing commands.
 *   - On window close, prompts to save when the buffer has unsaved changes.
 *
 * Window arguments (window.arguments[0]):
 *   {
 *     scriptFile: nsIFile     // the .user.js on disk
 *     scriptId:   string      // for the live-reload notification
 *     scriptName: string      // for the window title
 *   }
 *
 * The editor is intentionally chrome-context only — no script content from
 * the userscript itself is ever evaluated here.
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
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


////////////////////////// Module-scoped editor state //////////////////////////

/** Pale Moon's source-editor wrapper class.  Resolved lazily. */
var gEditorClass = null;

/** The live source-editor instance once appendTo() resolves. */
var gEditor = null;

/** The underlying CodeMirror instance, dug out of the wrapper after mount.
 *  We need this for addon-only APIs (search cursor, fold state) that the
 *  source-editor wrapper does not surface directly. */
var gCM = null;

/** @type {nsIFile} The on-disk userscript file backing this editor window. */
var gScriptFile = null;

/** @type {string} Script id (`<name>@<namespace>`), passed across via args. */
var gScriptId = null;

/** @type {string} Human-readable script name; used in the window title. */
var gScriptName = "";

/** Whether the editor's buffer has unsaved changes since the last save. */
var gIsDirty = false;

/** Localised string bundle for runtime-formatted strings. */
var gBundle = null;

/** Currently-open Find / Replace state. */
var gFind = {
  "open":     false,
  "replace":  false,    // true when Ctrl+H opened the bar (replace row visible)
  "matches":  [],       // array of {from, to} CodeMirror positions
  "current":  -1,       // index into matches; -1 means "no current selection"
  "case":     false,
  "regex":    false,
};

/** Whether code folding has been enabled on the live editor. */
var gFoldingEnabled = false;

/** Pref keys.  Centralised so the spelling is identical everywhere. */
const PREF_THEME       = "editor.builtin.theme";
const PREF_WRAP        = "editor.builtin.wordWrap";
const PREF_LINENUMBERS = "editor.builtin.lineNumbers";

const DEFAULT_THEME       = "auto";
const DEFAULT_WRAP        = false;
const DEFAULT_LINENUMBERS = true;

/** Candidate paths for the source-editor wrapper across Pale Moon versions. */
const EDITOR_URL_CANDIDATES = [
  "resource://devtools/client/sourceeditor/editor.js",
  "resource:///modules/devtools/sourceeditor/editor.js",
  "resource://gre/modules/devtools/sourceeditor/editor.js",
  "resource:///modules/devtools/client/sourceeditor/editor.js",
];

/** Candidate chrome URLs for CodeMirror's foldcode + foldgutter addons.
 *  We try each in order; the first one that loads enables folding. */
const FOLD_ADDON_URL_CANDIDATES = [
  "chrome://devtools/content/sourceeditor/codemirror/addon/fold/foldcode.js",
  "chrome://devtools/content/sourceeditor/codemirror/addon/fold/foldgutter.js",
  "chrome://devtools/content/sourceeditor/codemirror/addon/fold/brace-fold.js",
  "chrome://devtools/content/sourceeditor/codemirror/addon/fold/comment-fold.js",
];

////////////////////////// Window lifecycle handlers ///////////////////////////

function onLoad() {
  gBundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGreasemonkeyProperties);

  let args = (window.arguments && window.arguments[0]) || {};
  gScriptFile = args.scriptFile || null;
  gScriptId   = args.scriptId   || null;
  gScriptName = args.scriptName || "";

  document.title = formatTitle(gScriptName, /*dirty=*/false);

  // Path display in the status bar (left-side, crop at the start so the
  // filename stays visible when the path overflows).
  if (gScriptFile) {
    document.getElementById("status-path").value = gScriptFile.path;
  }

  // Reflect persisted View toggles in BOTH the menu and toolbar items
  // BEFORE the editor mounts.
  let themePref      = GM_prefRoot.getValue(PREF_THEME,       DEFAULT_THEME);
  let wrapPref       = GM_prefRoot.getValue(PREF_WRAP,        DEFAULT_WRAP);
  let lineNumbersPref= GM_prefRoot.getValue(PREF_LINENUMBERS, DEFAULT_LINENUMBERS);
  syncThemeUI(themePref);
  syncWrapUI(wrapPref);
  syncLineNumbersUI(lineNumbersPref);

  if (!loadEditorClass()) {
    mountTextareaFallback(wrapPref);
    return;
  }

  let host = document.getElementById("editor-host");
  applyHostThemeClass(host, themePref);

  gEditor = new gEditorClass({
    "mode":          gEditorClass.modes ? gEditorClass.modes.js : "javascript",
    "lineNumbers":   lineNumbersPref,
    "lineWrapping":  wrapPref,
    "autoCloseBrackets": true,
    "matchBrackets": true,
    "showCursorWhenSelecting": true,
    "readOnly":      false,
  });

  let appendPromise = gEditor.appendTo(host);
  if (appendPromise && typeof appendPromise.then == "function") {
    appendPromise.then(onEditorReady, onEditorError);
  } else {
    setTimeout(onEditorReady, 0);
  }
}

function onEditorReady() {
  if (!gScriptFile || !gScriptFile.exists()) {
    showFatalError(gBundle.GetStringFromName("error.editor.noFile"));
    return;
  }

  // Capture the underlying CodeMirror once the wrapper is mounted, so we
  // have access to addon-only APIs (search cursor, foldcode, etc.) that
  // the source-editor wrapper deliberately keeps internal.
  try {
    if (gEditor && typeof gEditor.cm != "undefined") {
      gCM = gEditor.cm;
    } else if (gEditor && gEditor._cm) {
      gCM = gEditor._cm;
    }
  } catch (e) {
    gCM = null;
  }

  // Enable folding if the foldcode addon is available.  No-op silently
  // when the addon doesn't ship with this Pale Moon build.
  enableCodeFolding();

  let path = gScriptFile.path;
  let promise = OS.File.read(path, { "encoding": "UTF-8" });
  promise.then(function (text) {
    if (gEditor && typeof gEditor.setText == "function") {
      gEditor.setText(text);
      gIsDirty = false;
      updateDirtyIndicator();

      // Detect line-ending style for the status bar.
      updateEolIndicator(text);

      if (typeof gEditor.on == "function") {
        gEditor.on("change", onBufferChange);
        gEditor.on("cursorActivity", updateCursorPosition);
      }
      updateCursorPosition();

      try { gEditor.focus(); } catch (e) {}
    }
  }, function (e) {
    showFatalError(
        gBundle.GetStringFromName("error.editor.readFailed")
            .replace("%1", path).replace("%2", "" + e));
  });
}

function onEditorError(e) {
  showFatalError(
      gBundle.GetStringFromName("error.editor.cantLoad")
          .replace("%1", "" + e));
}

function onClose() {
  if (!gIsDirty) return true;
  let title = gBundle.GetStringFromName("editor.unsaved.title");
  let msg   = gBundle.GetStringFromName("editor.unsaved.body")
      .replace("%1", gScriptName);
  let prompts = Services.prompt;
  let flags =
      prompts.BUTTON_TITLE_SAVE     * prompts.BUTTON_POS_0
    | prompts.BUTTON_TITLE_DONT_SAVE* prompts.BUTTON_POS_1
    | prompts.BUTTON_TITLE_CANCEL   * prompts.BUTTON_POS_2
    | prompts.BUTTON_POS_0_DEFAULT;
  let result = prompts.confirmEx(window, title, msg, flags,
      "", "", "", null, {});
  switch (result) {
    case 0: onSave(); return true;
    case 1: return true;
    case 2: default: return false;
  }
}

////////////////////////////// Action handlers /////////////////////////////////

function onSave() {
  if (!gEditor || !gScriptFile) return;
  let text = gEditor.getText();
  let path = gScriptFile.path;
  let bytes = new TextEncoder("utf-8").encode(text);
  OS.File.writeAtomic(path, bytes, { "tmpPath": path + ".tmp" }).then(
      function () {
        gIsDirty = false;
        updateDirtyIndicator();
        updateEolIndicator(text);
        notifyScriptEdited();
      },
      function (e) {
        Services.prompt.alert(window,
            gBundle.GetStringFromName("editor.saveFailed.title"),
            gBundle.GetStringFromName("editor.saveFailed.body")
                .replace("%1", path).replace("%2", "" + e));
      });
}

function onSaveAndClose() {
  if (!gEditor || !gScriptFile) { window.close(); return; }
  let text = gEditor.getText();
  let path = gScriptFile.path;
  let bytes = new TextEncoder("utf-8").encode(text);
  OS.File.writeAtomic(path, bytes, { "tmpPath": path + ".tmp" }).then(
      function () {
        gIsDirty = false;
        notifyScriptEdited();
        window.close();
      },
      function (e) {
        Services.prompt.alert(window,
            gBundle.GetStringFromName("editor.saveFailed.title"),
            gBundle.GetStringFromName("editor.saveFailed.body")
                .replace("%1", path).replace("%2", "" + e));
      });
}

function onRevert() {
  if (!gIsDirty) return;
  let title = gBundle.GetStringFromName("editor.revert.title");
  let msg   = gBundle.GetStringFromName("editor.revert.body");
  if (!Services.prompt.confirm(window, title, msg)) return;
  onEditorReady();
}

function onUndo() {
  if (gEditor && typeof gEditor.undo == "function") gEditor.undo();
}
function onRedo() {
  if (gEditor && typeof gEditor.redo == "function") gEditor.redo();
}

////////////////////////////// Find / Replace //////////////////////////////////

/**
 * Toggles the inline find bar.  When aShowReplace is true, the replace
 * row is also shown (Ctrl+H).  When the bar is already open, calling
 * this with a different aShowReplace updates the row visibility without
 * closing.
 */
function onToggleFind(aShowReplace) {
  let bar = document.getElementById("find-bar");
  let replaceRow = document.getElementById("replace-row");
  let findInput = document.getElementById("find-input");
  let tbFind = document.getElementById("tb-find");

  let opening = bar.hidden;
  if (opening) {
    bar.hidden = false;
    gFind.open = true;
    if (tbFind) tbFind.setAttribute("checked", "true");
  }
  gFind.replace = !!aShowReplace;
  replaceRow.hidden = !gFind.replace;

  // Pre-fill the search box with the current selection if any.
  if (opening && gEditor && typeof gEditor.getSelection == "function") {
    let sel;
    try { sel = gEditor.getSelection(); } catch (e) { sel = null; }
    if (sel && sel.indexOf("\n") === -1) {
      findInput.value = sel;
    }
  }

  setTimeout(function () { findInput.focus(); findInput.select(); }, 0);
  if (findInput.value) onFindInputChange();
}

function onCloseFind() {
  let bar = document.getElementById("find-bar");
  let tbFind = document.getElementById("tb-find");
  bar.hidden = true;
  gFind.open = false;
  gFind.matches = [];
  gFind.current = -1;
  if (tbFind) tbFind.setAttribute("checked", "false");
  document.getElementById("find-count").value = "";
  if (gEditor) {
    try { gEditor.focus(); } catch (e) {}
  }
}

function onFindKey(aEvent) {
  // Enter = find next; Shift+Enter = find prev
  if (aEvent.keyCode === aEvent.DOM_VK_RETURN) {
    if (aEvent.shiftKey) onFindPrev(); else onFindNext();
    aEvent.preventDefault();
  }
}

function onFindOptionsChange() {
  gFind.case  = document.getElementById("find-case").checked;
  gFind.regex = document.getElementById("find-regex").checked;
  onFindInputChange();
}

/**
 * Recomputes gFind.matches whenever the query or its options change.
 * Updates the N-of-M counter and jumps the editor to the first match.
 */
function onFindInputChange() {
  let q = document.getElementById("find-input").value;
  gFind.matches = [];
  gFind.current = -1;
  if (!q || !gEditor) {
    document.getElementById("find-count").value = "";
    return;
  }

  let text = gEditor.getText();
  let pattern;
  try {
    if (gFind.regex) {
      pattern = new RegExp(q, gFind.case ? "g" : "gi");
    } else {
      // Escape regex specials so a literal search of e.g. "GM_log()" works.
      let escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      pattern = new RegExp(escaped, gFind.case ? "g" : "gi");
    }
  } catch (e) {
    // Invalid regex — clear count, leave matches empty.
    document.getElementById("find-count").value =
        gBundle.GetStringFromName("editor.find.invalidRegex");
    return;
  }

  let m;
  // Cap at 10000 matches to keep huge files responsive.
  while ((m = pattern.exec(text)) !== null && gFind.matches.length < 10000) {
    gFind.matches.push({ "start": m.index, "end": m.index + m[0].length });
    if (m.index === pattern.lastIndex) pattern.lastIndex++; // zero-width
  }

  let countLabel = document.getElementById("find-count");
  if (gFind.matches.length === 0) {
    countLabel.value = gBundle.GetStringFromName("editor.find.noResults");
  } else {
    // Jump to the first match at-or-after the current cursor pos.
    let cursor = gEditor.getCursor ? gEditor.getCursor() : { line: 0, ch: 0 };
    let cursorOffset = lineColToOffset(text, cursor.line, cursor.ch);
    gFind.current = 0;
    for (let i = 0; i < gFind.matches.length; i++) {
      if (gFind.matches[i].start >= cursorOffset) {
        gFind.current = i;
        break;
      }
    }
    selectMatch(gFind.current);
    updateFindCount();
  }
}

function onFindNext() {
  if (gFind.matches.length === 0) return;
  gFind.current = (gFind.current + 1) % gFind.matches.length;
  selectMatch(gFind.current);
  updateFindCount();
}

function onFindPrev() {
  if (gFind.matches.length === 0) return;
  gFind.current = (gFind.current - 1 + gFind.matches.length)
      % gFind.matches.length;
  selectMatch(gFind.current);
  updateFindCount();
}

function onReplace() {
  if (gFind.current < 0 || gFind.matches.length === 0) {
    onFindInputChange();
    return;
  }
  let replacement = document.getElementById("replace-input").value;
  if (!gEditor) return;
  let m = gFind.matches[gFind.current];
  let text = gEditor.getText();
  let newText = text.substring(0, m.start) + replacement
      + text.substring(m.end);
  gEditor.setText(newText);
  // Re-scan since offsets shifted.
  onFindInputChange();
}

function onReplaceAll() {
  if (gFind.matches.length === 0) {
    onFindInputChange();
    if (gFind.matches.length === 0) return;
  }
  let replacement = document.getElementById("replace-input").value;
  if (!gEditor) return;
  let text = gEditor.getText();
  // Walk in reverse so each replacement doesn't shift earlier offsets.
  let buf = text;
  for (let i = gFind.matches.length - 1; i >= 0; i--) {
    let m = gFind.matches[i];
    buf = buf.substring(0, m.start) + replacement + buf.substring(m.end);
  }
  gEditor.setText(buf);
  onFindInputChange();
}

/**
 * Translates an absolute character offset into {line, ch} so we can drive
 * CodeMirror's setSelection() without touching its internal indexing.
 */
function offsetToLineCol(aText, aOffset) {
  let line = 0;
  let last = 0;
  for (let i = 0; i < aOffset; i++) {
    if (aText.charCodeAt(i) === 10) {
      line++;
      last = i + 1;
    }
  }
  return { "line": line, "ch": aOffset - last };
}

/** Inverse of offsetToLineCol. */
function lineColToOffset(aText, aLine, aCh) {
  let line = 0;
  let i = 0;
  while (i < aText.length && line < aLine) {
    if (aText.charCodeAt(i) === 10) line++;
    i++;
  }
  return Math.min(aText.length, i + (aCh | 0));
}

function selectMatch(aIdx) {
  if (!gEditor || aIdx < 0 || aIdx >= gFind.matches.length) return;
  let m = gFind.matches[aIdx];
  let text = gEditor.getText();
  let from = offsetToLineCol(text, m.start);
  let to   = offsetToLineCol(text, m.end);
  if (typeof gEditor.setSelection == "function") {
    try { gEditor.setSelection(from, to); } catch (e) {}
  } else if (gCM && typeof gCM.setSelection == "function") {
    gCM.setSelection(from, to);
  }
  // Best-effort scroll to keep the match in view.
  if (gCM && typeof gCM.scrollIntoView == "function") {
    try { gCM.scrollIntoView({ "from": from, "to": to }, 80); } catch (e) {}
  }
}

function updateFindCount() {
  let label = document.getElementById("find-count");
  let total = gFind.matches.length;
  if (total === 0) {
    label.value = gBundle.GetStringFromName("editor.find.noResults");
  } else {
    label.value = gBundle.GetStringFromName("editor.find.countOf")
        .replace("%1", gFind.current + 1)
        .replace("%2", total);
  }
}

////////////////////////////// Code folding ////////////////////////////////////

function enableCodeFolding() {
  if (!gCM) return;  // can't fold without underlying CodeMirror
  let CodeMirror = gCM.constructor || (window.CodeMirror || null);
  if (!CodeMirror) return;

  // Probe each candidate addon URL.  First one that loads cleanly wins.
  let scope = { CodeMirror: CodeMirror };
  let loaded = 0;
  for (let i = 0; i < FOLD_ADDON_URL_CANDIDATES.length; i++) {
    try {
      Services.scriptloader.loadSubScript(FOLD_ADDON_URL_CANDIDATES[i], scope);
      loaded++;
    } catch (e) {
      // Addon not present at this URL — try the next one.
    }
  }
  if (loaded === 0) return;

  try {
    // Add the fold gutter so users see clickable arrows in the gutter.
    let currentGutters = gCM.getOption("gutters") || [];
    if (currentGutters.indexOf("CodeMirror-foldgutter") === -1) {
      gCM.setOption("gutters",
          currentGutters.concat(["CodeMirror-foldgutter"]));
    }
    gCM.setOption("foldGutter", true);
    if (CodeMirror.fold && CodeMirror.fold.brace) {
      gCM.setOption("foldOptions",
          { "rangeFinder": CodeMirror.fold.brace });
    }
    gFoldingEnabled = true;
  } catch (e) {
    // Folding setup failed — toolbar buttons will become no-ops.
  }
}

function onFoldAll() {
  if (!gCM || !gFoldingEnabled) return;
  let CodeMirror = gCM.constructor || (window.CodeMirror || null);
  if (!CodeMirror || !CodeMirror.commands || !CodeMirror.commands.foldAll) {
    return;
  }
  try { CodeMirror.commands.foldAll(gCM); } catch (e) {}
}

function onUnfoldAll() {
  if (!gCM || !gFoldingEnabled) return;
  let CodeMirror = gCM.constructor || (window.CodeMirror || null);
  if (!CodeMirror || !CodeMirror.commands || !CodeMirror.commands.unfoldAll) {
    return;
  }
  try { CodeMirror.commands.unfoldAll(gCM); } catch (e) {}
}

////////////////////////////// View → Theme ///////////////////////////////////

function onThemeChange(aTheme) {
  GM_prefRoot.setValue(PREF_THEME, aTheme);
  let host = document.getElementById("editor-host");
  applyHostThemeClass(host, aTheme);
  syncThemeUI(aTheme);
}

function applyHostThemeClass(aHost, aTheme) {
  if (!aHost) return;
  let resolved = aTheme;
  if (aTheme === "auto") {
    let mql;
    try { mql = window.matchMedia("(prefers-color-scheme: dark)"); }
    catch (e) { mql = null; }
    resolved = (mql && mql.matches) ? "dark" : "light";
  }
  aHost.classList.remove("theme-light");
  aHost.classList.remove("theme-dark");
  aHost.classList.add("theme-" + resolved);
}

function onWordWrapToggle(aOn) {
  GM_prefRoot.setValue(PREF_WRAP, !!aOn);
  if (gEditor && typeof gEditor.setOption == "function") {
    try { gEditor.setOption("lineWrapping", !!aOn); } catch (e) {}
  }
  syncWrapUI(!!aOn);
}

function onLineNumbersToggle(aOn) {
  GM_prefRoot.setValue(PREF_LINENUMBERS, !!aOn);
  if (gEditor && typeof gEditor.setOption == "function") {
    try { gEditor.setOption("lineNumbers", !!aOn); } catch (e) {}
  }
  syncLineNumbersUI(!!aOn);
}

//////////////////////////// UI sync helpers ///////////////////////////////////

/** Keeps the toolbar dropdown and the View > Theme menu radio in sync. */
function syncThemeUI(aTheme) {
  let menuList = document.getElementById("tb-theme");
  if (menuList) {
    let items = menuList.getElementsByTagName("menuitem");
    for (let i = 0; i < items.length; i++) {
      if (items[i].getAttribute("value") === aTheme) {
        menuList.selectedItem = items[i];
        break;
      }
    }
  }
  let menuPopup = document.getElementById("theme-menu");
  if (menuPopup) {
    let items = menuPopup.getElementsByTagName("menuitem");
    for (let i = 0; i < items.length; i++) {
      let isMatch = items[i].id === "theme-" + aTheme + "-menu";
      items[i].setAttribute("checked", isMatch ? "true" : "false");
    }
  }
}

/** Word-wrap state ↔ menu checkbox + toolbar toggle button. */
function syncWrapUI(aOn) {
  let menu = document.getElementById("menu-wrap");
  if (menu) menu.setAttribute("checked", aOn ? "true" : "false");
  let tb = document.getElementById("tb-wrap");
  if (tb) tb.setAttribute("checked", aOn ? "true" : "false");
}

/** Line-numbers state ↔ menu checkbox + toolbar toggle button. */
function syncLineNumbersUI(aOn) {
  let menu = document.getElementById("menu-linenumbers");
  if (menu) menu.setAttribute("checked", aOn ? "true" : "false");
  let tb = document.getElementById("tb-linenumbers");
  if (tb) tb.setAttribute("checked", aOn ? "true" : "false");
}

//////////////////////////// Status bar / title ////////////////////////////////

function onBufferChange() {
  if (!gIsDirty) {
    gIsDirty = true;
    updateDirtyIndicator();
  }
}

function updateDirtyIndicator() {
  document.title = formatTitle(gScriptName, gIsDirty);
  let label = document.getElementById("status-modified");
  if (!label) return;
  label.value = gIsDirty
      ? gBundle.GetStringFromName("editor.status.modified")
      : "";
}

function updateCursorPosition() {
  let label = document.getElementById("status-position");
  if (!label || !gEditor || typeof gEditor.getCursor != "function") return;
  let cur;
  try { cur = gEditor.getCursor(); } catch (e) { return; }
  if (!cur) return;
  let line = (cur.line | 0) + 1;
  let col  = (cur.ch   | 0) + 1;
  label.value = gBundle.GetStringFromName("editor.status.position")
      .replace("%1", line).replace("%2", col);
}

/**
 * Sniffs the buffer for CRLF vs LF (CR-only is rare; treat as LF for
 * display purposes) and updates the status-bar EOL indicator.  Called
 * after each successful read or save.
 */
function updateEolIndicator(aText) {
  let label = document.getElementById("status-eol");
  if (!label) return;
  let key;
  if (aText && aText.indexOf("\r\n") !== -1) {
    key = "editor.status.eol.crlf";
  } else {
    key = "editor.status.eol.lf";
  }
  try {
    label.value = gBundle.GetStringFromName(key);
  } catch (e) {
    label.value = (key === "editor.status.eol.crlf") ? "CRLF" : "LF";
  }
}

function formatTitle(aName, aDirty) {
  let format = gBundle.GetStringFromName("editor.windowTitle");
  let title = format.replace("%1", aName || "");
  if (aDirty) {
    let prefix = gBundle.GetStringFromName("editor.windowTitle.dirtyPrefix");
    title = prefix + title;
  }
  return title;
}

////////////////////////////// Wire-up plumbing ////////////////////////////////

function loadEditorClass() {
  for (let i = 0; i < EDITOR_URL_CANDIDATES.length; i++) {
    let url = EDITOR_URL_CANDIDATES[i];
    let scope = {};
    try {
      Cu.import(url, scope);
      if (scope.Editor) {
        gEditorClass = scope.Editor;
        return true;
      }
    } catch (e) { /* try the next one */ }
  }
  return false;
}

function mountTextareaFallback(aWrap) {
  let host = document.getElementById("editor-host");
  while (host.firstChild) host.removeChild(host.firstChild);

  let ta = document.createElementNS(
      "http://www.w3.org/1999/xhtml", "html:textarea");
  ta.id = "editor-textarea-fallback";
  ta.setAttribute("flex", "1");
  ta.style.width  = "100%";
  ta.style.height = "100%";
  ta.style.fontFamily = "monospace";
  ta.spellcheck = false;
  ta.wrap = aWrap ? "soft" : "off";
  host.appendChild(ta);

  // Synthesize a minimal Editor-like shim so the rest of this file works.
  gEditor = {
    "_ta": ta,
    "setText":      function (s) { ta.value = s; },
    "getText":      function ()  { return ta.value; },
    "getSelection": function () {
      return ta.value.substring(ta.selectionStart, ta.selectionEnd);
    },
    "setSelection": function (from, to) {
      let text = ta.value;
      let start = lineColToOffset(text, from.line, from.ch);
      let end   = lineColToOffset(text, to.line,   to.ch);
      ta.selectionStart = start;
      ta.selectionEnd   = end;
    },
    "getCursor":    function () {
      let pos = ta.selectionStart | 0;
      let pre = ta.value.substring(0, pos);
      let line = (pre.match(/\n/g) || []).length;
      let lastNl = pre.lastIndexOf("\n");
      let ch = lastNl === -1 ? pos : pos - lastNl - 1;
      return { "line": line, "ch": ch };
    },
    "on": function (evt, cb) {
      if (evt === "change")          ta.addEventListener("input",   cb, false);
      else if (evt === "cursorActivity") {
        ta.addEventListener("keyup",   cb, false);
        ta.addEventListener("mouseup", cb, false);
      }
    },
    "focus":   function () { ta.focus(); },
    "undo":    function () {},
    "redo":    function () {},
    "execCommand": function () {},
    "setOption": function (name, value) {
      if (name === "lineWrapping") ta.wrap = value ? "soft" : "off";
    },
    "appendTo": function () { return Promise.resolve(); },
  };

  setTimeout(onEditorReady, 0);
}

function notifyScriptEdited() {
  try {
    let config = GM_util.getService().config;
    if (!config) return;
    config.updateModifiedScripts("document-start", null);
    config.updateModifiedScripts("document-end",   null);
    config.updateModifiedScripts("document-idle",  null);
  } catch (e) { /* service not ready — no-op */ }
}

function showFatalError(aMessage) {
  Services.prompt.alert(window,
      gBundle.GetStringFromName("editor.fatal.title"),
      aMessage);
  setTimeout(function () { window.close(); }, 0);
}
