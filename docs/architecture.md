# Architecture — Greasemonkey for UXP

**Companion document:** [`docs/legacy-inventory.md`](legacy-inventory.md)
**Branch:** `cleanup/strip-legacy`
**Status:** Phase 2 of the legacy-cleanup roadmap.

---

## 1. Purpose

This document describes how Greasemonkey for UXP works **as a single-process
Pale Moon / Basilisk extension**. It is the architectural reference for:

- Anyone reading the source for the first time.
- Forum readers deciding whether the fork is worth using.
- Future contributors planning a feature change.
- Phase 4-7 cleanup work — every later refactor can be checked against the
  flow diagrams here to confirm the *behavior* is unchanged even when the
  *plumbing* is collapsed.

### Note on framescript indirection

Several end-to-end flows in §5 are described as if all logic runs chrome-side.
That **will be true after Phase 4**; today, multiple steps detour through
`content/frameScript.js` and `messageManager` IPC even though chrome and
content are the same process under UXP. Each detour is flagged with
**[Phase 4 collapse]** in the footnotes. The semantics are unchanged either way.

---

## 2. Platform model

### 2.1 What we depend on

| Capability | Where it comes from |
|------------|---------------------|
| XPCOM components, JSMs (`Cu.import`) | UXP core; first-class on Pale Moon / Basilisk |
| XUL chrome (`<window>`, `<dialog>`, overlays) | UXP core; deprecated upstream, **stable on UXP** |
| XBL bindings (`-moz-binding`) | UXP core; legacy but functional |
| `Services.obs` (nsIObserverService) | UXP core |
| `nsIContentPolicy`, `nsIProtocolHandler`, `http-on-modify-request` / `http-on-examine-response` | UXP core |
| `nsICookieManager`, `nsIClipboard`, `nsITransferable`, `nsIFile`, `nsIZipReader/Writer` | UXP core |
| `Cu.Sandbox`, `Cu.evalInSandbox`, `Cu.exportFunction`, `Cu.cloneInto` | UXP / SpiderMonkey |
| Scratchpad (built-in user-script editor host) | Pale Moon / Basilisk DevTools |

### 2.2 What we explicitly do NOT depend on

| Capability | Reason |
|-----------|--------|
| Any `chrome.*` / `browser.*` WebExtensions API | UXP doesn't ship them |
| Multi-process content (e10s, Fission) | UXP is single-process by design |
| `messageManager` for cross-process IPC | Not needed on single-process; collapsed in Phase 4 |
| `framescript`-style content-side runners | Same as above |
| Modern Mozilla APIs added post-Fx 56 (background-only) | Not on UXP |

### 2.3 Minimum supported targets

**Pale Moon 28+** and **Basilisk current**. Compatibility branches for
older versions were removed in Phase 4 (see legacy-inventory §5).

---

## 3. Component map

The fork is organised as a single XPCOM service plus a set of JSMs and
chrome dialogs. The service (`components/greasemonkey.js`) is the "kernel";
everything else is invoked through it.

```
┌──────────────────────────────────────────────────────────────────────────┐
│                       components/greasemonkey.js                         │
│  (the GreasemonkeyService — singleton, registered as XPCOM @profile-after│
│   -change; provides .config, .scriptUpdateData, install hooks, observer  │
│   boundary)                                                              │
└──────────────────────────────────────────────────────────────────────────┘
                                  │ owns
        ┌─────────────────────────┼──────────────────────────┐
        │                         │                          │
        ▼                         ▼                          ▼
┌──────────────┐         ┌─────────────────┐        ┌────────────────────┐
│  Config      │         │  RequestObserver│        │  ResponseObserver  │
│  (config.js) │         │  (intercepts    │        │  (CSP/CORS,        │
│              │         │   .user.js HTTP │        │   header rewrite)  │
│  - script    │         │   navigations)  │        │                    │
│    registry  │         └─────────────────┘        └────────────────────┘
│  - config.xml│
│  - global    │
│    excludes  │
└──────────────┘
        │ holds N
        ▼
┌────────────────────────────────────────────────────────┐
│  Script (modules/script.js)  ──── extends ──── ▶  AbstractScript │
│                                                                  │
│   ├─ name / namespace / version / @* metadata                    │
│   ├─ includes / excludes / matches / userIncludes / …            │
│   ├─ requires :  ScriptRequire[]  (extends ScriptDependency)     │
│   ├─ resources:  ScriptResource[] (extends ScriptDependency)     │
│   ├─ icon    :  ScriptIcon       (extends ScriptDependency)      │
│   ├─ runAt / noframes / injectInto / grants                      │
│   └─ on-disk file in <profile>/gm_scripts/<id>/                  │
└────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                          Sandbox layer                                   │
│                                                                          │
│   modules/sandbox.js                                                     │
│     createSandbox(script, contentWindow)                                 │
│        │                                                                 │
│        ├── Cu.Sandbox                                                    │
│        ├── attaches GM_* native APIs (see §3.x)                          │
│        ├── attaches GM_log via miscApis.GM_ScriptLogger                  │
│        ├── exposes unsafeWindow + cloneInto helper                       │
│        └── builds GM.* surface  ← Phase 7: native, not eval-string       │
│                                                                          │
│   Native API providers attached to the sandbox global:                   │
│     · GM_setValue/getValue/deleteValue/listValues  — storageBack.js      │
│     · GM_xmlhttpRequest — xmlHttpRequester.js                            │
│     · GM_addStyle / GM_addElement / GM_log /                             │
│       GM_getResourceText/URL — miscApis.js                               │
│     · GM_openInTab — GM_openInTab.js                                     │
│     · GM_setClipboard — GM_setClipboard.js                               │
│     · GM_notification — notificationer.js                                │
│     · GM_registerMenuCommand — menuCommand.js (MenuCommandSandbox)       │
│     · GM_cookie — modules/thirdParty/GM_cookie.js (Phase 7: native)      │
│     · GM_download — modules/thirdParty/GM_download.js (Phase 7: native)  │
│     · GM_windowClose / GM_windowFocus — miscApis.js (fork-specific)      │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                         Persistence layer                                │
│                                                                          │
│   modules/storageBack.js   — per-script SQLite DB                        │
│       <profile>/gm_scripts/<id>.db, opened on demand, cached per service │
│   modules/prefManager.js   — GM_prefRoot wrapping nsIPrefBranch          │
│       extensions.greasemonkey.* prefs                                    │
│   content/config.js        — config.xml in <profile>/gm_scripts/         │
│       Script metadata + global excludes                                  │
└──────────────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────────────┐
│                            UI surfaces                                   │
│                                                                          │
│   Toolbar button + menu       — content/browser.{js,xul} overlay         │
│   about:addons integration    — content/addonsOverlay.{js,xul}           │
│                                  + modules/addons.js                     │
│   Per-script Options dialog   — content/scriptPrefs.{js,xul} (3.7.0)     │
│   Install dialog              — content/install.{js,xul}                 │
│   New-script dialog           — content/newScript.{js,xul}               │
│   Editor host (Scratchpad)    — content/scratchpadOverlay.{js,xul}       │
│                                  + modules/util/openInEditor.js          │
│   Backup / restore            — modules/backup.js (no UI of its own)     │
└──────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Startup sequence

```
1. UXP fires "profile-after-change"
        │
        ▼
2. components/greasemonkey.js → service.observe("profile-after-change")
        │
        ▼
3. startup(service):
     a. Load config.js + thirdParty/mplUtils.js via jsSubScriptLoader
     b. ◯ Register storage-IPC listeners on Services.mm        [Phase 4: drop]
     c. ◯ Register script-update listeners on Services.ppmm    [Phase 4: drop]
     d. ◯ loadFrameScript("chrome://greasemonkey/content/frameScript.js", true)
                                                                [Phase 4: drop]
     e. service.broadcastScriptUpdates()  → ipcScripts to content
                                                                [Phase 4: direct]
     f. AddonManager.getAddonByID → cache version, re-broadcast
     g. config.addObserver(broadcaster)   ← cludes/install/etc
     h. Cu.import requestObserver.js, responseObserver.js
     i. Services.obs.addObserver(service, "quit-application")
     j. Cu.import util/enqueueRemove.js  ← drains pending file deletes
        │
        ▼
4. service.config getter (lazy)
     ├─ new Config()
     ├─ config.initialize() reads config.xml from <profile>/gm_scripts/
     └─ Each <Script> XML node → Script instance (script.js)
        │
        ▼
5. UI overlays attach (browser.xul, about:addons via overlay registration)
        │
        ▼
6. Service is idle, waiting for navigations / install events / UI commands
```

Items marked **◯** are vestigial-shape on UXP single-process — they self-message-loopback and Phase 4 collapses them into direct calls.

---

## 5. End-to-end flows

### 5.1 Script installation (drop or click .user.js URL)

```
User drags greatscript.user.js onto a tab
            OR
User clicks an https://example.com/foo.user.js link
            │
            ▼
HTTP load fires nsIObserver topic "http-on-modify-request"
            │
            ▼
modules/requestObserver.js (chrome)
            │
            ├─ regex-tests URL against .user.js extension
            ├─ if loadInfo says it's a top-level / subframe load → keep going
            └─ aChannel.cancel() to suppress the navigation
            │
            ▼
GM_util.showInstallDialog(aUrl, aBrowser)
   (modules/util/showInstallDialog.js)
            │
            ▼
chrome://greasemonkey/content/install.xul opens
   (window.arguments = { gRemoteScript, gBrowser, gScript })
            │
            ▼
RemoteScript download (modules/remoteScript.js)
            │
            ├─ tempDir = GM_util.getTempDir()
            ├─ fetch script body → tempDir/<id>.user.js
            ├─ fetch each @require → tempDir
            ├─ fetch each @resource → tempDir
            ├─ fetch @icon → tempDir
            └─ parse via modules/parseScript.js → tempScript (Script)
            │
            ▼
User clicks "Install" in install.xul
            │
            ▼
remoteScript.install():
   ├─ scriptDir = <profile>/gm_scripts/<id>/
   ├─ rename tempDir contents into scriptDir
   ├─ config.installIsUpdate ? config._scriptChanged : config.install
   ├─ config.xml rewritten via config._save()
   └─ AddonManager fires onInstalled / onPropertyChanged
            │
            ▼
about:addons row appears (via addonsOverlay observer
   subscribed to config events; see §6.2)
            │
            ▼
service.broadcastScriptUpdates() refreshes the live IPCScript
   list so subsequent navigations match against the new script
   [Phase 4: this becomes a single in-process fan-out]
```

### 5.2 Page-navigation script injection

This is the hot path. It runs every time a content document loads.

```
Browser navigates to https://example.com/page
            │
            ▼
DOMWindowCreated fires on the chrome window's docShell
            │
            ▼
modules/documentObserver.js (subscribed in chrome scope)
   contentObserver.observe(content, "content-document-global-created")
   onNewDocument(contentWindow, observer)
            │
            ▼
For each Script in service.config.scripts:
   ├─ matchesURL(contentWindow.location.href)
   │     ↳ uses MatchPattern (modules/thirdParty/matchPattern.js)
   │     ↳ honors @match / @include / @exclude / userIncludes / userMatches /
   │       userExcludes / config._globalExcludes / userOverride
   ├─ check script.enabled
   ├─ check @noframes (skip if iframe and noframes set)
   ├─ check script.runAt → schedule or run now
   │     ↳ document-start  → run immediately on DOMWindowCreated
   │     ↳ document-body   → run on first <body> insertion
   │     ↳ document-end    → run on DOMContentLoaded
   │     ↳ document-idle   → run after DOMContentLoaded + microtask
   │
   ▼
modules/sandbox.js → createSandbox(script, contentWindow)
   ├─ sandbox = new Cu.Sandbox(systemPrincipal, {sandboxPrototype: contentWindow})
   ├─ attach GM_info object
   ├─ attach every native GM_* API (closure bound to this sandbox)
   ├─ load each @require body via Cu.evalInSandbox
   ├─ if api.object.polyfill → evalAPI2Polyfill builds GM.*
   │     ↳ Phase 7: replace with chrome-side GM object exported via
   │       Cu.exportFunction; preserves real stack traces.
   └─ runScriptInSandbox(script, sandbox)
         → Cu.evalInSandbox(scriptBody, sandbox, JS_VERSION_MAX, fileURL, 1)
            │
            ▼
Errors → GM_util.logError → nsIScriptError → Browser Console
```

**[Phase 4 note]** Today, steps 2 and 3 (DOMWindowCreated → documentObserver)
fire inside the content scope of `content/frameScript.js` rather than in
chrome scope. On UXP single-process the two scopes are the same JS runtime,
so Phase 4 inlines the observer chrome-side and deletes the framescript.

### 5.3 Storage round-trip — `GM_setValue` / `GM_getValue`

```
Script:  GM_setValue("foo", 42);
            │
            ▼
sandbox-attached GM_setValue (closure over Script)
   → modules/storageBack.js  setValue(key, value)
            │
            ▼
SQLite operation:
   ├─ openDatabase(<profile>/gm_scripts/<id>.db)  on first access
   ├─ INSERT OR REPLACE INTO scriptvals(name, value) VALUES (?, JSON.stringify(?))
   └─ db kept open until shutdown (closeAllScriptValStores at quit-application)
            │
            ▼
Notify any GM_addValueChangeListener subscribers
   ├─ Same script in another tab/frame → Services.obs.notifyObservers
   │       [today: cpmm broadcast greasemonkey:value-invalidate;
   │        Phase 4: direct Services.obs]
   └─ Subscriber callbacks fire on each interested sandbox
            │
            ▼
GM_getValue("foo") → SELECT value FROM scriptvals WHERE name = ?
   → JSON.parse on the stored blob → returns 42
```

**Storage layout decision (Phase 4 outcome):** today there is a
content-side `storageFront.js` that proxies to chrome-side `storageBack.js`
via `messageManager`. On UXP single-process both already run in the same
process. Phase 4 collapses front into back and the round-trip becomes a
direct method call. The `addValueChangeListener` / `removeValueChangeListener`
GM4 surface and the in-memory value cache survive the merge.

### 5.4 `GM_xmlhttpRequest`

```
Script:  GM_xmlhttpRequest({ url, method, headers, onload, … })
            │
            ▼
modules/xmlHttpRequester.js (chrome-scope, attached to sandbox)
            │
            ├─ enforce @connect whitelist (GM4-compat with Violentmonkey)
            ├─ instantiate XMLHttpRequest (Cu.importGlobalProperties)
            ├─ enforce mozAnon / mozSystem / private-browsing flags
            │     based on script's grants and tab's privacy state
            ├─ wire upload/download progress events via Cu.cloneInto
            └─ xhr.send(body)
            │
            ▼
Response:
   ├─ readyState 2 → onreadystatechange fires onresponseheaders
   ├─ readyState 4 → onload / onerror / ontimeout / onabort
   └─ response object cloned-into the sandbox so script JS can read it
```

`@connect` is enforced both in the request URL (top frame must be in the
whitelist or the script's own host) and host header. This matches
Violentmonkey's behaviour and what scripts in the wild expect.

### 5.5 Menu commands — `GM_registerMenuCommand`

```
Script:  GM_registerMenuCommand("Toggle X", toggleX);
            │
            ▼
sandbox attaches via menuCommand.js → MenuCommandSandbox.register
   → keeps a {scriptId, name, callback, accessKey} record per sandbox
            │
            ▼
User opens the chrome-side context menu (toolbar button or right-click)
            │
            ▼
content/menuCommander.js (chrome) populates the popup
   ├─ collects records for every sandbox attached to the active tab
   ├─ adds <menuitem oncommand="run(name)"> for each
   │       [today: round-trip via Services.ppmm; Phase 4: direct call]
   └─ user clicks → MenuCommandRun → invokes the original sandbox callback
        with `event` + `accessKey` arg
```

### 5.6 `GM_openInTab`

```
Script:  GM_openInTab("https://example.com", { active: true, insert: true });
            │
            ▼
modules/GM_openInTab.js (chrome-scope, sandbox-attached)
            │
            ├─ resolve URL via GM_CONSTANTS.ioService.newURI
            ├─ get most-recent navigator:browser window
            └─ gBrowser.addTab(url, { … })
                  [today: aFrame.sendAsyncMessage detour;
                   Phase 4: direct addTab call]
            │
            ▼
Returns a thin tab-handle to the script with .close() / .onclose
```

---

## 6. UI surfaces

### 6.1 Toolbar button + Tools menu

`content/browser.{js,xul}` overlays `chrome://browser/content/browser.xul`.
Provides:

- The Greasemonkey toolbar button (cycles enabled/disabled, opens menu).
- The Tools-menu Greasemonkey submenu (script list with execution-order
  hover, "New User Script…", "Manage User Scripts…" → about:addons).
- The XBL-bound `<greasemonkey-tbb>` toolbar-button popup
  (`content/bindings.xml#greasemonkey-tbb`).

### 6.2 about:addons integration

The fork piggy-backs on the platform's add-ons manager rather than building
its own list view.

```
about:addons opens
       │
       ▼
chrome.manifest declares an overlay onto the AOM XUL
       │
       ▼
content/addonsOverlay.xul + content/addons.xul + content/thirdParty/addons.css
   inject:
   ├─ Greasemonkey category in the left rail
   ├─ Custom #greasemonkey-sort-bar (sort buttons + new/import/export +
   │     live-search box, added in 3.7.0)
   ├─ Per-row context menu (edit, show folder, exec-order, find updates)
   ├─ Detail-pane buttons:
   │     ├─ #gm-detail-prefs-btn → opens scriptPrefs dialog
   │     │     (works for disabled scripts; bypasses AOM's gating)
   │     └─ #gm-detail-edit-btn → opens script in configured editor
   └─ A list-empty state with "get user scripts" + "new" links

modules/addons.js:
   ├─ ScriptAddonFactoryByScript(script) → returns AOM-shaped addon object
   ├─ Bridges service.config events to AddonManager listeners
   └─ Handles install/uninstall via the AOM API contract
```

### 6.3 Per-script Options dialog (3.7.0 redesign)

`content/scriptPrefs.{js,xul}` opens as a modeless chrome window. Tabs:

- **Settings** — Metadata (read-only, copy-able), Behavior (run-at,
  noframes, inject-into, auto-update, execution-position spinner),
  Pages (user vs. script-declared @match/@include/@exclude with
  per-list counters and tooltips on long patterns), Permissions
  (grants, connects, requires, resources, antifeatures).
- **Values** — full GM_setValue browser with Add / Edit / Delete.

Window size is persisted via `GM_prefRoot` (shared across all scripts) so
the dialog opens at the same size for every script.

### 6.4 Install dialog

`content/install.{js,xul}` opens before any user-script is committed to
disk. Drives the RemoteScript download in the background, shows progress
+ metadata + scope (matches/includes/excludes) + grants. Cancel discards
the temp directory.

### 6.5 New-script dialog

`content/newScript.{js,xul}` is the "create from scratch" flow. Currently
prompts for `@name`, `@namespace`, `@includes`, `@excludes` BEFORE opening
the editor — a 2005-era artefact from when those values were used to pick
the script's on-disk path. Since the fork now uses synthetic IDs, this
prompt is decorative; a future change will skip it and open the editor
directly with a templated `// ==UserScript==` header (parity with modern
Greasemonkey 4 / Violentmonkey).

### 6.6 Editor host

User scripts open in the user's configured editor. Default: **Pale Moon /
Basilisk built-in Scratchpad**, via `content/scratchpadOverlay.{js,xul}`
which hides the Run/Inspect/Eval menu items on user-script files (so the
editor isn't a code-execution trap).

`extensions.greasemonkey.editor` can be set to any external executable;
`util/setEditor.js` provides the file picker.

### 6.7 Backup / restore

`modules/backup.js` exports `GM_BackupExport` / `GM_BackupImport`. ZIP-based
(`nsIZipWriter` / `nsIZipReader`). Includes script files, config metadata,
and (optionally) the per-script SQLite stores.

---

## 7. Data model

### 7.1 The Script class

Defined in `modules/script.js`. Fields (subset):

| Field | Type | Source |
|-------|------|--------|
| `id` | string | derived from `@namespace` + `@name` (synthetic UUID for new scripts) |
| `name`, `namespace`, `version`, `description`, `author`, `homepageURL`, `supportURL`, `updateURL`, `downloadURL` | string | metadata block |
| `localized.name`, `localized.description` | string | from `@name:xx-YY` / `@description:xx-YY` matched via `getBestLocaleMatch` |
| `runAt` | one of `document-start` / `document-body` / `document-end` / `document-idle` | metadata or default |
| `noframes` | boolean | `@noframes` |
| `injectInto` | one of `auto` / `page` / `content` | `@inject-into` |
| `enabled` | boolean | persisted in config.xml |
| `userOverride` | boolean | maintainer-only-rules toggle |
| `includes` / `excludes` / `matches` | string[] / MatchPattern[] | from metadata |
| `userIncludes` / `userExcludes` / `userMatches` | same | from per-script Options dialog |
| `requires` | ScriptRequire[] | each has its own downloadURL + on-disk file |
| `resources` | ScriptResource[] | each has name + downloadURL + on-disk file |
| `icon` | ScriptIcon | optional `@icon` |
| `grants` | string[] | `@grant` lines, deduped |
| `connects` | string[] | `@connect` lines |
| `checkRemoteUpdates` | one of AUTOUPDATE_DEFAULT/_ENABLE/_DISABLE | `@updateURL` + per-script setting |
| `executionIndex` | int | position in `config.scripts` array |
| `installTime`, `modifiedTime` | ms-since-epoch | timestamps |
| `file` | nsIFile | `<profile>/gm_scripts/<id>/<id>.user.js` |
| `fileURL` | string | `file://` URI of the above |

### 7.2 IPCScript

A frozen, serialised mirror of Script. Today it crosses processes; on UXP
single-process it's just an immutable read-only descriptor passed to
sandboxes and consumers that should never mutate the script. **Phase 4 may
fold this into Script directly** if no consumer relies on the freeze
semantics — TBD during execution.

### 7.3 Dependencies

`ScriptDependency` (base) → `ScriptIcon`, `ScriptRequire`, `ScriptResource`.
Each holds:

- `name` (resources only)
- `downloadURL` (the original `@require` / `@resource` / `@icon` URL)
- on-disk filename (in the script's directory)
- helper to read the local copy + its data URL form

### 7.4 RemoteScript

The download/install state machine. Used during script install AND auto-update.
Holds the *would-be* Script while files are downloaded into a temp directory;
on user "Install" confirmation, atomically renames temp → permanent and
hands ownership to Config.

---

## 8. Configuration & persistence

### 8.1 `config.xml`

Lives in `<profile>/gm_scripts/config.xml`. Holds:

- Every Script's metadata (`<Script id="…">…</Script>`)
- Global excludes (URL patterns the user never wants user scripts on)
- Per-script user-override patterns
- Execution order

Loaded by `content/config.js` `Config.initialize()`. Saved via `Config._save()`
on every mutation event (debounced).

### 8.2 Per-script SQLite (`<id>.db`)

Each script has its own SQLite DB at `<profile>/gm_scripts/<id>.db`.
Single table:

```
scriptvals (
  name  TEXT PRIMARY KEY,
  value TEXT NOT NULL  -- JSON.stringify-encoded
)
```

Opened on first `GM_setValue` / `GM_getValue` call, cached for the
service lifetime, closed at `quit-application`.

PRAGMA tuning is applied (see `storageBack.js` for the journal-mode and
synchronous-level settings).

### 8.3 Preferences (`extensions.greasemonkey.*`)

Wrapped by `modules/prefManager.js` → `GM_prefRoot`. Supports
boolean / string / 32-bit integer values. Defaults declared in
`defaults/preferences/greasemonkey.js`.

Notable prefs:

| Pref | Default | Effect |
|------|---------|--------|
| `api.object.polyfill` | true | Builds GM.* polyfill in every sandbox |
| `api.GM_cookie` | false | Gates the third-party `GM_cookie` polyfill (Phase 7: native, default true) |
| `cors_override` / `csp_override` | false | Lets scripts override response headers |
| `editor` | (unset) | Path to external editor; unset → Scratchpad |
| `editor.type` | n/a | Window mode for external editor |
| `sortBy` | `uiState,name` | about:addons GM tab sort order |
| `scriptPrefs.windowWidth` / `windowHeight` | 720 / 720 | Per-script Options dialog size (3.7.0) |

---

## 9. Glossary

| Term | Meaning |
|------|---------|
| **AOM** | Add-ons Manager — Pale Moon's `about:addons` page |
| **chrome / content** | XPCOM scopes. On UXP single-process they share a JS runtime. |
| **cpmm / ppmm / mm** | child / parent / global process message manager — pre-UXP IPC plumbing. Vestigial on single-process UXP. |
| **framescript** | A JS file `loadFrameScript`-loaded into each content process. Era-2 artefact; Phase 4 removes ours. |
| **GM3 / GM4** | Greasemonkey 3 (synchronous `GM_*`) vs 4 (Promise-based `GM.*`). The fork supports both natively. |
| **IPCScript** | Read-only descriptor wrapping a Script. Today crosses processes; on UXP it's just a frozen view. |
| **JSM** | JavaScript module loaded via `Cu.import` from a `chrome://greasemonkey-modules/…` URL. The fork's main module type. |
| **MatchPattern** | Mozilla's `@match` URL pattern matcher (`modules/thirdParty/matchPattern.js`). |
| **sandbox** | `Cu.Sandbox` instance per (script × content window). Where user-script JS actually runs. |
| **Scratchpad** | Pale Moon / Basilisk built-in JS editor. The default user-script editor for the fork. |
| **UXP** | Unified XUL Platform — the runtime under Pale Moon and Basilisk. Single-process, XUL/XPCOM-native. |
| **XBL** | XML Binding Language — legacy binding system attached via `-moz-binding` CSS. Used by the cludes editor and toolbar button popup. |

---

## 10. Where the cleanup work changes this picture

Read this section as "what each later phase modifies in the diagrams above."

| Phase | Effect on the architecture |
|-------|----------------------------|
| **4** | Frame-script entry deleted. `documentObserver` runs chrome-side directly. `storageFront → storageBack` collapsed. All `messageManager` IPC sites become direct calls. The diagrams' `[Phase 4: …]` footnotes resolve. **Behavior unchanged.** |
| **5** | `GM_util.getService()` → direct module export. Polyfill helpers (`hitch`, `inArray`, …) replaced by ES2015+ natives. Dead files (`windowIdForEvent.js`, `icon16Disabled.png`) removed. **Behavior unchanged.** |
| **6** | Small XBL bindings, if any, converted to anonymous content + JS. The cludes editor binding stays (it earns its weight). **Behavior unchanged.** |
| **7** | `evalAPI2Polyfill` string-eval replaced by chrome-side `GM` object exported via `Cu.exportFunction`. Native `GM_cookie` (using `Services.cookies`). Native `GM_download` with `onprogress` and a real `saveAs` UI. Batched-SQL paths in `storageBack` for `GM_*Values`. **Behavior gains GM4 features and loses the polyfill cost.** |

After Phase 7, this document describes the running code one-to-one with no
"[Phase N: …]" footnotes left.
