## Changelog

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
