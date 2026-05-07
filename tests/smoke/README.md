# Smoke-test set — Greasemonkey for UXP

**Purpose:** the regression net for the legacy-cleanup work (Phases 4–7).

This directory contains 15 minimal user scripts, each exercising one
major code path. All of them log to the **Browser Console** (Pale Moon /
Basilisk → Tools → Web Developer → Browser Console, or `Ctrl+Shift+J`)
with a tagged prefix like `[GM-SMOKE-NN]` so passes and failures are
easy to grep.

The set is designed to be installed once, exercised against the runner
page (`runner.html`), and re-run after every cleanup phase. Anything
that changes between runs is a regression.

This directory is **not shipped in the XPI** — it's developer-only.
The XPI build script excludes `tests/` (alongside `_attic/`, `.git/`,
`docs/`, etc.).

---

## Running the set

### One-time setup

1. Install the latest in-development XPI in your Pale Moon / Basilisk profile.
2. Open `runner.html` (in this directory) in the browser. The simplest path:
   ```
   file:///D:/Vibe%20coding/greasemonkey-for-UXP-browsers-Beta/tests/smoke/runner.html
   ```
   …or any equivalent absolute file:// URL on your machine.

   Some tests need an `https://`/`http://` origin (CORS, cookies, `@require`,
   `@resource`). Those tests will note `requires HTTP origin` in the table
   below. For those, run a tiny static server from this folder:
   ```
   python -m http.server 8000
   ```
   …then open `http://localhost:8000/runner.html`.

3. Drag-install each `*.user.js` file from this folder into the browser,
   one at a time. Confirm the install dialog for each.

4. Open the **Browser Console** (`Ctrl+Shift+J`). Keep it visible.

### Per-test run

For each test, navigate (or reload) `runner.html` and read the console.
Some tests need extra steps (toggling iframes, clicking the toolbar
icon for menu commands). Those steps are listed in the table below
under "How to verify."

### Before/after comparison

Save the console output to a file *before* a cleanup phase, then save
again *after*. `diff` them. If the only differences are timestamps or
ordering, the phase is regression-clean.

---

## Test catalogue

| # | Script | What it proves | Origin needed | Grants used | How to verify |
|---|--------|----------------|---------------|-------------|---------------|
| 01 | `01-trivial-injection.user.js` | A no-grant script runs at all | any (runner.html) | none | Console shows `[GM-SMOKE-01] PASS — sandbox executes basic JS` |
| 02 | `02-match-glob.user.js` | `@match` wildcard URL pattern matches | runner.html (any origin) | none | Console shows `[GM-SMOKE-02] PASS — @match wildcard matched` on runner.html, NOT on `runner-other.html` |
| 03 | `03-include-regex.user.js` | `@include` regex pattern matches | runner.html | none | Console shows `[GM-SMOKE-03] PASS — @include regex matched` |
| 04 | `04-exclude.user.js` | `@exclude` overrides `@match` | runner.html + runner-excluded.html | none | Console shows `[GM-SMOKE-04] PASS — should NOT appear on excluded URLs` on runner.html only. NOT on `runner-excluded.html`. |
| 05 | `05-storage-roundtrip.user.js` | `GM_setValue` / `GM_getValue` survive reload | runner.html | GM_setValue, GM_getValue | Reload runner.html several times. Each console line should show an incrementing counter. |
| 06 | `06-xmlhttprequest.user.js` | `GM_xmlhttpRequest` cross-origin works, `@connect` honored | http(s) origin | GM_xmlhttpRequest, GM_log; `@connect httpbin.org` | Console shows `[GM-SMOKE-06] PASS — xhr status=200`. (Requires `httpbin.org` reachable.) |
| 07 | `07-unsafe-window.user.js` | `unsafeWindow` writes to the page global | runner.html | unsafeWindow | After load, in the **Web Console** (page console, not Browser Console) type `__GM_SMOKE_07__` and see `"hello"`. |
| 08 | `08-run-at-start.user.js` | `@run-at document-start` fires before the page is parsed | runner.html | none | Console shows `[GM-SMOKE-08] PASS — readyState=loading` (or occasionally `interactive` on very fast loads). NEVER `complete`. |
| 09 | `09-noframes.user.js` | `@noframes` skips the iframe load | runner.html (with iframe) | none | Console shows ONE PASS line, not two. The iframe load must NOT log. |
| 10 | `10-require-external.user.js` | `@require` fetches and concatenates an external lib at install time | runner.html (install requires HTTP) | none | Console shows `[GM-SMOKE-10] PASS — $: function jQuery: function`. Install happens once; the lib is then on disk. |
| 11 | `11-resource.user.js` | `@resource` fetches at install time, retrievable via `GM_getResourceText` | runner.html (install requires HTTP) | GM_getResourceText | Console shows `[GM-SMOKE-11] PASS — resource bytes=N` where N > 0 |
| 12 | `12-menu-command.user.js` | `GM_registerMenuCommand` adds an entry to the GM context menu | runner.html | GM_registerMenuCommand | After load, click the GM toolbar icon → menu shows "Smoke Test 12". Click it → console logs `[GM-SMOKE-12] invoked`. |
| 13 | `13-grant-none.user.js` | `@grant none` sandboxes correctly: GM_* must NOT be present | runner.html | none | Console shows `[GM-SMOKE-13] PASS — @grant none; GM_* visible: false` |
| 14 | `14-gm4-polyfill.user.js` | The GM.* Promise polyfill works for setValue/getValue | runner.html | GM_setValue, GM_getValue | Console shows `[GM-SMOKE-14] PASS — GM.* polyfill v=<timestamp>` |
| 15 | `15-gm-cookie.user.js` | `GM.cookie.list` returns the page's cookies (or a sane error) | http(s) origin | GM_cookie | Console shows either `[GM-SMOKE-15] PASS — got N cookies` or `[GM-SMOKE-15] FAIL — <error>`. Either result is informative — failure is expected on UXP today and will be fixed in Phase 7. |

### Test-15 note (GM_cookie)

GM_cookie is the most likely-to-fail entry today because the fork ships a
third-party polyfill gated behind `extensions.greasemonkey.api.GM_cookie`
(default false). Set that pref to `true` in `about:config` before running
test 15. After Phase 7 (native chrome-side `GM_cookie`), the pref goes
away and this test passes by default.

---

## Pages used by the test set

- **`runner.html`** — primary target. Embeds an iframe pointing at
  `runner-frame.html` (used by test 09). Has visible markers so you can
  tell at a glance whether scripts ran.
- **`runner-frame.html`** — iframe content. Test 09 must NOT execute here.
- **`runner-excluded.html`** — exclusion target. Tests 02 and 04 must
  NOT execute here.
- **`runner-other.html`** — non-matching target. Test 02 must NOT
  execute here.

All four pages are static HTML with no script loading from outside —
they don't change behavior between runs.

---

## Recording results

A simple template (paste into your notes for each phase):

```
=== Smoke run @ <git short-sha>, <date> ===
01: PASS / FAIL <note>
02: PASS / FAIL <note>
…
15: PASS / FAIL <note>

Failures vs previous run: <list, or "none">
```

Append the entries to `tests/smoke/results.log` (gitignored) so you have
a chronological record.

---

## Updating the set

After a cleanup phase introduces or removes a feature (e.g. Phase 7 makes
GM_cookie native), update:

1. The relevant `*.user.js` to reflect the new expected behavior.
2. The pass criterion in this README.
3. The test-15-note section above.

Do NOT delete a test just because it now passes by default. The test
catalogues *what we promise scripts can rely on*; that's a contract worth
keeping written down.
