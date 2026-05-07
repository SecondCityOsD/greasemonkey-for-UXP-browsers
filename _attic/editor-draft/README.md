# Built-in CodeMirror editor — parked draft

This folder holds an in-progress build of a Violentmonkey-style built-in
script editor for Greasemonkey-for-UXP.  The work was paused before
shipping; the files here are kept as a starting point for whoever picks
the work back up.

## What's here

```
_attic/editor-draft/
├── content/
│   ├── editor.xul    — XUL window: maximized, top toolbar (Save/SaveClose/
│   │                   Undo/Redo/Find toggle/FoldAll/UnfoldAll, theme
│   │                   dropdown, WordWrap and LineNumbers toggles), menu
│   │                   bar with the same items (for accessibility), inline
│   │                   Find / Replace bar (Ctrl+F / Ctrl+H, Esc to close,
│   │                   match-case + regex toggles, N-of-M counter), and an
│   │                   enriched status bar with file path, cursor line:col,
│   │                   modified indicator, charset (UTF-8), EOL (LF/CRLF),
│   │                   and language label.
│   └── editor.js     — Window logic: lazy-loads Pale Moon's bundled
│                       CodeMirror via `Cu.import` of the source-editor
│                       wrapper (4 candidate URLs across PM/Basilisk
│                       versions), falls back to a plain <html:textarea>
│                       when the wrapper isn't available; full Find/Replace
│                       state machine via String.indexOf (no dependency on
│                       CodeMirror's searchcursor addon); code folding
│                       enabled when the foldcode + foldgutter + brace-fold
│                       addons are present (try/catch fallback); save via
│                       OS.File.writeAtomic; live-reload notification via
│                       config.updateModifiedScripts(); persisted view
│                       prefs under `extensions.greasemonkey.editor.builtin.*`.
├── skin/
│   └── editor.css    — Layout (host vbox fills via flex + height:100% on
│                       the inner CodeMirror), light/dark theme overrides,
│                       toolbar / find-bar / status-bar styling.
└── locale/en-US/
    └── gmEditor.dtd  — All XUL entities (~50): menu labels, toolbar
                        tooltips, find/replace strings, status-bar EOL
                        / encoding labels.
```

## What's NOT here

- **The runtime-formatted strings** that lived in `locale/<each>/greasemonkey.properties`
  (`editor.windowTitle`, `editor.placeholder.builtin/scratchpad`, all the
  `editor.find.*` and `editor.status.*` keys, plus `error.editor.*`).
  Those were appended in-line and reverted via `git checkout HEAD --`.
  When resuming, regenerate them by re-running the bash propagation
  script (see notes below) against the lines added in this folder's
  history.

- **The 33 non-en-US `gmEditor.dtd` copies.**  All identical English
  placeholders.  Regenerate trivially:

  ```bash
  for dir in locale/*/; do
    [ "$(basename "$dir")" = "en-US" ] && continue
    cp _attic/editor-draft/locale/en-US/gmEditor.dtd "$dir/gmEditor.dtd"
  done
  ```

## State of the work when paused

✅  Working
- Editor window opens maximized, fills the screen.
- Save / Save & Close / Revert work end-to-end (text → disk → reload).
- Light/Dark/Auto theme switching with persisted prefs.
- Word-wrap and line-numbers toggles in toolbar AND View menu, kept in
  sync.
- Status bar updates live: cursor pos, modified indicator, EOL detection.
- Find/Replace logic, including case-sensitive and regex modes,
  Replace, Replace All.

⚠️  Untested in real Pale Moon / Basilisk
- Code folding — depends on whether the host CodeMirror ships the
  foldcode/foldgutter/brace-fold addons under
  `chrome://devtools/content/sourceeditor/codemirror/addon/fold/*.js`.
  The probe is best-effort; if any of them fail the load, folding stays
  disabled silently.

❌  Not implemented (deferred to follow-up phases)
- GM_* / GM.* API autocomplete (would need a custom CodeMirror hint
  addon listing every name from `modules/constants.js`).
- Live linting / red-squiggle markers (would need ESLint or JSHint
  bundled in the XPI).
- External-editor auto-detection (probe for VS Code / Notepad++ /
  Sublime / etc.).
- The Greasemonkey → Options "Use Scratchpad" opt-in button + the
  `scratchpad:` sentinel in `extensions.greasemonkey.editor`.

## Two known bugs that would need fixing on resume

1.  **Editor area collapses to ~30 px** when the host vbox doesn't
    propagate explicit height to the inner `.CodeMirror` div.  The fix
    that worked during testing was adding to `editor.css`:

    ```css
    #editor-host > .CodeMirror,
    #editor-host iframe {
      -moz-box-flex: 1;
      flex: 1 1 auto;
      width: 100%;
      height: 100% !important;
      min-height: 0;
    }
    #editor-host .CodeMirror-scroll {
      height: 100% !important;
    }
    ```

2.  **`Browse for Editor Program` becomes a no-op after `Use Scratchpad`**.
    Root cause is in `modules/util/getEditor.js`: when the editor pref
    holds the `scratchpad:` sentinel, `nsIFile.initWithPath` throws on
    the colon and the validity check at the bottom silently clears the
    pref.  The fix that worked during testing was an early return:

    ```js
    if (editorPath === "scratchpad:") {
      return null;
    }
    ```
    inserted at the top of `getEditor()` before the `nsIFile` allocation.
    Mirror the same sentinel in `openInEditor.js` (`SCRATCHPAD_SENTINEL`)
    and `content/options.js` (`EDITOR_PREF_SCRATCHPAD`).

## How to resume

1.  Move the four files above back to their original locations
    (`content/editor.xul`, `content/editor.js`, `skin/editor.css`,
    `locale/en-US/gmEditor.dtd`).
2.  Re-create the 33 locale gmEditor.dtd copies via the bash one-liner
    above.
3.  Re-append the editor.* runtime strings to every locale's
    greasemonkey.properties (see the same conversation that produced
    these files for the exact lines, or re-derive from the entity names
    consumed by editor.js).
4.  Apply the openInEditor.js / getEditor.js / options.xul / options.js
    edits documented in the conversation history.  The `scratchpad:`
    sentinel needs to land in all three of those files atomically.
5.  Bump install.rdf to whatever the next minor is (last shipped:
    3.6.2; the editor would have shipped as 3.7.0).

## Why this was paused

Two reasons made it sensible to park:
1.  CodeMirror's behaviour inside Pale Moon's source-editor wrapper is
    version-dependent enough that confidently shipping it would need a
    Pale Moon test matrix we don't have yet.
2.  The per-script options page redesign (Phase M) was higher priority
    and overlaps the editor work in two places — the future "Code" tab
    and the future GM_setValue browser would both reuse parts of this
    editor's plumbing.  Doing M first makes the editor's eventual
    integration cleaner.

— paused 2026-04-30, after L7a (toolbar XUL written, JS partially
written, no XPI built since the redesign).
