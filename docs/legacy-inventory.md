# Legacy-code inventory — Greasemonkey for UXP

**Branch:** `cleanup/strip-legacy`
**Snapshot tag for rollback:** `v3.7.0-pre-cleanup`
**Date of pass:** Phase 1 of the legacy-cleanup roadmap.

---

## 1. Purpose

This document is the **source of truth** for the legacy-cleanup work. Every
file deletion, structural refactor, or polyfill replacement performed in
Phases 4 and later must point back to a row in one of the tables below.

The goal of the cleanup is to take a codebase that accumulated four eras of
Mozilla extension architecture (XPCOM → multi-process framescripts → JSM
singletons → abandoned WebExtensions prep) and shape it into a single-era,
UXP-native Pale Moon/Basilisk extension.

### What "UXP-native" means here

UXP (Pale Moon, Basilisk) is **single-process by design.** It supports XUL,
XBL, JSMs, and XPCOM components as first-class citizens. It does **not**
ship `chrome.webRequest` or any other WebExtensions surface. The minimum
supported platform target after this cleanup is Pale Moon 28+ / Basilisk
current — every compatibility branch for older versions is removed.

### Methodology

Twelve sub-agents in parallel each read an assigned slice of the source tree.
Each file got one of five tags with mandatory evidence:

| Tag | Definition | Evidence required |
|-----|-----------|-------------------|
| **LIVE** | Referenced by code currently exercised on UXP | At least one `file:line` reference to a real consumer |
| **VESTIGIAL** | Referenced but solves a problem UXP doesn't have (multi-process IPC, framescript marshalling, JSM-deprecation defenses, WebExt prep) | Reference + era reason |
| **DEAD** | No live references | Grep queries returning zero hits |
| **THIRD-PARTY** | Vendored upstream code | Origin attribution |
| **UNCLEAR** | Investigation budget exhausted | Flagged for follow-up rather than guessed |

No semantic search was used (per project rule). Every classification rests
on direct grep evidence.

### What this document is NOT

- Not a deletion list. It catalogs candidates; deletions happen in named later
  phases with explicit maintainer approval.
- Not a Phase 7 design doc. The GM4 gap section (§7) is the *backlog*, not
  the implementation plan.
- Not a refactor plan for LIVE files. Those happen per-phase; this document
  just labels them.

---

## 2. Summary

### By tag

| Tag | Count |
|-----|------:|
| LIVE | ~95 |
| LIVE-but-vestigial-shape (logic kept, plumbing dead) | 9 |
| VESTIGIAL (delete in Phase 4 or 5) | 4 |
| DEAD candidates (delete after final confirmation) | 2 confirmed, more investigative |
| THIRD-PARTY | 9 |
| UNCLEAR | 0 |

### By area

| Area | Files |
|------|------:|
| `content/` (XUL + chrome JS) | 22 |
| `modules/` (top-level JSMs) | 33 |
| `modules/util/` (small helpers) | 43 |
| `modules/thirdParty/` | 6 |
| `components/` | 1 |
| `defaults/` | 1 |
| `skin/` | 12 |
| `locale/` (33 languages) | 204 |

Locale files are not individually catalogued. They are gardened atomically
by entity name (per existing project workflow) and are out of scope for the
legacy strip.

---

## 3. The framescript era — confirmed and mapped

This is the largest single architectural cleanup. UXP is **single-process**;
the chrome process and the content process are the same process. Every byte
of `messageManager` / framescript / cpmm / ppmm plumbing is a self-message
round trip with no benefit.

### 3.1 Entry point

**`content/frameScript.js`** is loaded by
`components/greasemonkey.js:83-84`:

```js
Services.mm.loadFrameScript("chrome://greasemonkey/content/frameScript.js", true);
```

The `true` flag remembers the framescript for future tabs. The framescript
registers six `addMessageListener` handlers and emits messages back to
chrome on five topics. **Every one of these is unnecessary on UXP.**

### 3.2 The IPC topics in flight

| Topic | Originator | Handler | UXP equivalent |
|-------|-----------|---------|----------------|
| `greasemonkey:scripts-update` | `components/greasemonkey.js:185,189` (`broadcastScriptUpdates`) | `modules/ipcScript.js:277,279,283-286` | Direct call to `scriptUpdateData()`; emit via `Services.obs` if multiple subscribers |
| `greasemonkey:frame-urls` | (was: `content/browser.js`) | (was: `modules/processScript.js`) | **DONE (4f-3):** `urlsOfAllFrames` in `modules/scriptInjector.js`, called directly |
| `greasemonkey:inject-delayed-script` | (was: `modules/script.js`) | (was: `frameScript.js`) | **DONE (4f-3):** `injectDelayedScript` in `modules/scriptInjector.js`, called directly |
| `greasemonkey:menu-command-list` | (was: `content/menuCommander.js`) | (was: `frameScript.js` → `modules/menuCommand.js`) | **DONE (pre-Phase-4f-3):** chrome-side custom-event dispatch (`greasemonkey-menu-command-list-<suffix>`) |
| `greasemonkey:menu-command-run` | (was: `content/menuCommander.js`) | (was: `frameScript.js`) | **DONE (pre-Phase-4f-3):** chrome-side custom-event dispatch |
| `greasemonkey:context-menu-start/end` | (was: `frameScript.js` ↔ chrome) | n/a | **DONE (4f-3):** chrome walks `parentNode` directly in `getUserScriptUrlUnderPointer` |
| `greasemonkey:newscript-load-start/end` | (was: `content/newScript.js` ↔ `frameScript.js`) | n/a | **DONE (pre-Phase-4f-3):** chrome reads `gBrowser.selectedBrowser.contentWindow.location.href` directly |
| `greasemonkey:tab-closed` | (was: `gBrowser` events) | (was: `frameScript.js`) | **DONE (4f-3):** `TabClose` listener calls `GM_tabClosed(tabId)` directly |
| `greasemonkey:url-is-temp-file` (sync) | `installPolicy.js → cpmm` | chrome service | Direct call |
| `greasemonkey:script-install` | `installPolicy.js → cpmm` | chrome service | Direct call |
| `greasemonkey:value-invalidate` | `storageBack` → cpmm broadcast | `storageFront.js` | `Services.obs.notifyObservers` |
| `greasemonkey:scriptVal-{get,set,delete,list}` | `storageFront.js → mm` | `storageBack.js` (parent) | Direct method calls; storageFront collapses into storageBack |
| `greasemonkey:open-in-tab` / `:tab-close` | `modules/GM_openInTab.js → frame.sendAsyncMessage` | `frameScript.js` → chrome | Direct call to `gBrowser.addTab()` |
| `greasemonkey:broadcast-script-updates` | `content/options.js:88` (cpmm.sendAsyncMessage) | service singleton | Direct call |

### 3.3 Files that die with the framescript

| File | Disposition | Notes |
|------|------------|-------|
| `content/frameScript.js` | **Inline its logic into chrome-side observers**, then delete the file | The DOMContentLoaded / DOMWindowCreated observers move to a chrome-side `documentObserver` consumer |
| `modules/processScript.js` | **Delete** — only consumer is `frameScript.js` | Tiny file; carries `installPolicy` registration (move to chrome startup) and the `frame-urls` request handler (move to `browser.js` as a docshell walk) |
| `modules/storageFront.js` | **Collapse into `storageBack.js`** | Keep the value-cache + change-listener machinery; drop `_messageManager` and the four `sendRpcMessage` calls. Preserves the `addValueChangeListener` / `removeValueChangeListener` GM4 surface. |
| `modules/ipcScript.js` (the IPC bootstrap, not the class) | **Drop the freeze/serialise/cpmm setup at lines 274-286**; keep the `IPCScript` descriptor class itself | The class is consumed across content code; on UXP it can be re-pointed at `Script` directly, but that touches every consumer (sandbox.js, miscApis.js, storageFront/Back, scriptProtocol, frameScript). Phase the migration. |

### 3.4 Files whose IPC sites become direct calls (logic LIVE)

These survive — their *plumbing* is rewritten in place:

| File | IPC sites to flatten | Phase |
|------|----------------------|-------|
| `content/browser.js` | 4 × `window.messageManager.addMessageListener` (lines 45-74) + `frame-urls` requesters (483-490, 729-736) | Phase 4 |
| `content/menuCommander.js` | `Services.ppmm.addMessageListener` + `gBrowser.selectedBrowser.messageManager.sendAsyncMessage` for menu-command list/run/response | Phase 4 |
| `content/newScript.js` | `messageManager.sendAsyncMessage("greasemonkey:newscript-load-start")` (lines 39-52) | Phase 4 |
| `content/options.js` | `Services.cpmm.sendAsyncMessage("greasemonkey:broadcast-script-updates")` (line 88) | Phase 4 |
| `modules/menuCommand.js` | `Services.cpmm.sendAsyncMessage` self-loopback | Phase 4 |
| `modules/installPolicy.js` | `Services.cpmm.sendSyncMessage` + `sendAsyncMessage` for url-is-temp-file / script-install | Phase 4 |
| `modules/GM_openInTab.js` | `aFrame.sendAsyncMessage("greasemonkey:open-in-tab"/":tab-close")` | Phase 4 |
| `components/greasemonkey.js` | `loadFrameScript` line itself + `broadcastScriptUpdates` ppmm | Phase 4 (last cut) |

### 3.5 Migration cost (Agent B2's estimate)

| Module | Cost | Rationale |
|--------|------|-----------|
| `processScript.js` | **Low** | Tiny; one chrome-side caller pair |
| `storageFront → storageBack` collapse | **Low–medium** | Method calls already exist on the back; remove the IPC plumbing only |
| `ipcScript.js` IPC strip (keep class) | **Medium** | Touches ~6 consumers; requires care with the `Object.freeze` semantics some callers may rely on |
| `frameScript.js` inline | **Medium** | Pure DOM/observer logic; the friction is replacing the implicit `content` / `gScope` magics with explicit window lookups |
| All `messageManager` IPC sites flattened | **Low individually, additive** | One-by-one is safe; smoke-test set must catch regressions |

---

## 4. The polyfill era — UXP ships the natives

UXP runs modern SpiderMonkey. Every polyfill below has a native replacement
already available in the engine.

| Helper | Purpose | Call sites | Replacement | Phase |
|--------|---------|-----------:|-------------|------:|
| `modules/util/hitch.js` | `Function.prototype.bind` polyfill (Fx 2-3 era) | **51 across 9 files** (sandbox.js ×22, remoteScript.js ×7, script.js ×5, …) | `obj.method.bind(obj, …)` | Phase 5 |
| `modules/util/inArray.js` | `Array.prototype.includes` polyfill (pre-ES2016) | **61 across 6 files** (sandbox.js ×52) | `Array.prototype.includes` (with case-fold helper for `inArray(x, arr, true)` callers) | Phase 5 |
| `modules/util/emptyElm.js` | `Element.replaceChildren` polyfill | 2 (`menuCommander.js`) | `el.replaceChildren()` or `el.textContent = ""` | Phase 5 |
| `modules/util/uuid.js` | Brace-stripping wrapper around `nsIUUIDGenerator` | small | `Services.uuid.generateUUID().toString().slice(1, -1)` — or keep, no big win | Phase 5 (optional) |
| `modules/util/timeout.js` | `nsITimer` + anti-GC observer (bug 647998 era) | small | `Timer.jsm` `setTimeout` (modern, the GC dance is moot) | Phase 5 |
| `sandbox.js → evalAPI2Polyfill` | Generates GM.* Promise wrappers via runtime string eval | every script | Real `GM` object built chrome-side, exported via `Cu.exportFunction` / `Cu.cloneInto` | Phase 7 |

`hitch` and `inArray` together cover **~110 call sites in 9 files**. Recommended
order:

1. **Sandbox first** (`hitch` ×22, `inArray` ×52). Smoke tests run after each.
2. **`script.js`, `remoteScript.js`** — high-traffic core.
3. **Everything else** in one sweep.

---

## 5. Dead-fallback branches inside otherwise-LIVE files

With the maintainer-confirmed minimum target of **Pale Moon 28+ / Basilisk
current**, these branches are unreachable:

| File | Dead branch | Approx. LOC saved |
|------|-------------|------------------:|
| `modules/responseObserver.js` | WebExtensions `chrome.webRequest.onHeadersReceived` fallback (lines 1102-1124) + `addonType==1` branches throughout | ~30% of the 1124-line file |
| `modules/GM_notification.js` | Pale Moon ≤27.5 compat (lines 104-110, 123-148) — `learnMoreURL` is universally supported on 27.6+ | ~25 LOC |
| `modules/xmlHttpRequester.js` | Pale Moon 27.2 `mozAnon` compat (PR #968) | small |
| `modules/util/getChannelFromUri.js` | `newChannelFromURI` (pre-Fx 48) vs `newChannelFromURI2` branch | half the file |
| `modules/util/getPreferredLocale.js` | Fx 54 `mozIOSPreferences` fallback | one branch |
| `modules/util/openInEditor.js` | 4 nested `Cu.import` paths for Scratchpad across Fx era moves | 3 of 4 fallback `try/catch` blocks |
| `chrome.manifest` lines 16, 17 | Two Firefox-appID overlay registrations (`{ec8030f7-c20a-464f-9b0e-13a3a9e97384}`) — never match under UXP | 2 lines |

**Decision recorded (point 5 of maintainer Q&A):** these will be removed in a
single Phase 4 sub-batch under the rule "hard floor: Pale Moon 28+ /
Basilisk current."

---

## 6. Confirmed DEAD files

| Path | Evidence | Pre-deletion check |
|------|----------|-------------------|
| `modules/util/windowIdForEvent.js` | Lazy-registered in `modules/util.js` but **zero callers** in repo for `GM_util.windowIdForEvent` | One final wider grep before Phase 5 deletion |
| `skin/icon16Disabled.png` | No literal grep match anywhere in repo | Check for dynamic name construction (`+ "Disabled.png"`, template strings) before delete |

### Inline-candidates (LIVE but trivial)

Not deletions — refactor opportunities flagged for the cleanup style pass:

- `modules/util/setEnabled.js` — single-line pref setter; could be inlined at
  its 1-2 call sites. Low priority.
- `modules/util/uuid.js` — see §4. Optional.

---

## 7. GM4 API gap report (Phase 7 backlog)

Cross-checked against Violentmonkey 2.35.1 (`src/injected/web/gm-api.js`).
The fork's stated goal is **GM3 + GM4 native support, both callable, both
differentiable**. Today every GM.* method is a runtime-eval Promise wrapper
over GM_*; Phase 7 turns that into a properly-bound chrome-side native build.

### 7.1 Implemented natively (GM_* and GM.* via polyfill)

| API | Native impl |
|-----|-------------|
| `GM_info` / `GM.info` | `sandbox.js:500, 662` |
| `GM_addElement` / `GM.addElement` | `miscApis.js:142` |
| `GM_addStyle` / `GM.addStyle` | `miscApis.js:68` |
| `GM_log` / `GM.log` | `miscApis.js` (`GM_ScriptLogger`) |
| `GM_getResourceText` / `GM.getResourceText` | `miscApis.js` (`GM_Resources`) |
| `GM_getResourceURL` / `GM.getResourceUrl` | `miscApis.js` (`GM_Resources`) |
| `GM_setValue` / `GM.setValue` | `storageBack.js:136` |
| `GM_getValue` / `GM.getValue` | `storageBack.js:164` |
| `GM_deleteValue` / `GM.deleteValue` | `storageBack.js:190` |
| `GM_listValues` / `GM.listValues` | `storageBack.js:208` |
| `GM_getValues` / `GM.getValues` | `storageFront.js:376` (front-side loop) |
| `GM_setValues` / `GM.setValues` | `storageFront.js:402` (front-side loop) |
| `GM_deleteValues` / `GM.deleteValues` | `storageFront.js:417` (front-side loop) |
| `GM_addValueChangeListener` / `GM.addValueChangeListener` | `storageFront.js:435` |
| `GM_removeValueChangeListener` / `GM.removeValueChangeListener` | `storageFront.js:461` |
| `GM_xmlhttpRequest` / `GM.xmlHttpRequest` | `xmlHttpRequester.js` (full surface) |
| `GM_openInTab` / `GM.openInTab` | `GM_openInTab.js` |
| `GM_setClipboard` / `GM.setClipboard` | `GM_setClipboard.js` |
| `GM_notification` / `GM.notification` | `notificationer.js` (NOT `GM_notification.js` — that's internal popups) |
| `GM_registerMenuCommand` / `GM.registerMenuCommand` | `menuCommand.js` |
| `GM_unregisterMenuCommand` / `GM.unregisterMenuCommand` | `menuCommand.js` |

### 7.2 Polyfill-only (Phase 7 work: build native chrome-side)

| API | Current shape | Phase 7 plan |
|-----|---------------|--------------|
| `GM_cookie` / `GM.cookie` | `modules/thirdParty/GM_cookie.js`, gated by `api.GM_cookie` pref (default false) | **Native chrome-side implementation using `Services.cookies` (`nsICookieManager`).** Mirror Violentmonkey's `gmCookieInvoker`. Drop the third-party polyfill. Default the pref true once native lands. (Maintainer Q&A point 6.) |
| `GM_download` / `GM.download` | **DONE (Phase 7c):** `modules/GM_download.js`, native chrome-side callable on `nsIWebBrowserPersist` + `nsIFilePicker`. Honours `details.saveAs` and `browser.download.useDownloadDir`. Drops the implicit `GM_xmlhttpRequest` auto-inject. Gated by `api.GM_download` (default true). | — |
| `GM.*` uniformly | Generated by `evalAPI2Polyfill` runtime string eval | Real `GM` object built chrome-side; methods exported via `Cu.exportFunction`. Stack traces become readable; per-script eval cost goes to zero. |
| `GM_getValues/setValues/deleteValues` | Front-side loop over single-key API | Add batched-SQL paths to `storageBack.js` once front/back are unified (Phase 4 storage collapse). |

### 7.3 Fork-specific extensions (kept intentionally — maintainer decision)

These are **not** in GM3, GM4, or Tampermonkey/Violentmonkey. They exist
because earlier maintainers added them and scripts in the wild may rely on
them. The fork's policy is to **support both GM3 and GM4 natively**; these
are additive and harmless.

| API | Where | Note |
|-----|-------|------|
| `GM_windowClose` / `GM.windowClose` | `miscApis.js → GM_window` | Closes the host browser window. Useful for sandboxed-context scripts where `window.close()` is blocked. **Keep.** |
| `GM_windowFocus` / `GM.windowFocus` | `miscApis.js → GM_window` | Focuses the host browser window. **Keep.** |

Future contributors should NOT remove these without an explicit
deprecation cycle.

### 7.4 Genuinely missing (Tampermonkey-only, NOT planned)

- `GM_getTab` / `GM_saveTab` / `GM_getTabs` — not in VM either; Tampermonkey-only.
- `GM.fetch` — Tampermonkey extension; VM does not implement.

These are **out of scope** for the fork.

---

## 8. Per-area inventory tables

### 8.1 `content/` (chrome JS + XUL)

| Path | Tag | Era | Evidence | Action |
|------|-----|-----|----------|--------|
| content/addons.xul | LIVE | xpcom | overlay at chrome.manifest:12 onto browser.xul; defines `GM_OpenScriptsMgr` referenced from browser.xul:113 | keep |
| content/addonsOverlay.js | LIVE | xpcom | loaded by addonsOverlay.xul:24 | keep |
| content/addonsOverlay.xul | LIVE | xpcom | overlay at chrome.manifest:13 onto about:addons | keep |
| content/bindings.xml | LIVE | XBL | `-moz-binding` consumers in skin/browser.css:20 + skin/bindings.css | keep (XBL is UXP-supported; Phase 6 audit is cosmetic) |
| content/browser.js | LIVE-but-vestigial-shape | xpcom + e10s/IPC | `GM_BrowserUI` consumed throughout browser.xul; 4 messageManager IPC sites lines 45-74 | keep file, flatten IPC in Phase 4 |
| content/browser.xul | LIVE | xpcom | overlay at chrome.manifest:8 onto browser.xul | keep |
| content/closeWindow.xul | LIVE | xpcom | overlay at chrome.manifest:20-22 onto install/newScript/options dialogs; `GM_onClose` at install.js:223 | keep |
| content/config.js | LIVE | xpcom | imported via `Cu.import` at components/greasemonkey.js:51; instantiated at :160 | keep |
| content/frameScript.js | REMOVED (Phase 4f-3) | framescript | logic migrated to `modules/scriptInjector.js`; no longer loaded by anything | — |
| content/install.js | LIVE | XUL dialog | loaded by install.xul:32; opened from showInstallDialog.js:54 | keep |
| content/install.xul | LIVE | XUL dialog | overlay at chrome.manifest:20 | keep |
| content/menuCommander.js | LIVE-but-vestigial-shape | multi-process IPC | loaded by browser.xul:14; uses `Services.ppmm` + frame `messageManager` | keep file, flatten IPC in Phase 4 |
| content/newScript.js | LIVE-but-vestigial-shape | XUL dialog + IPC | dialog opened from newUserScript.js:33; lines 39-52 use `messageManager.sendAsyncMessage` just to read `content.location.href` | keep dialog, flatten the IPC bounce |
| content/newScript.xul | LIVE | XUL dialog | overlay at chrome.manifest:21 | keep |
| content/options.js | LIVE-but-vestigial-shape | XUL prefs + IPC | dialog opened at browser.js:352; line 88 uses `Services.cpmm.sendAsyncMessage` | keep dialog, flatten IPC line |
| content/options.xul | LIVE | XUL prefs | overlay at chrome.manifest:22 | keep |
| content/scratchpadOverlay.js | LIVE | xpcom + XUL overlay | chrome.manifest:16-19 overlays Scratchpad; openInEditor.js:59 calls `ScratchpadManager.openScratchpad` | keep; remove the 2 Firefox-appID overlay lines from chrome.manifest |
| content/scratchpadOverlay.xul | LIVE | xpcom + XUL overlay | trivial shim referenced by chrome.manifest overlays | keep |
| content/scriptPrefs.js | LIVE | jsm-singleton (current) | 3.7.0 redesign; opened from about:addons Preferences button | keep |
| content/scriptPrefs.xul | LIVE | xpcom/XUL | pairs with scriptPrefs.js | keep |
| content/thirdParty/addons.css | THIRD-PARTY (LIVE) | mozilla MPL/GPL/LGPL | loaded at addonsOverlay.xul:3 | keep |
| content/thirdParty/mplUtils.js | THIRD-PARTY (LIVE) | mozilla MPL (Blake Ross) | imported at components/greasemonkey.js:53 | keep |

### 8.2 `modules/` core

| Path | Tag | Era | Evidence | Action |
|------|-----|-----|----------|--------|
| modules/abstractScript.js | LIVE | core | imported by script.js + ipcScript.js:44; provides `matchesURL()` | keep (may fold into Script after IPC strip) |
| modules/addons.js | LIVE | core | EXPORTED_SYMBOLS consumed by addonsOverlay.js + script.js + remoteScript.js | keep |
| modules/backup.js | LIVE | core | `GM_BackupExport` / `GM_BackupImport` consumed by addonsOverlay.js | keep |
| modules/constants.js | LIVE | core | imported by 64 files | keep |
| modules/documentObserver.js | REMOVED (Phase 4f-3) | framescript indirection | sole consumer was frameScript.js; chrome-side `Services.obs` observers now live directly in `modules/scriptInjector.js` | — |
| modules/extractMeta.js | LIVE | core | `EXPORTED_SYMBOLS = ["extractMeta"]` consumed by parseScript.js + script.js + sandbox.js + frameScript.js + newScript.js | keep |
| modules/installPolicy.js | LIVE-but-vestigial-shape | multi-process | imported by processScript.js:43; uses `Services.cpmm.sendSyncMessage`/`sendAsyncMessage` | keep nsIContentPolicy core, drop cpmm sites in Phase 4 |
| modules/ipcScript.js | LIVE class, VESTIGIAL bootstrap | framescript / multi-process | imported by frameScript.js:21 + components/greasemonkey.js:20 + script.js:54 + scriptProtocol.js:46 | keep `IPCScript` class; drop IPC bootstrap lines 274-286 in Phase 4 |
| modules/processScript.js | REMOVED (Phase 4f-3) | framescript | installPolicy now imported directly by components/greasemonkey.js; `frame-urls` handler became `urlsOfAllFrames()` in scriptInjector.js called directly by content/browser.js | — |
| modules/sandbox.js | LIVE | jsm-singleton | exports `createSandbox` (Phase-4f-3: `aFrameScope` param dropped — only consumer was the framescript) + `runScriptInSandbox`; called from `modules/scriptInjector.js` | keep |
| modules/script.js | LIVE | jsm-singleton | canonical Script class; imported by config.js:15 + parseScript.js:52 + remoteScript.js:60 | keep |
| modules/sync.js | VESTIGIAL on UXP, KEPT for niche Pale Moon Sync | xpcom Weave/Sync | imported only by components/greasemonkey.js:24; self-aborts on missing `resource://services-sync/*` | **keep** (maintainer Q&A point 1) — module no-ops on platforms without Sync; preserves the option for niche Pale Moon Sync builds |
| modules/menuCommand.js | LIVE-but-vestigial-shape | UXP-adapted | imported by frameScript.js + sandbox.js + components/greasemonkey.js; uses `Services.cpmm.sendAsyncMessage` self-loopback | keep, collapse cpmm hop in Phase 4 |
| modules/miscApis.js | LIVE | mixed | imported by sandbox.js; provides addStyle/addElement/console/Resources/ScriptLogger/window | keep; verify `GM_console` export is consumed (possible dead export) |
| modules/notificationer.js | LIVE | australis-era | sandbox.js:83 imports; instantiated for `GM_notification` (sandbox.js:299-305) | keep |
| modules/parseScript.js | LIVE | core | exported `parse` consumed by script.js + remoteScript.js + backup.js + config.js + newScript.js + installScriptFromSource.js | keep |
| modules/prefManager.js | LIVE | foundational | `GM_prefRoot` referenced 158 times across 32 files | keep |
| modules/remoteScript.js | LIVE | install pipeline | consumed by script.js + addons.js + util/installScriptFromSource.js + showInstallDialog.js + browser.js + install.js + sync.js + backup.js | keep |
| modules/requestObserver.js | LIVE | xpcom | imported by components/greasemonkey.js:114; intercepts `.user.js` HTTP/S navigations | keep |
| modules/responseObserver.js | LIVE (with VESTIGIAL fallback) | xpcom + WE | imported by components/greasemonkey.js:115; XPCOM observer LIVE; WebExt fallback dead on UXP | **keep XPCOM path; delete WebExt fallback (lines 1102-1124 + addonType==1 branches)** in Phase 4 (maintainer Q&A point 2) |
| modules/scriptDependency.js | LIVE | core | base class for scriptIcon/scriptRequire/scriptResource | keep |
| modules/scriptIcon.js | LIVE | core | `new ScriptIcon(this)` at script.js:102; `instanceof` checks in remoteScript.js | keep |
| modules/scriptProtocol.js | LIVE | xpcom | imported by frameScript.js:25,572; implements `greasemonkey-script:` URI scheme via nsIProtocolHandler | keep |
| modules/scriptRequire.js | LIVE | core | constructed at parseScript.js:259 + script.js:799 | keep |
| modules/scriptResource.js | LIVE | core | constructed at parseScript.js:314 + script.js:804 | keep |
| modules/storageBack.js | LIVE | core | SQLite per-script storage; called from parent process | keep |
| modules/storageFront.js | VESTIGIAL | framescript era | uses `Services.cpmm` + `_messageManager.sendRpcMessage` for scriptVal-{get,set,delete,list} | **collapse into storageBack.js** in Phase 4; preserve value-cache + listener machinery |
| modules/GM_notification.js | LIVE | xul / Pale Moon ≤27.5 era | internal Greasemonkey popup (NOT script-facing GM_notification) | keep; drop PM 27.5 compat branch (lines 104-110, 123-148) |
| modules/GM_openInTab.js | LIVE-but-vestigial-shape | multi-process | uses `aFrame.sendAsyncMessage("greasemonkey:open-in-tab"/"tab-close")` | keep; replace IPC with direct `gBrowser.addTab` in Phase 4 |
| modules/GM_setClipboard.js | LIVE | scriptish lineage | pure XPCOM (`nsIClipboard`, `nsITransferable`); chrome-scope only | keep |
| modules/util.js | LIVE | core | 76 LOC; `XPCOMUtils.defineLazyModuleGetter` dispatch table for 43 helpers | keep; prune dead-helper rows after their files are deleted |
| modules/xmlHttpRequester.js | LIVE | modernized | implements `GM_xmlhttpRequest`; `@connect` whitelist; full GM4 surface | keep; drop PM 27.2 mozAnon compat branch |

### 8.3 `modules/util/` (small helpers)

Each helper is ~30-100 LOC; exported through `modules/util.js` lazy getters.

| Path | Tag | Era | Notes | Action |
|------|-----|-----|-------|--------|
| util/alert.js | LIVE | xpcom | nsIPromptService; 4 callers | keep |
| util/compareVersion.js | LIVE | xpcom | nsIVersionComparator | keep |
| util/emptyElm.js | VESTIGIAL polyfill | pre-replaceChildren | 2 callers in menuCommander | inline as `replaceChildren()` (Phase 5) |
| util/enqueueRemove.js | LIVE | xpcom | startup-drained queue (components/greasemonkey.js:120) | keep |
| util/fileXhr.js | LIVE | core | content-side `file://` fetch for @require/@resource bodies. **`xhr.open("open", aUrl, false)` at line 46 — flagged for investigation** (point 3 of maintainer Q&A); may be intentional UXP quirk or latent bug | keep + investigate the `"open"` verb |
| util/getBestLocaleMatch.js | LIVE | core | locale resolution for @name:xx | keep |
| util/getBinaryContents.js | LIVE | core | binary @resource read | keep |
| util/getBrowserWindow.js | LIVE (core) | xpcom | 14 calls across 8 files | keep |
| util/getChannelFromUri.js | VESTIGIAL (legacy-compat) | Fx pre-48/post-48 | branches `newChannelFromURI2` vs `newChannelFromURI` | drop pre-48 branch (Phase 4) |
| util/getContents.js | LIVE | core | heavy use via `GM_util.getContents` | keep |
| util/getEditor.js | LIVE | core | options.js + setEditor.js + openInEditor.js | keep |
| util/getEnabled.js | LIVE | xpcom | 8 calls across 7 files | keep |
| util/getEnvironment.js | LIVE (with vestigial payload) | australis | 2 callers (menuCommander.js); returns `e10s`/`sandboxContentLevel` (dead values on UXP) + OS flags | keep file, prune dead fields in Phase 5 |
| util/getPreferredLocale.js | VESTIGIAL (Fx 54 fallback) | Fx 54 split | try/catch fallback for `intl.locale.matchOS` + `mozIOSPreferences` | drop Fx 54 branch (Phase 4) |
| util/getScriptSource.js | LIVE | core | sandbox.js + sniffGrants.js | keep |
| util/getService.js | LIVE (indirection) | core | 16 files, 42 call sites; returns `GreasemonkeyService.wrappedJSObject` | **collapse in Phase 5** (one mechanical sweep replacing `GM_util.getService()` with a direct module export) |
| util/getTempDir.js | LIVE | core | remoteScript download staging | keep |
| util/getTempFile.js | LIVE | core | backup + remoteScript + installScriptFromSource | keep |
| util/getUriFromFile.js | LIVE | core | 7 callers | keep |
| util/getUriFromUrl.js | LIVE | core | 14 callers, memoized | keep |
| util/hash.js | LIVE | core | SHA-1 via nsICryptoHash, memoized; "kept for Sync backward compat" | keep |
| util/hitch.js | **VESTIGIAL polyfill** | pre-ES5 | 51 calls across 9 files (sandbox.js ×22) | **replace with `.bind()`** (Phase 5) |
| util/inArray.js | **VESTIGIAL polyfill** | pre-ES2016 | 61 calls (sandbox.js ×52); function already branches on `"includes" in Array.prototype` | **replace with `.includes()`** (Phase 5) |
| util/installScriptFromSource.js | LIVE | core | newScript flow + install paths | keep |
| util/isGreasemonkeyable.js | LIVE | core | windowId.js + scheme/pref gating | keep |
| util/logError.js | LIVE | xpcom | nsIScriptError + nsIConsoleService | keep |
| util/memoize.js | LIVE | core | uses non-standard `uneval()` (SpiderMonkey-only); fine on UXP | keep (optional `JSON.stringify` swap) |
| util/newUserScript.js | LIVE | xul | "New Script" dialog opener | keep |
| util/openInEditor.js | LIVE (with vestigial branches) | gm2-gm4 | 4 nested `try/catch` Scratchpad-import paths across Fx era moves | keep function; collapse to the one path that resolves on Pale Moon (Phase 4) |
| util/parseMetaLine.js | THIRD-PARTY | n/a | auto-generated by PEG.js 0.10.0 from .pegjs grammar | keep verbatim; regenerate from grammar if needed |
| util/scriptDir.js | LIVE | core | resolves scripts dir at module load | keep |
| util/scriptMatchesUrlAndRuns.js | LIVE | core | injection-path predicate | keep |
| util/setEditor.js | LIVE | core | filepicker for editor pref | keep |
| util/setEnabled.js | LIVE (inline-candidate) | core | one-line pref setter | keep, inline at call sites in Phase 5 |
| util/showInstallDialog.js | LIVE | core | drives install.xul | keep |
| util/sniffGrants.js | LIVE | gm4 | auto-grant via source string scan | keep |
| util/timeout.js | LIVE (vestigial paranoia) | gm2 | nsITimer + anti-GC observer (bug 647998 era) | keep or replace with `Timer.jsm` `setTimeout` (Phase 5, optional) |
| util/uuid.js | LIVE | gm2 | brace-stripping wrapper around `nsIUUIDGenerator` | keep (optional inline) |
| util/windowId.js | LIVE | gm2 e10s | now used by `modules/scriptInjector.js` for `IPCScript.scriptsForUrl` (Phase 4f-3 took over from frameScript.js); `outerWindowID` lookup is still useful for delayed-injection windowId matching | keep |
| util/windowIdForEvent.js | **DEAD candidate** | gm2 e10s | lazy-registered in util.js, **zero callers** | one final wider grep, then delete (Phase 5) |
| util/windowIsClosed.js | LIVE | core | frameScript + notificationer + xhr | keep |
| util/windowIsPrivate.js | LIVE | core | PrivateBrowsingUtils delegate | keep |
| util/writeToFile.js | LIVE | core | safe-file-output-stream + temp-then-move | keep |

### 8.4 `modules/thirdParty/` + `components/` + `defaults/`

| Path | Tag | Era | Action |
|------|-----|-----|--------|
| modules/thirdParty/matchPattern.js | THIRD-PARTY LIVE | Mozilla MPL 1.1 (Page Modifications) | keep |
| modules/thirdParty/convertToRegexp.js | THIRD-PARTY LIVE | Mozilla MPL 1.1 (DevTools HUD) | keep |
| modules/thirdParty/GM_download.js | REMOVED (Phase 7c) | UXP-era loadSubScript polyfill | replaced by `modules/GM_download.js` (native, `nsIWebBrowserPersist`) |
| modules/thirdParty/GM_cookie.js | THIRD-PARTY LIVE (gated polyfill) | UXP-era | keep until native lands (Phase 7); maintainer-decided to commit to native (Q&A point 6) |
| modules/thirdParty/getChromeWinForContentWin.js | THIRD-PARTY LIVE | Mozilla MPL 1.1 | keep |
| modules/thirdParty/droppedUrls.js | THIRD-PARTY LIVE | MPL 2.0 | keep |
| components/greasemonkey.js | LIVE | xpcom service stub | keep — core entry point |
| defaults/preferences/greasemonkey.js | LIVE | xpcom pref defaults | keep |

### 8.5 `skin/`

| Path | Tag | Action |
|------|-----|--------|
| skin/browser.css | LIVE | keep |
| skin/bindings.css | LIVE | keep |
| skin/install.css | LIVE | keep |
| skin/options.css | LIVE | keep |
| skin/scriptPrefs.css | LIVE | keep |
| skin/addons.css | LIVE | keep |
| skin/icon16.png | LIVE | keep |
| skin/icon24.png | LIVE | keep |
| skin/icon32.png | LIVE | keep |
| skin/icon64.png | LIVE | keep |
| skin/userScript.png | LIVE | keep |
| skin/icon16Disabled.png | **DEAD candidate** | check for dynamic name construction, then delete |

---

## 9. Maintainer decisions (Q&A — Phase 1 close-out)

These six answers from the maintainer lock the boundaries of the cleanup
work. Future contributors should treat them as binding policy.

| # | Question | Decision |
|---|----------|----------|
| 1 | Delete `modules/sync.js` + the Sync checkbox in `options.js`? | **Keep** for niche Pale Moon Sync configuration. The module already self-aborts on platforms without `resource://services-sync/*`. |
| 2 | Strip the `responseObserver.js` WebExtensions fallback? | **Yes, delete** in Phase 4. `chrome.webRequest` is unavailable on UXP. The XPCOM observer remains. |
| 3 | `fileXhr.js:46` `xhr.open("open", aUrl, false)` — bug or intentional? | **Probably intentional, needs investigation** before any change. Flagged in §8.3. |
| 4 | Remove non-standard `GM_windowClose` / `GM_windowFocus`? | **Keep.** The fork's policy is full GM3 + GM4 native support, and these are additive harmless extensions some scripts may depend on. Documented as fork-specific in §7.3. |
| 5 | Hard-floor the platform target? | **Yes — Pale Moon 28+ / Basilisk current.** Every pre-target compat branch enumerated in §5 is removed in one Phase 4 sub-batch. |
| 6 | `GM_cookie` strategy? | **Native chrome-side implementation in Phase 7.** Drop the third-party polyfill once the native version is in. The fork's stated goal is GM3 + GM4 natively callable. |

---

## 10. Phase routing summary

What goes where, in execution order:

| Phase | Work |
|-------|------|
| **2** | Architecture map (`docs/architecture.md`) — sequence diagram of install → match → sandbox → API surface → execution. Covers what's LIVE only; ignores VESTIGIAL. |
| **3** | Smoke-test set (`tests/smoke/`) — 8-12 user scripts exercising every major API path, with manual test plan. The regression net for Phases 4-7. |
| **4** | Framescript-layer removal + dead-fallback branch sweep. Touches: frameScript.js, processScript.js, storageFront.js, all messageManager IPC sites, all §5 branches, the WebExt fallback in responseObserver.js, openInEditor.js Scratchpad fallbacks, FF-appID overlay lines. Multiple sub-batches of ≤ 5 files each (per project rule 2). |
| **5** | `getService` indirection collapse + polyfill sweep (`hitch`, `inArray`, optional `emptyElm`/`uuid`/`timeout`) + DEAD-file deletions (`windowIdForEvent.js`, `icon16Disabled.png` after dynamic-name check). Inline-candidates (`setEnabled.js`). |
| **6** | XBL bindings audit — **DONE: no code change.** The 5-binding cludes-editor chain (clude-editor-base + editable + readonly + readonly-include/match/exclude, ~300 LOC in `content/bindings.xml`) is genuinely load-bearing — it provides the entire UI for include/exclude lists in scriptPrefs and uses XBL inheritance non-trivially.  The single `greasemonkey-tbb` binding (14 LOC) gives us lazy popup-clone-on-first-show; replacing it with imperative code would need a MutationObserver on the toolbar and lose semantics for no observable benefit on UXP.  **Decision: keep both.**  The audit conclusion is recorded here for future contributors so the question doesn't get re-litigated. |
| **7** | GM4 API parity. Replace `evalAPI2Polyfill` string-eval with a real chrome-side `GM` object exported via `Cu.exportFunction`. Native `GM_cookie`, native `GM_download` with onprogress + saveAs. Batched-SQL paths for `GM_*Values`. |

Each phase ends with a verification gate: smoke-test set runs green, maintainer
review of the diff, commit on `cleanup/strip-legacy`. No phase begins without
the previous one approved.
