## Changelog

#### 3.9

**about:addons "User Scripts" pane**
* **Create new userscript** now opens the editor directly with an auto-named
  script ("New User Script N", namespace "Greasemonkey", scoped to the active
  tab) instead of a dialog that required a name and namespace up front —
  matching Violentmonkey / Tampermonkey.  Set
  `extensions.greasemonkey.manager.newScript.classicDialog.enabled` to true to
  restore the classic metadata dialog.

#### 3.8.1 — Hotfix

* **Fixed:** opening a script's **Preferences** failed with an "XML Parser
  Error: undefined entity" on every non-English UI locale — a regression from
  the 3.8 per-script Options redesign, whose new interface labels were missing
  from the translations.  All localisations are restored (new labels fall back
  to English until translated; a malformed entity in the Hebrew locale was also
  corrected).  Thanks to the reporter of issue #23.
* Added a **Report a bug** entry to the toolbar **Web sites…** menu, linking to
  the project's issue tracker.

#### 3.8 — UI/UX pass (Pale Moon forum feedback)

A round of about:addons / install-dialog / per-script-options refinements
driven by forum testers (esp. Enobarbous) after the 3.7.0 release.

**Per-script Options window (`scriptPrefs`)**
* Split into three tabs — **Settings** (Metadata / Behaviour /
  Script-declared pages / Permissions), **User Preferences** (the user's
  own include / match / exclude rules + the override checkbox), and
  **Values** — matching the tester's prototype.  The script-declared
  lists are now full-width instead of three cramped columns.
* Fixed long-URL overflow: metadata value cells were reverting to content
  width because XUL treats a `0`/`0px` box size as `auto`; pinned
  `min-width:1px` instead (diagnosis credit: Enobarbous).
* Enabling Automatic updates on a locally-edited script now warns
  **immediately on the radio click** (was: never, on the Options page),
  mirroring the Add-ons Manager radio.

**about:addons "User Scripts" pane**
* Removed the "Get user scripts" sort-bar link.
* "New User Script…" is now a **New…** text-link dropdown: Create new
  userscript · Install from GreasyFork · OpenUserJS · GitHub Gist ·
  Install from URL… (small dismissible panel).
* Installing from a URL — or by drag-and-drop — now reports a clear error
  when the address is invalid, can't be downloaded, or isn't a user script,
  instead of failing silently.
* Right-click a script → **Enable/Disable** (first item; label flips with
  state) and **Remove** (under Edit) — same behaviour as the row buttons,
  including the undoable "removed — Undo" prompt on Remove.
* **Responsive header (on by default):** when the window is too narrow — or
  zoomed in too far — to fit the toolbar on one row, the action links and the
  search + sort buttons stack onto two rows instead of the sort buttons being
  cropped off the right edge.  Disable with the about:config pref
  `extensions.greasemonkey.manager.responsiveHeader.enabled`.
* Recover-Orphans link text moved from hard-coded English into
  `gmAddons.properties` (translatable; still shows the live count).
* New about:config toggles (default true):
  `extensions.greasemonkey.manager.importExport.enabled` and
  `…manager.search.enabled` hide the Import/Export links or live-search.

**Toolbar "Web sites…" menu**
* Now lists Greasemonkey Manual + GreasyFork / OpenUserJS / GitHub Gist,
  replacing the old dead greasespot-wiki links.

**Install dialog**
* Shows a **permissions summary** (`@grant` + `@connect`) so users see
  what a script can do before installing.
* Hardened `install.css` to use system field colours (`-moz-FieldText`),
  so the matches list / text no longer disappears under dark or
  non-default themes.

**Localization**
* New menu/label entities propagated to all 34 `greasemonkey.dtd` and
  `gmAddons.dtd` locale files (English placeholders, pending translation);
  new keys added to en-US `gmAddons.properties` / `gmBrowser.properties`.

#### Rework branch — internal architecture cleanup (unreleased)

This branch (`Rework`) is the multi-phase strip of the multi-process
(Electrolysis / e10s) infrastructure that the Greasemonkey codebase still
carried from its Firefox-mainline days.  UXP browsers (Pale Moon,
Basilisk) run chrome and content in the **same** JS runtime, so every
`messageManager` / `cpmm` / `ppmm` IPC hop the extension still performed
was a no-op detour: the receiver and sender share a process.  The
framescript file itself (`content/frameScript.js`) was an Era-2 artefact
loaded into each tab — pure overhead on single-process UXP.

The rework removes the entire framescript layer, collapses every
self-loop IPC site into direct in-process calls, rewrites three GM_*
third-party polyfills with native chrome-side implementations, and
prunes seven dead-code polyfills and fallback branches.  **No
user-visible behaviour changes** — every userscript that worked on
master should continue to work identically.  The XPI ships with ~800
fewer lines of code and 3 fewer files than master.

The phase-by-phase docs in `docs/legacy-inventory.md` and
`docs/architecture.md` are the canonical reference for what each step
did and why.  The headline summary below mirrors the 27-commit history.

**Pre-work**

* **Phase 1** (`docs: legacy-cleanup inventory`) — comprehensive audit
  of every LIVE / VESTIGIAL / DEAD file in the tree, grouped by era
  (gm2 / Australis / multi-process / UXP-adapted).  The roadmap for
  every later phase.
* **Phase 2** (`docs: architecture map`) — sequence diagram of the
  install → match → sandbox → API surface → execution pipeline.
  Each `[Phase 4: …]` footnote called out a place where the runtime
  detoured through framescript / IPC.
* **Phase 3** (`test: smoke-test set`) — 13 userscripts under `tests/`
  exercising every major API path (sandbox / page-context, run-at
  phases, storage, xmlhttpRequest, addStyle, openInTab, etc.).
  Regression net for Phases 4-7.
* **`build-xpi.ps1`** — codified the XPI packager so every phase's
  build is reproducible.

**Phase 4 — Framescript and IPC removal**

* **4a** — dead-fallback sweep across 5 files (Firefox-only branches,
  unreachable since UXP-only support).
* **4b** — stripped the WebExtensions fallback path from
  `responseObserver.js` and the `mozAnon` XHR compat shim.
* **4c** — flattened three trivial IPC self-loops to direct calls.
* **4d** — collapsed `modules/storageFront.js` into
  `modules/storageBack.js`.  The two had been a chrome/content IPC
  pair; on UXP single-process the cross-compartment hop was a
  function-call indirection.  Storage `GM_setValue` / `GM_getValue`
  now executes in one module.
* **4e** — collapsed the `ipcScript.js` IPC bootstrap (the `Object.-
  freeze` / `serialise` / `cpmm` machinery at the bottom) and removed
  the five `ppmm` listeners in `components/greasemonkey.js` whose
  senders had been retired in 4c/4d.
* **4f-1** — menu-command IPC restructured to a chrome-side custom-
  event dispatch (`greasemonkey-menu-command-list-<suffix>`,
  `…-run-<suffix>`).  No more `cpmm` self-loopback for menu
  registration.
* **regression fix** (`fix: regressions from Phase 4d + 4f-1`) —
  storage `setValues` / `deleteValues` and the per-script Options
  reorder both hit bugs uncovered by smoke; patched with explicit
  fixes plus regression coverage in the smoke set.
* **4f-2** — `GM_openInTab` and `GM_window` now call
  `GM_BrowserUI.openInTab` / `.tabClose` / `.window` directly via
  `getChromeWinForContentWin`.  The corresponding tab-MM listeners
  in `content/browser.js` were unreachable code and were removed.
* **4f-3 (mini)** — three dead listeners in `content/browser.js`
  removed (open-in-tab / tab-close / window).
* **4f-3a** (this branch's biggest single commit) — **chrome-side
  `modules/scriptInjector.js` replaces `content/frameScript.js`**.
  The full ~500-LOC injection pipeline (Services.obs observers for
  `content-document-global-created` + `document-element-inserted`,
  per-window DOMContentLoaded/load listeners, page-context
  `<script>`-element injection, sandbox creation, body
  MutationObserver for `@run-at document-body`) now runs in chrome
  scope.  Six remaining mm-IPC sites in `content/browser.js`,
  `modules/script.js`, and `content/newScript.js` collapsed into
  direct calls.  `createSandbox()`'s `aFrameScope` first parameter
  dropped (only consumer was the framescript).
* **4f-3b** — `content/frameScript.js` (-573 LOC),
  `modules/processScript.js` (-90), and
  `modules/documentObserver.js` (-124) deleted.  Net diff: -787 LOC.
  The framescript era is over.

**Phase 5 — Polyfill sweep**

* **5a-1 / 5a-2** — `util/hitch.js` retired.  GM 1.x-era
  `Function.prototype.bind` polyfill; UXP's SpiderMonkey has had
  native `Function.prototype.bind` since Gecko 4.  46 call sites
  across 8 files rewritten to `.bind(…)`.
* **5b** — `util/inArray.js` retired.  Pre-ES2016 `Array.prototype.-
  includes` shim; UXP supports the native everywhere.  8 files
  rewritten to `.includes(…)` / `.some(…)`.

**Phase 6 — XBL audit**

* **6** (`docs: XBL bindings audit complete (no code change)`) —
  audit of the `cludes-editor` / `greasemonkey-tbb` XBL pair.
  Conclusion: load-bearing — the binding's lazy-loading semantics
  give a behaviour that imperative code would have to re-implement
  by hand, and the bindings work natively on UXP.  Kept.

**Phase 7 — Native chrome-side API surface**

* **7a** — Native GM4 (`GM.*` Promise) surface in `modules/sandbox.js`.
  Replaces `evalAPI2Polyfill`, which built a JS string for every
  sandbox and ran it through `Cu.evalInSandbox`.  The new path uses
  `Cu.createObjectIn` + `Cu.exportFunction` with a pre-computed
  `GM_API_MAPPING` (one-time at module load).  Stack traces in
  `await GM.X(...)` errors now point at chrome scope instead of an
  eval'd string.
* **7b** — Native `GM_cookie` (methods-object form: `.list / .set /
  .delete`) built on `Services.cookies`.  Replaces the third-party
  `modules/thirdParty/GM_cookie.js` dispatch-function polyfill.
  Default-on via new `extensions.greasemonkey.api.GM_cookie` pref.
  `buildGMObject` Promise-wraps the methods for the GM4 form
  `await GM.cookie.list({…})`.
* **7d** — Batched-SQL paths for `GM_getValues` / `GM_setValues` /
  `GM_deleteValues` in `modules/storageBack.js`.  Pre-cleanup,
  multi-key operations looped through the single-key API one SQL
  round-trip per key; the new path issues one SQL with named
  placeholders (`WHERE name IN (:n0, :n1, …)`) plus a single
  BEGIN/COMMIT for batched writes.
* **7c** — Native `GM_download` on `nsIWebBrowserPersist` +
  `nsIFilePicker` + the platform transfer service (`nsITransfer`,
  `@mozilla.org/transfer;1`).  Replaces the third-party polyfill
  that fetched via `GM_xmlhttpRequest` and triggered the browser's
  save dialog through a synthetic `<a download>` click in the page
  DOM.  The native version streams to disk (no in-memory blob
  buffering), honours `details.saveAs`, fires `onprogress` /
  `onload` / `onerror` / `onabort` with TM/VM-compatible payload
  shape, and registers each download with the platform transfer
  service so it appears in Pale Moon's Downloads window with a
  working Cancel button.  Diagnostic journey across four fixup
  commits documented in-tree:
  - X-ray wrappers were silently filtering script-supplied function
    properties (`onload`, `onerror`, …) out of the details object
    seen on the chrome side — fixed with `Cu.waiveXrays` matching
    `xmlHttpRequester.js:569`.
  - `nsIWebBrowserPersist.saveURI` has two shapes across UXP builds
    (8-arg vs 9-arg with triggering principal); we try 8-arg first
    because it's the canonical Pale Moon / Basilisk shape, falling
    back to 9-arg on any platform that requires the principal.
  - `STATE_STOP` fires multiple times per save (request stop +
    network stop ± document stop on some builds) — gated terminal
    callback dispatch on a single-shot `terminalFired` flag so
    `onload` / `onabort` / `onerror` fire exactly once per
    `GM_download` call.
  - Initially used `nsIDownloadManager.addDownload`, which throws
    `NS_ERROR_UNEXPECTED` on Pale Moon (the legacy pipeline is
    stubbed; the surviving path is `nsITransfer`).  Switched to
    `@mozilla.org/transfer;1` and downloads now populate the
    Downloads window correctly.
  - Default-on via new `extensions.greasemonkey.api.GM_download` pref.
  - Removed the implicit `GM_xmlhttpRequest` auto-inject that the
    polyfill needed; scripts that use `GM_xmlhttpRequest` must
    `@grant` it explicitly now.

**Misc**

* `docs:` cleanup of an outdated retrospective comment in
  `modules/util.js`.

**Verifying the rework on your install**

1. Take a backup of your profile directory before installing the XPI.
2. Install the XPI built from this branch (`greasemonkey-3.7.0.xpi`).
3. The `tests/` directory contains 13 smoke userscripts covering
   sandbox / page-context injection, all `@run-at` phases, storage,
   xmlhttpRequest, cookie, download, openInTab, addStyle, notifications,
   and resources.  Install each and verify the documented behaviour.
4. For day-to-day userscripts: install the new XPI alongside your
   existing scripts and watch the Browser Console (Ctrl+Shift+J) for
   anything noisy.  If a script behaves differently from master,
   `git bisect` the 27-commit chain in this branch — every phase is a
   single commit (Phase 7c is the only multi-commit phase, with three
   in-tree-documented fixups).

#### 3.7.0 (2026-04-30)

Per-script preferences dialog redesign.  Right-click any user script in
`about:addons` and pick "Options" — what was a two-tab "User Settings /
Script Settings" pattern-list dialog is now a dense single-form Settings
panel showing the full picture of a script in one place, plus a new
**Values** tab for inspecting and editing the script's `GM_setValue` /
`GM.setValue` storage.

New features

* **Metadata section** — read-only display of every metadata directive
  the script declared (or that GM inferred): name, namespace, version,
  description, author, homepage, support URL, update URL, download URL,
  install timestamp, last-update timestamp.  Homepage and support URL
  are clickable and open in a new tab.
* **Behaviour section** — editable controls for `@run-at`, `@noframes`,
  `@inject-into`, automatic-updates state (Default / On / Off), and a
  **TM-style "Execution position" dropdown** (`<position> of <total>`)
  that drives the same script-ordering as the existing Add-ons Manager
  "Sort by execution order".  Changing position in the Options dialog
  takes effect immediately on OK.
* **Pages section (redesigned layout, same UX)** — keeps the existing
  Add / Edit / Remove buttons users already know.  User-side patterns
  (Included / Matched / Excluded) are now stacked above the script's
  own declared patterns (read-only) so the user sees both at once
  instead of toggling between tabs.  The "Disable script's rules"
  override checkbox stays.
* **Permissions section** — read-only summary of `@grant`, `@connect`,
  `@require`, `@resource`, and `@antifeature` declarations.
* **Values tab** — full GM_setValue browser.  Lists every key with its
  type (string / number / boolean / object / array / null) and an
  inline preview of the value (truncated for long blobs).  **Add /
  Edit / Delete** buttons go through the existing
  `GM_ScriptStorageBack` plumbing so the script's
  `GM_addValueChangeListener` observers fire correctly.  Edits accept
  any JSON-serialisable value; objects and arrays are pretty-printed
  for editing convenience.  An "(invalid)" row type surfaces malformed
  legacy entries so the user can repair them rather than seeing the
  Values list silently hide them.

Engineering

* New read-only getters on `Script.prototype`: `antifeatures` and
  `supportURL`.  Those fields were stored privately and used at parse
  time but never exposed to consumers; the redesigned dialog needs
  both.
* `scriptPrefs.css` extended with the new section / metadata-grid /
  values-pane / theme-aware styles.  No skin assets added.
* All new locale strings (~50 entities + ~12 properties) propagated to
  every shipping locale at the same time the en-US source landed.
  English placeholders for non-translated locales; translators can
  localise later without breaking the dialog.

Compatibility & edge-case fixes (Violentmonkey-parity audit)

A focused audit of Violentmonkey 2.35.1 against this fork's source
turned up a small set of real bugs where VM handles an edge case the
GM-UXP code did not, plus a few defensive issues independent of VM.
Every item below has been verified against the current source before
the fix landed.  None of these are behavioural regressions — each is
either a strictly-permissive change or a defensive hardening with no
observable effect on existing scripts.

* **`util/fileXhr` no longer passes the literal string `"open"` as the
  HTTP method.** The sync helper that loads `@require`, `@resource`,
  and `GM_info.scriptSource` / `scriptMetaStr` was passing `"open"` as
  the first argument to `xhr.open()`.  UXP's XHR silently treated the
  unknown verb as GET so the bug was invisible, but any future
  tightening of method validation in the platform would brick every
  script load.  Now passes a proper `"GET"`.
* **`GM_xmlhttpRequest({url, onload})` without a `method` field now
  defaults to GET.** Per the GM4 / TM / VM spec, `method` is optional
  and defaults to GET; the previous code passed `undefined` straight
  into `XMLHttpRequest.open()` which threw `NS_ERROR_INVALID_ARG` and
  surfaced as a synthetic XHR error.  Now matches every other userscript
  engine's behaviour.
* **`GM_xmlhttpRequest` with `responseXML` clone failure no longer
  aborts the request.** If the content window was torn down during the
  response, `new aWrappedContentWin.Document()` threw and the listener
  called `aReq.abort()` from inside a fired event — the script then
  never received `response`, `responseText`, or `status` either.  Now
  the clone failure is logged, `responseXML` stays `null`, and the
  rest of the response reaches the script intact.
* **`GM_addElement` and `GM_addStyle` carry the page's CSP nonce.**
  Inline `<script>` and `<style>` elements injected by these APIs now
  pick up the page's `script-src` / `style-src` nonce automatically,
  so they execute on nonce-CSP pages (GitHub, Google search, modern
  news sites) where the previous unconditional `appendChild` was
  silently blocked.  No-op on pages without a nonce CSP.  Scripts can
  still override via `attrs.nonce` if needed.
* **`@match` patterns now support `:port`.** Patterns like
  `http://localhost:3000/*` previously threw `error.matchPattern.host`
  at install time because the host regex disallowed colons.  Ports are
  now optional in the pattern grammar; when present, only URLs with a
  matching explicit port are matched (matches TM behaviour).  Patterns
  written without a port continue to be port-agnostic, so existing
  patterns are unaffected.
* **`@connect *.domain.tld` is now recognised.** TM-style wildcard
  `@connect` entries (e.g. `// @connect *.googleapis.com`) match both
  the bare host (`googleapis.com`) and any subdomain.  Previously the
  literal `*.googleapis.com` was treated as a hostname and never
  matched anything, so `GM_xmlhttpRequest` calls against
  `cdn.googleapis.com` got rejected even when the script explicitly
  declared the wildcard.
* **`GM_info.platform` now includes `browserName` and `browserVersion`.**
  Mirrors VM's `GM_info.platform` shape so portable userscripts that
  branch on
  `GM_info.platform.browserName === "firefox"` (and friends) can
  detect Pale Moon / Basilisk explicitly rather than mis-detecting
  based on UA spoofing.
* **`GM_setValue` of a non-JSON-serialisable value now throws a
  sandbox-realm `Error`.** Circular structures, `BigInt`, and similar
  used to surface a chrome-realm `TypeError` that didn't match the
  script's own `e instanceof Error` check, so scripts couldn't
  recognise the failure.  The error now comes from the script's own
  realm with a clear "value is not JSON-serialisable" message.
* **`GM_addElement` no longer crashes if `attrs` has a null prototype.**
  Scripts passing `Object.create(null)` (or any object whose own
  `hasOwnProperty` has been shadowed) previously threw inside the
  attribute-application loop.  Now uses `Object.prototype.hasOwnProperty
  .call(…)` so all object shapes work.
* **`@installURL` fallthrough in the parser is now documented.** The
  metadata parser intentionally falls through from `case "installURL"`
  to `case "downloadURL"` to share the URL-validation block; the
  missing `break` looked accidental and a maintainer "fixing" it would
  silently strip `@installURL` support.  Added a `// fallthrough`
  comment so the intent is unambiguous.

Items considered and not changed (audit closeout — informational)

* **CRLF line endings in `==UserScript==` metadata blocks** are
  already handled correctly: `parseScript.js:109` strips trailing
  whitespace (`\s+$`, which includes `\r`) before invoking the PEG
  grammar.  No grammar change needed.
* **`GM.addElement(...).then(el => …)` thenable Element** (VM's
  one-shot self-deleting `.then` trick) was investigated but not
  shipped: cross-compartment X-ray wrappers on UXP filter expandos
  defined from chrome scope, so the property would not be visible to
  the script.  Users wanting future-style chaining should write
  `await GM.addElement(...)` — that already works on TM, VM, and this
  fork.
* **VM-style "VAULT" Object.prototype-poisoning defense** for
  page-mode (`@grant none` / `@inject-into page`) scripts: our
  injected prelude template uses object literals and `var`
  declarations exclusively, both of which use `[[DefineOwnProperty]]`
  semantics that bypass prototype-chain setters.  VM's `setOwnProp`
  pattern shields VM's own polyfill code from a poisoned page; that
  isn't an analogue of any code GM-UXP injects.  User scripts that
  use `obj.foo = …` against a hostile page remain the user's
  responsibility to harden, exactly as on every userscript engine.

Performance improvements (Violentmonkey-parity audit, round 2)

A second audit pass against Violentmonkey 2.35.1's hot paths turned
up a set of architectural choices that compound on power-user
profiles (200+ installed scripts).  None of these changes alter
script-observable behaviour — each is an internal optimisation that
either short-circuits redundant work or eliminates wasted clones.

Match-pattern / scripts-for-URL pipeline (the bulk of the win):

* **`MatchPattern` instances are no longer flattened to strings in
  `IPCScript`.**  Pre-cleanup the constructor mapped
  `excludeMatches`/`matches`/`userMatches` down to their `.pattern`
  string form, and `AbstractScript.matchesURL` re-instantiated
  `new MatchPattern(string)` on every URL test — compiling 2-3
  regexes per pattern per call.  On a 200-script profile that's
  ~1800 regex re-compilations per page load (200 × 3 rules × 3
  run-at phases) thrown away after each match.  The flatten was
  there for IPC marshalling against multi-process Firefox; UXP is
  single-process so the live compiled objects flow through
  unchanged.
* **`(url, pattern) → boolean` result memoisation in `AbstractScript`.**
  Popular `@match` rules (e.g. `*://*.github.com/*`,
  `*://www.google.com/search*`) are shared by dozens of scripts on
  a typical profile.  Each unique `(url, pattern)` pair now hits
  the regex evaluator once per navigation instead of once per script.
  Cache is bounded at 1024 entries with FIFO eviction; cleared
  wholesale whenever the installed-script list or `globalExcludes`
  changes (`IPCScript.update` is the single funnel for every such
  event).
* **`(url, glob) → boolean` result memoisation for `@include` /
  `@exclude` globs.**  Same pattern, same invalidation hook.
* **`scriptsForUrl(url, when)` result cache.**  `scriptInjector.js`
  calls this 3-5 times per page load (one per run-at phase, plus
  any subframe).  Each call previously did a full `gScripts.filter`
  scan — at 200 scripts that's 600-1000 filter passes per
  navigation.  Cache is bounded at 256 entries with FIFO eviction.
* **`isGreasemonkeyable(url)` hoisted out of the per-script loop.**
  The chrome:/about: deny check now runs once at the top of
  `scriptsForUrl` instead of once inside every script's
  `matchesURL`.
* **`<all_urls>` fast path in `MatchPattern.doMatch`.**  Skips the
  `getUriFromUrl(...)` parse + scheme check entirely when the
  pattern is the always-match sentinel; cheaply confirms the URL's
  scheme is one of the supported ones via a `substring + indexOf`.
* **`safeGlobalsSnapshot` prelude hoisted to a module-level constant.**
  Pre-cleanup the same ~30-line string literal was rebuilt fresh on
  every page-mode script injection.  Now built once at module load
  and referenced from every injection.

Storage hot path:

* **Skip `Cu.cloneInto` for primitive `GM_getValue` returns.**
  SpiderMonkey passes strings / numbers / booleans across compartments
  by value already (they're immutable; no aliasing risk).  The
  unconditional clone burned ~10-50µs per call even for primitives.
  Objects and arrays still pay the clone so scripts can't mutate
  the cached back entry.
* **Drop redundant `JSON.parse(JSON.stringify(...))` in
  `listValues`.**  `Cu.cloneInto` already deep-copies the returned
  array; the round-trip was pure waste.
* **`GM_setValue` no-op identical-write fast path.**  When the new
  value structurally equals the cached value, skip the SQLite write,
  the cache invalidation, and the listener fire entirely.  Matches
  Violentmonkey's `deepCopyDiff` behaviour — scripts that defensively
  re-`setValue` the same config on every page navigation pay zero
  cost on the repeated writes.
* **`GM_setValue` listener-equality check gated on listener
  existence.**  `valuesEqualForListener` (two `JSON.stringify`
  passes) used to run on every write even when no listener was
  registered for the key — wasted on the common case.  Now skipped
  unless a listener for the key exists.

Sandbox creation:

* **Per-script lowercased-grants Set.**  Pre-fix the 18 GM_* API
  registrations each ran
    `aScript.grants.some(i => String(i).toLowerCase() === String(_API2).toLowerCase())`
  — `.toLowerCase()` was being called per @grant per API per
  sandbox.  Now a single Set is built once at the top of
  `createSandbox` and each API check is one `Set.has` lookup.
  ~200µs saved per sandbox; matters most on multi-iframe pages
  where dozens of sandboxes are created back-to-back.

XPCOM service caching:

* **Locale string bundle cache** on `GM_CONSTANTS.getLocaleBundle()`.
  `nsIStringBundleService.createBundle(...)` returns a fresh
  bundle handle (~200µs) per call.  Hot-path error sites (one per
  GM_setValue type-throw, one per XHR scheme-rejection, etc.) can
  switch to the cached form for repeat savings; cold-path sites
  continue to work with the old call shape.
* **One-time `getService` cache** in `util/logError.js`, `util/uuid.js`,
  `util/getBrowserWindow.js`, and `util/alert.js`.  Each previously
  resolved its XPCOM service handle on every call; now resolved
  once at module load.

XHR wiring:

* **`Cu.waiveXrays(aDetails)` hoisted out of `setupRequestEvent`.**
  The waive used to run once per event-type registration — 8x for
  the main XHR and 6x for the upload, ~70-140µs per request.  Now
  done once in `chromeStartRequest` and passed pre-waived to each
  `setupRequestEvent` call.
* **`responseXML` clone failure no longer aborts the request.**
  (Already covered in the round-1 audit notes above; mentioned here
  because the responseXML clone now lives in the same per-event
  fast path.)

Frame collection:

* **`urlsOfAllFrames` uses in-place `push.apply` instead of
  re-allocating via `Array.concat`.**  `urls = urls.concat(...)` was
  building a new array per iframe — O(N²) on deep frame trees.

Items considered for this release and deferred

* **Lazy `GM_info` getter** (VM's pattern of building `GM_info` only
  on first read): the cross-compartment accessor-property semantics
  on `Cu.Sandbox` need empirical verification before landing.  The
  estimated 0.5-2ms per sandbox saving on a 30-iframe page is real
  but not worth the X-ray-boundary risk without a test build.
* **In-sandbox value mirror with bulk preload at injection time**
  (VM's biggest startup win): the memory cost — one extra copy of
  each script's storage per sandbox — grows quickly on power-user
  profiles.  Lowering the existing back-level cache's
  `CACHE_AFTER_N_GETS` threshold gets most of the same win without
  duplicating data per sandbox; that's a follow-up candidate.
* **Write coalescing with debounced flush** (VM's adaptive 100-1000ms
  flush delay): current `synchronous=OFF` + memory-journal SQLite
  config already pays most of the same cost; coalescing would change
  durability semantics in a corner case that's hard to justify
  against the marginal speed gain.
* **Async listener dispatch / per-tick batching of cross-sandbox
  broadcasts:** changes listener-firing semantics in a way scripts
  may depend on (synchronous fire inside `setValue`).  Niche.
* **`setTimeout(0)` → `queueMicrotask` for XHR events:** the
  `setTimeout(0)` boundary exists deliberately to escape XHR
  readystatechange reentrancy on Gecko.  Worth measuring before
  changing.
* **Bulk DOM ops via shadow root in `injectScriptIntoPage`:** real
  win but interacts with the CSP-probe + nonce flow that took
  several commits to stabilise.  Best done as its own change.

Note: the standalone CodeMirror editor draft from Phase L was parked
under `_attic/editor-draft/` so that the M-series redesign could land
without depending on it.  Right-click → "Edit" still opens the user's
configured external editor (or Scratchpad if none is set), exactly as
in 3.6.2.

#### 3.6.2 (2026-04-20)

Quality-of-life release that fixes a long-standing default that broke
modern userscripts and merges the uBlock-compat work from PR #16.  No
breaking changes; in-place upgrade from 3.6.1.

* **`GM is not defined` no longer throws on modern userscripts.** The
  GM4 namespace polyfill (`evalAPI2Polyfill` in `modules/sandbox.js`)
  is the only path that declares the `GM` identifier in the script
  sandbox, and it ran only when
  `extensions.greasemonkey.api.object.polyfill` was true — but the
  default was false.  Every script written in the last several years
  for Tampermonkey / Violentmonkey / Greasemonkey 4 — anything that
  uses `GM.getValue`, `GM.setValue`, `GM.notification`,
  `GM.xmlHttpRequest`, etc. — failed on first reference with a
  `ReferenceError`.  Optional chaining (`GM?.info`) does NOT suppress
  this — it only short-circuits on null/undefined LHS, not undeclared
  identifiers.  The default now flips to true; the polyfill is mature
  and has been there for years.  Reproduced via AdsBypasser
  (https://adsbypasser.github.io/), which threw at line 471 before
  this change.
* **uBlock Origin "block inline scripts" no longer silently breaks
  userscripts** (PR #16 from [@SeaHOH](https://github.com/SeaHOH)).
  When uBlock or strict CSP blocks our `<script>` element from
  executing, GM now detects it via a one-shot probe (inject a tiny
  div-creating script and check whether the div appears) and falls
  back to running the script in a sandbox so it executes anyway.
  Previously such scripts failed silently with no diagnostic.  Also
  adds `isIncognito` / `isPrivate` to `GM_info` to match Violentmonkey,
  and reorganises `injectScriptIntoPage` into clearly numbered phases.
* **"Show Script Source" → "Install" is one click instead of two.**
  Reading the source previously required a second 5-second countdown
  in a re-opened install dialog after clicking the notification bar's
  Install button.  Now the notification bar's Install button installs
  directly — the user has already gone through the security delay
  once and read the source explicitly, so the second prompt added
  friction without adding security.
* **Restored the per-method JSDoc inside `MenuCommandSandbox`.**  When
  3.6.1 converted that function to a template-literal string, two
  inner JSDoc blocks (for the GM_registerMenuCommand and
  GM_unregisterMenuCommand methods) were dropped along with the
  conversion.  They survive evaluation as ordinary JS comments inside
  the eval'd source and the inline docs were genuinely useful, so
  they're back — with a small enhancement on the `aAccesskey`
  parameter to document the Tampermonkey / Violentmonkey
  options-object form it accepts.

#### 3.6.1 (2026-04-19)

Bugfix-only release for two regressions reported in #13 shortly after
3.6.0 shipped.  Both affect Pale Moon and Basilisk under the same
conditions the reports describe on New Moon.

* **`GM_registerMenuCommand` works again on every supported browser.**
  3.6.0 had put the menu-command event listeners in chrome scope and
  read user callbacks out of `sandbox._mc_commandFuncs[cookie]` — which
  hit `XrayWrapper denied access to property N (reason: value is
  callable)` on strict-Xray builds and silently dropped the callback
  (reported on New Moon in #13 by @quilterrantdean).  3.6.1 reverts to
  the in-sandbox listener architecture, but — unlike the intermediate
  fix that briefly shipped in the 3.6.1 dev build — it holds the
  `MenuCommandSandbox` source as a raw template literal rather than as
  a `Function`.  Stringifying the Function via `"" + fn` (implicit
  `Function.prototype.toString()`) routes through the same buggy
  SpiderMonkey decompiler as the `.toSource()` whose crash we set out
  to fix originally, so on older Pale Moon / New Moon it produced
  malformed source, the sandbox eval failed silently, and the User
  Script Commands toolbar menu was completely greyed out.  Keeping the
  source as a string from birth bypasses every variant of the
  decompiler bug.  Thanks to @SeaHOH for the template-literal
  diagnosis.
* **Add-ons Manager works on non-English locales.** The new
  `&backup.exportAll;` / `&backup.import;` DTD entities were only added
  to `locale/en-US/gmAddons.dtd` in 3.6.0, so any user running a
  localised browser saw `XML Parsing Error: undefined entity` at
  `addonsOverlay.xul:73` and lost the entire Greasemonkey integration
  with the Add-ons Manager (missing sidebar icon, no sort bar, no
  Edit / Options / Export / Import buttons, no right-click menu).  The
  entities are now present in all 33 non-en-US DTDs with the English
  text as a placeholder that translators can localise later.  Reported
  by @nicolaasjan in #13.
* **Backup / export / import feature works on non-English locales
  too.** Six `.properties` strings used by the backup flow and the
  edited-script confirm prompt (`confirmEnableAutoUpdate`,
  `backup.exportTitle` / `importTitle` / `exported` / `imported` /
  `failed`) were also only present in `en-US`, which caused
  `GetStringFromName` to throw an uncaught exception the moment a
  non-en-US user clicked Export All / Import or re-enabled the
  Automatic Updates radio.  All six keys now live in every locale
  with English fallback values, via [PR #14](https://github.com/SecondCityOsD/greasemonkey-for-UXP-browsers/pull/14)
  from [@SeaHOH](https://github.com/SeaHOH).  That PR also localises
  the two backup DTD entities into Simplified Chinese.
* `GM_registerMenuCommand` also gains back the Tampermonkey /
  Violentmonkey `(name, fn, { accessKey })` options-object form that
  3.6.0 briefly supported via its inline-string implementation.
* **Localised extension description returns to the Add-ons Manager.**
  Every `locale/*/greasemonkey.properties` file carried an
  `extensions.<id>.description=…` key that embeds the add-on ID in
  the property name, and the matching
  `pref("extensions.<id>.description", …)` in
  `defaults/preferences/greasemonkey.js` pointed at the old
  `greasemonkeyforpm@janekptacijarabaci` ID.  After the 3.6.0 UUID
  change, Pale Moon / Basilisk couldn't find a localised description
  for the new-ID add-on and fell back to the untranslated English
  string from `install.rdf`.  All 34 locale properties and the
  defaults pref now reference the new UUID, via
  [PR #15](https://github.com/SecondCityOsD/greasemonkey-for-UXP-browsers/pull/15)
  from [@SeaHOH](https://github.com/SeaHOH).
* **`@match file:///*` now parses correctly.** The default parts regex
  in `modules/thirdParty/matchPattern.js` required at least one
  non-slash character in the host position (`[^/]+`), which rejected
  the canonical Chrome / Tampermonkey / Violentmonkey form for "any
  local file" because that form has an empty host between `file://`
  and `/*`.  Scripts that legitimately want to run on local files
  (e.g. [Newspaper syndication feed reader](https://greasyfork.org/en/scripts/465932-newspaper-syndication-feed-reader))
  were rejected at install time with `error.matchPattern.parse`.  The
  regex is now `[^/]*` (zero-or-more); `HOST_REGEXP` already admitted
  `""` and `doMatch()` already had a dedicated empty-host branch for
  file: URIs, so no other changes were needed.

#### 3.6.0 (2026-04-18)

**Heads-up for existing users:** 3.6.0 uses a new extension ID, so your
browser will not auto-upgrade across it.  Uninstall 3.5.0 and install
3.6.0 manually — use the new Export / Import feature below to carry
your scripts, settings, and GM_setValue data across.  Scripts that were
installed under 3.5.0 keep their old homepage URL baked in; reinstall
the ones where the homepage link points at the raw `.user.js` to pick
up the new homepage-inference logic.

New features

* **Edit button in the script About pane** — A new "Edit" button sits
  immediately to the right of the built-in "Options" button in the
  Add-ons Manager detail view.  Clicking it opens the script in the
  editor configured under Greasemonkey → Options, matching the existing
  right-click "Edit" menu entry but surfaced where most users look
  first.
* **ZIP backup / restore** — New "Export All…" and "Import…" links in
  the User Scripts view header produce and consume a Tampermonkey-
  compatible ZIP archive containing every installed script's source,
  settings, and `GM_setValue` data.  The importer also accepts
  Violentmonkey and Tampermonkey exports.  Scripts whose
  `(name, namespace)` match an already-installed script are skipped
  rather than silently overwritten.  Implemented with native
  `nsIZipWriter` / `nsIZipReader` — no bundled JS library, no cloud
  sync.
* **Homepage resolution now matches Violentmonkey** — `@homepage`,
  `@website`, and `@source` are recognised as aliases for
  `@homepageURL`.  When a script declares none of those, GM derives a
  homepage from the install URL: `raw.githubusercontent.com`,
  `gist.github.com/…/raw/…`, `gist.githubusercontent.com`, GreasyFork
  (including `update.greasyfork.org` and locale-prefixed URLs),
  SleazyFork, and OpenUserJS all rewrite to the human-readable script
  page.  Scripts installed from gists and raw file hosts now get a
  clickable homepage link in the Add-ons Manager instead of nothing /
  the raw `.user.js` URL.

Bug fixes

* **Edited scripts can be updated again (fixes #9)** — The old hard
  block that disabled every update check on a script once its
  `.user.js` was edited is replaced with a Violentmonkey-style opt-in
  flow.  The first edit after install switches the script's "Automatic
  Updates" radio (in the About pane) to **Off** automatically, and the
  entry gets the yellow diagonal-stripes overlay as a cue.  Flipping
  the radio back to **On** / **Default** shows a confirmation prompt
  warning that the next update will overwrite your edits; cancelling
  snaps the radio back.  The "Find Update" menu entry shows the same
  prompt for a one-off update without changing the stored setting.
  After a successful remote install, timestamps resync and the
  yellow-stripes overlay clears on its own.
* **`@match http*://…/*` is now accepted** — Both Violentmonkey and
  Tampermonkey treat `http*://` as an alias for `*://` (i.e. "http or
  https"), and a non-trivial number of GreasyFork scripts (e.g. "GoFile
  Enhanced") use that form.  GM now normalises it to the existing
  wildcard-scheme path instead of throwing "Invalid scheme specified:
  http*" at install time.
* **Import no longer creates duplicate scripts** — The ZIP importer
  previously re-parsed the script source without an install URL, so
  scripts that relied on the install URL's host as their effective
  `@namespace` got a different ID on re-import and slipped past the
  duplicate check.  The importer now synthesises an install URI from
  the sidecar's `downloadURL` so the parser populates `_namespace`
  identically to the original install.  The same fix makes imported
  scripts re-updatable (no more stuck yellow stripes).

Housekeeping

* **Extension ID changed** from `greasemonkeyforpm@janekptacijarabaci`
  to `{544fad5a-9b62-418f-a9ff-616e388cf6c4}` — a clean break from the
  legacy ID inherited from the abandoned Pale Moon fork.
* **Simplified Chinese (zh-CN) translation polish** — thanks to
  [@SeaHOH](https://github.com/SeaHOH) via PR #11.  Fills in remaining
  untranslated strings and normalises punctuation across the locale for
  consistency.
* **Locale entries moved under source control** — `chrome.manifest`
  now registers every shipped locale directly (also via PR #11); the
  previous `build.sh` append-loop is replaced with a validation pass
  that warns if a `locale/<code>/` directory is missing its manifest
  entry.  Single source of truth, no build-time mutation.

#### Unreleased (UXP fork — 2026-03-12)

* GM_download: Added GM_download support (modules/thirdParty/GM_download.js)
* Reverted disabled-script update guard from checkForRemoteUpdate (preference in UI already handles this)
* Documentation: Added comprehensive JSDoc (@file, @overview, @param, @returns, @throws) to all modules

#### 3.31.4 (2018-08-05)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31.3Fork...3.31.4Fork)

* API: @match - Added support for ignoring a hash (opt-in)
* Style clean up (automatic updates, others...)

#### 3.31.3 (2018-06-23)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31.2Fork...3.31.3Fork)

* General: The script must not be updated if automatic updates are set to default and automatic updates are disabled
* API: Fix GM_info.scriptWillUpdate

#### 3.31.2 (2018-06-22)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31.1Fork...3.31.2Fork)

* Pale Moon - General: Fix <em:maxVersion>
* Basilisk - General: Used <em:basilisk>
* General: The script must not be updated if automatic updates are disabled

#### 3.31.1 (2018-05-05)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31Fork...3.31.1Fork)

* API: GM_addStyle, GM_getValue, GM_setValue, GM_deleteValue, GM_registerMenuCommand - Added convert the name/value to a "string"
* API: GM_setClipboard - Added convert the value to a "string", check the data value, better shows the type value
* API: GM_xmlhttpRequest - Added check the details value
* Loading: Sandbox (JavaScript version) - "latest" is being used instead of "ECMAv5" (it should not affect - did not work)
* Loading: Fix Scratchpad overlay for "Pale Moon UXP"

#### 3.31 (2018-03-04)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31beta2Fork...3.31Fork)

* [No change]

#### 3.31beta2 (2018-03-02)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.31beta1Fork...3.31beta2Fork)

* Fix typos (accesskeys)
* API: GM_xmlhttpRequest - Added check if the callback is a type of "function"
* API: Added support for GM_windowClose / GM_windowFocus (an alternative) ([#2538](https://github.com/greasemonkey/greasemonkey/issues/2538))
* API: Added support for GM_cookie (experimental, opt-in) ([#1802](https://github.com/greasemonkey/greasemonkey/issues/1802))
* GUI: Display current version of the script in the install dialog, if already installed ([#2877](https://github.com/greasemonkey/greasemonkey/issues/2877))
* Style clean up

#### 3.31beta1 (2018-01-10)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.30Fork...3.31beta1Fork)

* API: @match - Fix "*:" scheme (valid for ["http", "https"] only)
* API: @match - Fix "file:" scheme / A better regular expression (experimental, opt-in)
* Basilisk: Fix "XML Parsing Error: undefined entity" ([#270](https://github.com/MoonchildProductions/moebius/issues/270))
* Style clean up

#### 3.30 (2017-12-30)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.30rc4Fork...3.30Fork)

* [No change]

#### 3.30rc4 (2017-12-17)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.30rc3Fork...3.30rc4Fork)

* Pale Moon - API: Added (native) support for Greasemonkey 4.0+ - Promise APIs (experimental, opt-in)

#### 3.30rc3 (2017-12-01)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.30rc2Fork...3.30rc3Fork)

* Basilisk - API: Added (native) support for Greasemonkey 4.0+ - Promise APIs (experimental, opt-in)
* Fix typos

#### 3.30rc2 (2017-11-13)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.30rc1Fork...3.30rc2Fork)

* General: Added update URL for automatic updating
* API: Added support for Greasemonkey 4.0+ - Promise APIs (preliminary steps)
* Loading: about:blank, the script with alert function - after the restart, the browser hangs ([#2229](https://github.com/greasemonkey/greasemonkey/issues/2229)) (follow up - for "document-element-inserted")
* Loading: addEventListener ("DOMContentLoaded", "DOMWindowCreated") - explicitly set useCapture
* Fix typos, style clean up

#### 3.30rc1 (2017-10-02)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta12ForkExperimental...3.30rc1Fork)

* General: Changed the extension ID! Update requires you the uninstall the old version (e.g. beta) and then install the new (rc) - the new version will not overwrite the old one, and you cannot use both versions together! Your settings and scripts should stay in place.
* General: Removing statistics
* API: GM_xmlhttpRequest - Added support for blob: and data: protocols
* API: GM_xmlhttpRequest - Added support for Containers (Firefox 42+) ([#2555](https://github.com/greasemonkey/greasemonkey/issues/2555))
* GUI: Updating scripts - Viewing homepage ([#2566](https://github.com/greasemonkey/greasemonkey/issues/2566))
* API: GM_notification - If this function (Web/Desktop Notifications) is not enabled
* Fix typos, style clean up

#### 3.12.1beta12 (2017-08-03)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta11ForkExperimental...3.12.1beta12ForkExperimental)

* API: unsafeWindow - Requires explicit definition of all grants (opt-in)
* Loading: Added support for "view-source" protocol (Firefox 42+) ([#2479](https://github.com/greasemonkey/greasemonkey/pull/2479))
* Loading: Added support for "content-document-global-created" instead of "document-element-inserted" (opt-in) ([#1849](https://github.com/greasemonkey/greasemonkey/issues/1849))
* General: Add a message (into the log) if a script was removed (if is not complete)
* Loading: about:blank, the script with alert function - after the restart, the browser hangs ([#2229](https://github.com/greasemonkey/greasemonkey/issues/2229))
* Style clean up

#### 3.12.1beta11 (2017-07-04)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta10ForkExperimental...3.12.1beta11ForkExperimental)

* API - a experimental feature: @require / @resource - A "file" URI scheme - Parse the path to verify that it is not out of range (opt-in) ([#1961](https://github.com/greasemonkey/greasemonkey/issues/1961))
* API: GM_addStyle - @run-at document-start (Firefox 55+) ([#2515](https://github.com/greasemonkey/greasemonkey/issues/2515))
* General: Sync - Deleting non-existent values (opt-in)
* Loading: Include, Match and Exclude rules override ([#1946](https://github.com/greasemonkey/greasemonkey/issues/1946), [#1992](https://github.com/greasemonkey/greasemonkey/issues/1992), [#2343](https://github.com/greasemonkey/greasemonkey/issues/2343))
* GUI: Options - The view editor path
* Fix typos, style clean up

#### 3.12.1beta10 (2017-05-29)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta9ForkExperimental...3.12.1beta10ForkExperimental)

* API: GM_...value - "sendRpcMessage" instead of "sendSyncMessage" ([#2506](https://github.com/greasemonkey/greasemonkey/issues/2506), [#2507](https://github.com/greasemonkey/greasemonkey/pull/2507))
* API: GM_registerMenuCommand - Frames (it won't add any menu commands) ([#2509](https://github.com/greasemonkey/greasemonkey/issues/2509))
* General: The RegExp object - small performance improvements
* General: Changed the name - From: `Greasemonkey` To: `Greasemonkey for Pale Moon`
* General - a note: The extension ID and branding (icons) - I don't know, if and when it will happen
* Fix typos, style clean up

#### 3.12.1beta9 (2017-05-22)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta8ForkExperimental...3.12.1beta9ForkExperimental)

* GUI: Rewriting code for "Show more details about this add-on"
* General: Added CHANGELOG.md
* Style clean up

#### 3.12.1beta8 (2017-05-04)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta7ForkExperimental...3.12.1beta8ForkExperimental)

* GUI: Updating a script resets its automatic update configuration ([#2499](https://github.com/greasemonkey/greasemonkey/issues/2499), [#2501](https://github.com/greasemonkey/greasemonkey/pull/2501))
* GUI: Options - Fix enable / disable Sync
* General: Disabled this configuration - MacOS, e10s, "security.sandbox.content.level" > 1 ([#2485](https://github.com/greasemonkey/greasemonkey/issues/2485))
* GUI: Use middle-click, ctrl+right-click or shift+right-click in GM menu ([#1706](https://github.com/greasemonkey/greasemonkey/pull/1706), [#2504](https://github.com/greasemonkey/greasemonkey/issues/2504))
* Style clean up (many changes)

#### 3.12.1beta7 (2017-04-26)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta6ForkExperimental...3.12.1beta7ForkExperimental)

* API: Added support for GM_info.scriptHandler (some synchronize with Tampermonkey) ([#2495](https://github.com/greasemonkey/greasemonkey/pull/2495))
* API: Upgrade parseMetaLine.js from PEG.js 0.10.0
* API: Added support for GM_info.script\[copyright\] (some synchronize with Tampermonkey)
* API: Added support for GM_setClipboard(data, {object}) (some synchronize with Tampermonkey)
* API: Added an ability to catch errors in the code (GM_getResourceText / GM_getResourceURL / GM_setClipboard / GM_setValue)
* API: GM_openInTab - added support for null value in second parameter
* Style clean up

#### 3.12.1beta6 (2017-04-20)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta5ForkExperimental...3.12.1beta6ForkExperimental)

* General: Better delete temporary directories
* Loading: HTTP Auth - can't install userscript (follow up) ([#1717](https://github.com/greasemonkey/greasemonkey/issues/1717), [#2430](https://github.com/greasemonkey/greasemonkey/pull/2430))
* GUI: (Also) Options window too large ([#2191](https://github.com/greasemonkey/greasemonkey/issues/2191))
* GUI: Disabled scripts are checked for automatic updates (opt-in) ([#1840](https://github.com/greasemonkey/greasemonkey/issues/1840))
* GUI: Properly update the AOM (pushed to upstream - not yet)
* GUI: A fix update icon in the AOM (after a change in the editor) (follow up)
* Fix typos, style clean up

#### 3.12.1beta5 (2017-04-12)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta4ForkExperimental...3.12.1beta5ForkExperimental)

* API: GM_util.compareVersion - Added support also the build ID
* General: Installing scripts - Pale Moon 27.3.0a1+ - cache turned off ([#2407](https://github.com/greasemonkey/greasemonkey/pull/2407), [PaleMoon#1002](https://github.com/MoonchildProductions/Pale-Moon/pull/1002))
* Fix typo

#### 3.12.1beta4 (2017-04-11)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta3ForkExperimental...3.12.1beta4ForkExperimental)

* General: Loading web page (*.user.js) (follow up) ([#2407](https://github.com/greasemonkey/greasemonkey/pull/2407), [PaleMoon#1002](https://github.com/MoonchildProductions/Pale-Moon/pull/1002))
* General: Increase the minimum version require of Pale Moon - 27.1 ([PaleMoon#773](https://github.com/MoonchildProductions/Pale-Moon/issues/773))
* General: [use strict] If Cc / Ci / Cu / Cr != undefined, set variables
* Fix typos, style clean up

#### 3.12.1beta3 (2017-04-07)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta2ForkExperimental...3.12.1beta3ForkExperimental)

* General: Loading web page (*.user.js) (follow up) ([#2407](https://github.com/greasemonkey/greasemonkey/pull/2407), [PaleMoon#1002](https://github.com/MoonchildProductions/Pale-Moon/pull/1002))
* Style clean up

#### 3.12.1beta2 (2017-04-06)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.12.1beta1ForkExperimental...3.12.1beta2ForkExperimental)

* GUI: The install window - If the button "Install" is pressed too soon, throws an errors (improvements)
* General: Loading web page (*.user.js) (improvements) ([#2407](https://github.com/greasemonkey/greasemonkey/pull/2407), [PaleMoon#1002](https://github.com/MoonchildProductions/Pale-Moon/pull/1002))
* Style clean up

#### 3.12.1beta1 (2017-03-30)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.9.3.1ForkExperimental...3.12.1beta1ForkExperimental)

* API: Added support for frequent calls to GM_getValue ([#2333](https://github.com/greasemonkey/greasemonkey/pull/2333))
* API: Do not use GM_util.uriFromUrl to parse @match data ([#2480](https://github.com/greasemonkey/greasemonkey/issues/2480))
* GUI: Added support the dialog resizing (for Windows OS) ([#2194](https://github.com/greasemonkey/greasemonkey/pull/2194))
* GUI: Added configurable limit the time for AOM's "[Forced] Find updates" ([#2180](https://github.com/greasemonkey/greasemonkey/pull/2180))
* API: GM_registerMenuCommand (the suffix) - added support for SHA256 ([PaleMoon#914](https://github.com/MoonchildProductions/Pale-Moon/pull/914))
* GUI: Script Preferences - Added match a string (for editing) (pushed to upstream - no, checking when saving)
* GUI: Script Preferences / Options - Added display count of rows and better scrolling
* API: Added proper support for "about:blank" and "@run-at document-start" ([#1849#issuecomment-107177049](https://github.com/greasemonkey/greasemonkey/issues/1849#issuecomment-107177049))
* Loading: If Greasemonkey is disabled, some scripts works (follow up) ([#2416](https://github.com/greasemonkey/greasemonkey/issues/2416), [#2417](https://github.com/greasemonkey/greasemonkey/pull/2417))
* API: GM_xmlhttpRequest - Fix bug with the "anonymous" mode ([#2330](https://github.com/greasemonkey/greasemonkey/pull/2330)), ([PaleMoon#968](https://github.com/MoonchildProductions/Pale-Moon/pull/968))
* General: Updating scripts / Stats - Detecting the private mode (pushed to upstream - not yet)
* GUI: The install window - If the button "Install" is pressed too soon, throws an errors (pushed to upstream - not yet)
* GUI: The fix update icon in the AOM (after a change in the editor) (pushed to upstream - not yet)
* API / GUI: A needed fix for script update (if contains userMatches) ([#2455#issuecomment-289063866](https://github.com/greasemonkey/greasemonkey/pull/2455#issuecomment-289063866))
* General: Added the @homepageURL
* General: Added contributors and translators
* Fix typos, style clean up + refactoring code
__(very many changes - this is why it is beta at this point)__

#### 3.9.3.1 (2017-02-22)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.9.3ForkExperimental...3.9.3.1ForkExperimental)

* Added support for Add-ons Button

#### 3.9.3 (2017-02-18)

[All](https://github.com/janekptacijarabaci/greasemonkey/compare/3.9.2Fork...3.9.3ForkExperimental)

* API: Added support for GM_notification ([#1194](https://github.com/greasemonkey/greasemonkey/issues/1194))
* Loading: HTTP Auth - can't install userscript ([#1717](https://github.com/greasemonkey/greasemonkey/issues/1717), [#2430](https://github.com/greasemonkey/greasemonkey/pull/2430))
* The context menu: "View User Script Source" - detection of the separator ([#1914](https://github.com/greasemonkey/greasemonkey/issues/1914), [#1979](https://github.com/greasemonkey/greasemonkey/pull/1979))
* Loading: Added support for CORS/CSP override ([#2046](https://github.com/greasemonkey/greasemonkey/issues/2046))
* The list of the user scripts - added support sorting by namespace ([#2306](https://github.com/greasemonkey/greasemonkey/issues/2306), [#2334](https://github.com/greasemonkey/greasemonkey/pull/2334))
* Loading: Improve handling of script install failures ([#2390](https://github.com/greasemonkey/greasemonkey/issues/2390), [#2415](https://github.com/greasemonkey/greasemonkey/pull/2415))
* Loading: If Greasemonkey is disabled, some scripts works ([#2416](https://github.com/greasemonkey/greasemonkey/issues/2416), [#2417](https://github.com/greasemonkey/greasemonkey/pull/2417))
* Scratchpad: Deleting other menu items ([#2419](https://github.com/greasemonkey/greasemonkey/pull/2419))
* API: GM_xmlhttpRequest - ftp, invalid url, network error ([#2423](https://github.com/greasemonkey/greasemonkey/pull/2423))
* API: GM_registerMenuCommand - errors vs. invalid link ([#2434](https://github.com/greasemonkey/greasemonkey/pull/2434))
* API: GM_getResourceURL - no resource with name ([#2434](https://github.com/greasemonkey/greasemonkey/pull/2434))
* Update: Error updating - display an error message ([#2441](https://github.com/greasemonkey/greasemonkey/issues/2441), [#2442](https://github.com/greasemonkey/greasemonkey/pull/2442))
* API: GM_listValues - removing old code ([#2454](https://github.com/greasemonkey/greasemonkey/pull/2454))
* General: Added support for Pale Moon (27.x) ([#2456](https://github.com/greasemonkey/greasemonkey/pull/2456))
* API: GM_xmlhttpRequest - responseHeaders (etc.) at readyState 2 ([#2460](https://github.com/greasemonkey/greasemonkey/issues/2460), [#2461](https://github.com/greasemonkey/greasemonkey/pull/2461))
* Loading: Added support for "jar:file://" (e.g. zipped Java docs) ([#2227](https://github.com/greasemonkey/greasemonkey/issues/2227), [#2477](https://github.com/greasemonkey/greasemonkey/pull/2477))
* API: The sequential focus order when closing tabs opened by GM_openInTab - a partial fix ([#2269](https://github.com/greasemonkey/greasemonkey/issues/2269))
* API: GM_xmlhttpRequest connection doesn't abort when the tab is closed - a partial fix ([#2385](https://github.com/greasemonkey/greasemonkey/issues/2385))
* API: Added support for GM_info.script\[author/homepage/lastUpdated\] (some synchronize with Tampermonkey)
* Style clean up, removing old code (the unification code) (e.g. [#2455](https://github.com/greasemonkey/greasemonkey/pull/2455))
* Style clean up:
* Loading: MatchPattern - better display errors ([#2480](https://github.com/greasemonkey/greasemonkey/issues/2480))
* From: `Cc["@mozilla.org/..mm` To: `Services.mm/ppmm/cpmm`
* From: `"__defineGetter__"/"__defineSetter__"` To: `Object.defineProperty`
