/**
 * @file scriptPrefs.js
 * @overview Per-script preferences dialog logic.  Pairs with
 *   chrome://greasemonkey/content/scriptPrefs.xul.
 *
 * 3.7.0 redesign:
 *   - Two top-level tabs (Settings / Values).  Values is wired up in M3.
 *   - Settings tab contains four sections, populated below:
 *       1. Metadata (read-only display of @name / @namespace / @version /
 *          @description / @author / @homepageURL / @supportURL /
 *          @updateURL / @downloadURL / install + last-update timestamps).
 *       2. Behaviour (run-at, no-frames, inject-into, automatic-updates
 *          radio, execution-position dropdown).  Editable; persisted on
 *          OK via the existing Script setters and config._changed().
 *       3. Pages — the existing user-vs-script include/match/exclude
 *          UX, restructured into a single panel so users see both at
 *          once instead of flipping between two tabs.
 *       4. Permissions (read-only summary of @grant / @connect /
 *          @require / @resource / @antifeature).
 *
 * The dialog's OK button persists every editable field; Cancel discards
 * them.  Edit Script (bottom row) opens the script in the user's
 * configured editor (now Scratchpad-by-default again after the editor
 * work was parked to _attic/editor-draft/).
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

// Ref'd in XUL.
Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("resource://gre/modules/PluralForm.jsm");
Cu.import("resource://gre/modules/Services.jsm");

// GM_CONSTANTS — for the localized auto-update confirmation bundle.
Cu.import("chrome://greasemonkey-modules/content/constants.js");

// AddonManager constants for the Auto-update radio mapping.
Cu.import("resource://gre/modules/AddonManager.jsm");

// The script's add-on: Automatic Updates are set through it, so the
// Add-ons Manager hears about the change.
Cu.import("chrome://greasemonkey-modules/content/addons.js");

// Storage back-end for the Values tab.
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");

// Persisted window-size pref store (see resize handlers below).  Used in
// place of XUL `persist="width height"` on <window>, because XUL persist
// keys per-document-URI — and every script's prefs URL has a unique
// `#<scriptId>` fragment, which means each script saves and restores its
// OWN dimensions in xulstore.json.  That was the root cause of users
// reporting "different scripts have different window sizes".  A single
// global GM_prefRoot key gives every script the same shared size.
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");


////////////////////////////// Resolution + cache /////////////////////////////

var gScriptId = decodeURIComponent(location.hash.substring(1));
var gScript = GM_util.getService().config.getMatchingScripts(
    function (aScript) {
      return aScript && (aScript.id == gScriptId);
    })[0];

/** The position (0-based) the dropdown shows as the script's own.  OK
 *  moves the script only when the user picked another one. */
var gInitialPosition = -1;

/** The Automatic Updates value (AddonManager.AUTOUPDATE_*) the radio shows
 *  as the script's own.  OK writes the radio only when the user changed
 *  it: a local edit can switch updates off while this window is open, and
 *  writing the untouched radio back used to switch them on again. */
var gShownAutoUpdate = null;

/** The value the user agreed to switch updates back on to, in the prompt
 *  for a script with local edits, so OK doesn't ask a second time. */
var gConfirmedAutoUpdate = null;

/** True once the Values tab could read the script's values; Add / Edit /
 *  Delete need it. */
var gValuesReadable = false;

/**
 * The script's storage Back (modules/storageBack.js), looked up on each
 * use.  It is the one the script's pages use, so an edit here reaches
 * them at once: their cached reads and their value-change listeners.  A
 * private Back (its own connection) used to leave them on the old value.
 */
function valuesStorage() {
  return getStorageBackForScript(gScript);
}

/** In-memory snapshot of the script's stored key/value pairs.  Keys come
 *  from listValues(); values are the *parsed* result of JSON.parse on
 *  the raw DB column, so the tree view can render the type label
 *  ("string", "number", "boolean", "object", "null") without re-parsing
 *  on every redraw.  Re-built whenever a value is added / edited / deleted. */
var gValuesData = [];

/**
 * Keeps the window in step with changes made elsewhere while it is open
 * (about:addons, the toolbar menu, a local edit, Sync).  It watches every
 * script, because moving or installing another one changes this one's
 * position.
 *
 * Its script uninstalled closes the window, which is also how an update
 * or a reinstall replaces it: the new version is a new Script object, so
 * everything shown here would be stale, and OK would save into a script
 * that is no longer installed.
 */
var gScriptObserver = {
  "notifyEvent": function (aScript, aEvent, aData) {
    if (aScript === gScript) {
      switch (aEvent) {
        case "uninstall":
          window.close();
          return undefined;
        case "edit-enabled":
          syncToggleEnabledButton();
          break;
        case "modified":
          refreshAutoUpdateRadio();
          // Its files may have come in (an import fetches them after).
          populateExternalsTab();
          break;
      }
    }
    if ((aEvent == "move") || (aEvent == "install")
        || (aEvent == "uninstall") || (aEvent == "pending-uninstall")) {
      refreshPositionDropdown();
    }
  },
};

/** Cached XUL elements indexed by friendly name. */
var gElm = {
  "scriptIncludes": "script-includes",
  "scriptMatches":  "script-matches",
  "scriptExcludes": "script-excludes",
  "userIncludes":   "user-includes",
  "userMatches":    "user-matches",
  "userExcludes":   "user-excludes",
  "userOverride":   "user-override",
};

////////////////////////////// Window onload //////////////////////////////////

window.addEventListener("load", function () {
  // % is reserved in a DTD context, so the title contains "!!" as a
  // placeholder substituted at runtime.
  document.title = document.title.replace("!!", gScript.localized.name);

  // Resolve every cached id to its element.
  Object.getOwnPropertyNames(gElm).forEach(function (aProp) {
    gElm[aProp] = document.getElementById(gElm[aProp]);
  });

  populatePagesSection();
  populateMetadataSection();
  populateBehaviourSection();
  populatePermissionsSection();
  populateValuesTab();
  populateExternalsTab();
  syncToggleEnabledButton();
  installReadonlyListTooltips();
  installScrollBubbling();
  GM_util.getService().config.addObserver(gScriptObserver);

  // ── 3.7.0 feedback #4: every script opens at the same size ───────
  // Restore the user's last-chosen size from a GLOBAL pref, NOT from
  // the per-URL XUL persist store.  Users were seeing wildly varying
  // dialog sizes between scripts because xulstore.json keyed on the
  // `#<scriptId>` URL fragment, so each script remembered a different
  // size.  Now they all share `scriptPrefs.windowWidth/Height`, with
  // a default of 720×720.  Save on resize *and* on unload — relying
  // on the resize debounce alone meant a quick close-after-resize
  // dropped the new dimensions on the floor.
  applyPersistedSize();

  // XUL <window> auto-grows past the declared / programmatic-resize
  // target when content's intrinsic min-content is wider — long
  // no-wrap @updateURL / @downloadURL values in the metadata grid,
  // long no-wrap @match patterns in cludes lists, etc.  The growth
  // happens during the layout pass that runs *after* this listener
  // returns, so the resizeTo() inside applyPersistedSize() is
  // silently clobbered, and savePersistedSize() then captures the
  // auto-grown width and writes it back to the pref — poisoning
  // future opens.
  //
  // setTimeout(0) lets the layout pass complete, then we re-resize
  // back to the persisted target.  The resize listener is attached
  // *after* the snap-back so it doesn't record the intermediate
  // auto-grown size as a "user resize".
  setTimeout(function () {
    snapBackToPersistedSize();
    window.addEventListener("resize", onWindowResize, false);
  }, 0);
}, false);

// Persist whatever size the window currently has when it is closed,
// even if a debounced resize-handler is still pending.  Without this,
// a user who resized and immediately clicked OK / Cancel could see
// the next open re-use the OLD size.
window.addEventListener("unload", function () {
  try { savePersistedSize(); } catch (e) {}
}, false);

window.addEventListener("unload", function () {
  GM_util.getService().config.removeObserver(gScriptObserver);
}, false);


////////////////////////////// Pages section //////////////////////////////////

function populatePagesSection() {
  // User-side cludes wire up exactly as in the previous design.
  gElm.userIncludes.pages = gScript.userIncludes;

  // The "moved to user-side via context-menu" callbacks no longer need a
  // tab switch (single-form layout), so the helpers just delegate.
  // The script's own rules, each list with its "Add as user ..." buttons:
  // its includes and excludes as a user include or exclude, its matches
  // as a user match.
  let addUserInclude = function (aPage) {
    gElm.userIncludes.addPage(aPage);
  };
  let addUserExclude = function (aPage) {
    gElm.userExcludes.addPage(aPage);
  };
  gElm.scriptIncludes.pages = gScript.includes;
  gElm.scriptIncludes.onAddUserInclude = addUserInclude;
  gElm.scriptIncludes.onAddUserExclude = addUserExclude;

  let matchesPattern = [];
  for (let i = 0, iLen = gScript.matches.length; i < iLen; i++) {
    matchesPattern.push(gScript.matches[i].pattern);
  }
  gElm.scriptMatches.pages = matchesPattern;
  gElm.scriptMatches.onAddUserMatch = function (aPage) {
    gElm.userMatches.addPage(aPage);
  };

  let userMatchesPattern = [];
  for (let i = 0, iLen = gScript.userMatches.length; i < iLen; i++) {
    userMatchesPattern.push(gScript.userMatches[i].pattern);
  }
  gElm.userMatches.pages = userMatchesPattern;

  gElm.scriptExcludes.pages = gScript.excludes;
  gElm.scriptExcludes.onAddUserInclude = addUserInclude;
  gElm.scriptExcludes.onAddUserExclude = addUserExclude;
  gElm.userExcludes.pages = gScript.userExcludes;

  gElm.userOverride.checked = gScript.userOverride;

  // Populate live counters next to each list header.  (Updated by the
  // <cludes> binding's own observer, but seed the initial value here.)
  updatePagesCounters();
}

function updatePagesCounters() {
  function setCount(aId, aValue) {
    let el = document.getElementById(aId);
    if (el) el.value = "(" + aValue + ")";
  }
  setCount("user-includes-count",   gScript.userIncludes.length);
  setCount("user-matches-count",    gScript.userMatches.length);
  setCount("user-excludes-count",   gScript.userExcludes.length);
  setCount("script-includes-count", gScript.includes.length);
  setCount("script-matches-count",  gScript.matches.length);
  setCount("script-excludes-count", gScript.excludes.length);
}

////////////////////////////// Metadata section ///////////////////////////////

function populateMetadataSection() {
  // Plain `value=` for non-link single-line fields.
  setLabel("meta-name",        gScript.localized.name || gScript.name || "");
  setLabel("meta-namespace",   gScript.namespace      || "");
  setLabel("meta-version",     gScript.version        || "—");
  setLabel("meta-author",      gScript.author         || "");
  // "none" is what the metadata says for an old copy that must not update
  // (updateURL is null then; see Script.updatesDisabled).
  setLabel("meta-updateurl",   gScript.updatesDisabled
      ? "none" : shownUrl(gScript.updateURL));
  setLabel("meta-downloadurl", shownUrl(gScript.downloadURL));

  // Description can be multi-line; use a <description> instead of a
  // <label> in the XUL and write through textContent.
  let desc = document.getElementById("meta-description");
  if (desc) {
    while (desc.firstChild) desc.removeChild(desc.firstChild);
    let descText = gScript.localized.description || gScript.description || "";
    desc.appendChild(document.createTextNode(descText));
  }

  // Clickable links.  Homepage is what the script declares; without one, a
  // web-address @namespace stands in, greyed and marked as such.  The
  // script's page on its host (GreasyFork etc.) has a row of its own.
  let declaredHomepage = gScript.declaredHomepageURL;
  setLink("meta-homepage", declaredHomepage || gScript.namespaceURL || "",
      declaredHomepage ? null : localizedString(
          "scriptPrefs.homepage.fromNamespace", "(from @namespace)"));
  setLink("meta-scriptpage",   gScript.scriptPageURL   || "");
  setLink("meta-support",      gScript.supportURL      || "");
  setLink("meta-contribution", gScript.contributionURL || "");
  // Few scripts ask for donations, so that row shows only when one does.
  document.getElementById("meta-contribution-row").hidden =
      !gScript.contributionURL;
  document.getElementById("meta-scriptpage-key").value = localizedString(
      "scriptPrefs.label.scriptPage", "Script page");
  document.getElementById("meta-contribution-key").value = localizedString(
      "scriptPrefs.label.contribution", "Contribute");

  // Installed is the first install, which updates keep; Last updated is
  // the script file's latest change, an update or the user's own edit.
  // Both are ms-since-epoch numbers (or null for very old configs),
  // formatted with the user's locale conventions.  (modifiedDate is a
  // Date even for a null time, so test the number.)
  let installDate = gScript.firstInstallTime
      ? new Date(gScript.firstInstallTime).toLocaleString()
      : "—";
  let lastUpdate = gScript._modifiedTime
      ? gScript.modifiedDate.toLocaleString()
      : "—";
  setLabel("meta-installed",  installDate);
  setLabel("meta-size",       computeScriptSizeLabel());
  setLabel("meta-lastupdate", lastUpdate);
}

/**
 * Returns a human-readable size string for the script's .user.js file.
 * Probes via nsIFile.fileSize so this works regardless of whether the
 * config object has a cached size.  Falls back to a localised "Unknown"
 * if the file does not exist or fileSize throws.
 */
function computeScriptSizeLabel() {
  let bytes = null;
  try {
    let f = gScript.file;
    if (f && f.exists()) {
      bytes = f.fileSize;
    }
  } catch (e) {
    bytes = null;
  }
  return formatSize(bytes);
}

/**
 * Auto-scales the unit:
 *   < 1 KB  → "%1 bytes"
 *   < 10 KB → "%1 KB" with one decimal place; < 1 MB, a whole number
 *   ≥ 1 MB  → "%1 MB" with two decimal places
 *
 * @param {number|null} aBytes - null when unknown.
 * @returns {string} "512 bytes", "3.4 KB", "12 KB", "1.25 MB" or "Unknown".
 */
function formatSize(aBytes) {
  if ((aBytes === null) || (typeof aBytes == "undefined")) {
    return localizedString("scriptPrefs.size.unknown", "Unknown");
  }
  if (aBytes < 1024) {
    return localizedString("scriptPrefs.size.bytes", "%1 bytes")
        .replace("%1", aBytes.toString());
  }
  if (aBytes < 1024 * 1024) {
    let kb = aBytes / 1024;
    return localizedString("scriptPrefs.size.kb", "%1 KB")
        .replace("%1", (kb < 10) ? kb.toFixed(1) : Math.round(kb).toString());
  }
  return localizedString("scriptPrefs.size.mb", "%1 MB")
      .replace("%1", (aBytes / (1024 * 1024)).toFixed(2));
}

/**
 * What the Update URL and Download URL rows show for an address.  A
 * script made here (New script, Scratchpad) has its own file in the
 * scripts folder as its address, and one dropped in from a file has that
 * file's: there is nothing to update from, and the path showed the
 * Windows user name.
 *
 * @param {string|null} aUrl
 * @returns {string}
 */
function shownUrl(aUrl) {
  if (aUrl && /^file:/i.test(aUrl)) {
    return localizedString(
        "scriptPrefs.url.fromFile", "none (installed from a file)");
  }
  return aUrl || "";
}

/**
 * Sets the visible text of a metadata <description> element.  Uses
 * textContent (not the `value` attribute) because in 3.7.0 the metadata
 * fields are <description> rather than <label value="">, so the text is
 * a real DOM text node and the user can drag-select it for copy / paste.
 */
function setLabel(aId, aValue) {
  let el = document.getElementById(aId);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  el.appendChild(document.createTextNode(aValue == null ? "" : "" + aValue));
}

/**
 * Same as setLabel but for the link fields (homepage, script page, support,
 * contribution), which also need their stored URL stashed somewhere
 * onLinkClick can read it.  (Reading textContent at click time would lose
 * the original URL if it ever displays differently than its stored form,
 * e.g. truncated by CSS ellipsis.)
 *
 * @param {string} aId
 * @param {string} aUrl
 * @param {string} [aNote] - Where a stand-in link comes from, e.g.
 *   "(from @namespace)": shown after it, and the link is greyed.
 */
function setLink(aId, aUrl, aNote) {
  let el = document.getElementById(aId);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  let noted = !!(aUrl && aNote);
  if (aUrl) {
    el.appendChild(document.createTextNode(aUrl));
    if (noted) {
      let note = document.createElementNS(
          "http://www.w3.org/1999/xhtml", "span");
      note.className = "prefs-meta-note";
      note.textContent = aNote;
      el.appendChild(document.createTextNode(" "));
      el.appendChild(note);
    }
    el.setAttribute("tooltiptext", aUrl);
    el._gmHref = aUrl;
  } else {
    el.removeAttribute("tooltiptext");
    el._gmHref = null;
  }
  if (noted) {
    el.setAttribute("derived", "true");
  } else {
    el.removeAttribute("derived");
  }
}

/**
 * A string from greasemonkey.properties, or aFallback while this locale
 * doesn't have the key yet (strings added since the last locale pass).
 */
function localizedString(aKey, aFallback) {
  return bundleStr(GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGreasemonkeyProperties), aKey, aFallback);
}

/**
 * A count in words: aKey's text in the form the locale's plural rule
 * picks for aCount ("%1 file;%1 files" gives "1 file", "2 files"); a text
 * with one form ("Entries: %1") serves any count.
 *
 * @param {string} aKey
 * @param {string} aFallback
 * @param {number} aCount
 * @returns {string}
 */
function countString(aKey, aFallback, aCount) {
  return PluralForm.get(aCount, localizedString(aKey, aFallback))
      .replace("%1", aCount);
}

/**
 * Click handler for the <description class="text-link"> link fields.
 * Opens the stored URL in a new tab of the most recent browser window.
 */
function onLinkClick(aEvent, aId) {
  let el = document.getElementById(aId);
  if (!el || !el._gmHref) return;
  openInBrowserTab(el._gmHref);
}

/**
 * Opens aUrl in a new, selected tab of the most recent browser window.
 *
 * @param {string} aUrl
 */
function openInBrowserTab(aUrl) {
  let chromeWin = Services.wm.getMostRecentWindow("navigator:browser");
  if (!chromeWin) return;
  try {
    chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(aUrl);
  } catch (e) {
    // Older Pale Moon builds expose addTab via a slightly different name.
    Services.console.logStringMessage(
        "Greasemonkey scriptPrefs: openLink failed: " + e);
  }
}

////////////////////////////// Behaviour section //////////////////////////////

function populateBehaviourSection() {
  // Run-at — Script.runAt is one of "document-start" | "document-body"
  // | "document-end" | "document-idle".
  let runAt = gScript.runAt || "document-end";
  let runAtMenu = document.getElementById("behave-runat");
  selectMenuByValue(runAtMenu, runAt);

  // No-frames — boolean flag.
  let noframesBox = document.getElementById("behave-noframes");
  noframesBox.checked = !!gScript.noframes;

  // Inject-into — "auto" | "page" | "content".
  let injectInto = gScript.injectInto || "auto";
  let injectMenu = document.getElementById("behave-injectinto");
  selectMenuByValue(injectMenu, injectInto);
  // What Auto means (Preferences' Injection mode), on the menu and its label.
  let injectTip = localizedString(
      "scriptPrefs.injectInto.tip", injectMenu.getAttribute("tooltiptext"));
  injectMenu.setAttribute("tooltiptext", injectTip);
  document.getElementById("behave-injectinto-label")
      .setAttribute("tooltiptext", injectTip);

  // GM_cookie's HTTP-only cookies: offered to scripts that use GM_cookie,
  // or already have it on, as in Violentmonkey.  Both this and the
  // Preferences switch must be on; the note says so while that one isn't.
  let grants = gScript.grants || [];
  document.getElementById("behave-httponly-row").hidden =
      !gScript.httpOnlyCookies && (grants.indexOf("GM_cookie") == -1)
          && (grants.indexOf("GM.cookie") == -1);
  let httpOnlyBox = document.getElementById("behave-httponly");
  httpOnlyBox.checked = !!gScript.httpOnlyCookies;
  httpOnlyBox.setAttribute("label", localizedString(
      "options.httpOnlyCookies", httpOnlyBox.getAttribute("label")));
  httpOnlyBox.setAttribute("tooltiptext", localizedString(
      "options.httpOnlyCookies.tip",
      httpOnlyBox.getAttribute("tooltiptext")));
  let httpOnlyNote = document.getElementById("behave-httponly-note");
  httpOnlyNote.textContent = localizedString(
      "scriptPrefs.httpOnlyCookies.globalOff", httpOnlyNote.textContent);
  httpOnlyNote.hidden =
      GM_prefRoot.getValue("api.GM_cookie.exposeHttpOnly", false);

  // Auto-update — Script.checkRemoteUpdates is one of
  // AddonManager.AUTOUPDATE_DEFAULT | _ENABLE | _DISABLE.
  let autoRadio = document.getElementById("behave-autoupdate");
  autoRadio.value = autoUpdateRadioValue(gScript.checkRemoteUpdates);
  gShownAutoUpdate = autoUpdateFromRadio(autoRadio.value);

  // A script that can never update has nothing to choose here: say why
  // instead, as the Add-ons Manager hides its own Automatic Updates control
  // then.  (Forced, so that merely being disabled doesn't count.)
  let cannotUpdate = !gScript.isRemoteUpdateAllowed(true);
  let never = document.getElementById("behave-autoupdate-never");
  autoRadio.hidden = cannotUpdate;
  never.hidden = !cannotUpdate;
  if (cannotUpdate) {
    setLabel("behave-autoupdate-never", gScript.updatesDisabled
        ? localizedString("scriptPrefs.autoUpdate.oldVersion",
            "Never: this is an old version of the script (its"
            + " @downloadURL is \"none\").  To get updates, install the"
            + " current version from the script's page.")
        : localizedString("scriptPrefs.autoUpdate.notUpdatable",
            "Never: the script has no web address it can be updated"
            + " from."));
  }

  // Position dropdown — populate "1 of N" through "N of N", select the
  // current index.  This is the TM-style "Execution position" control.
  populatePositionDropdown();
}

/**
 * @param {number} aAutoUpdate - An AddonManager.AUTOUPDATE_* value.
 * @returns {string} The Automatic Updates radio's value for it.
 */
function autoUpdateRadioValue(aAutoUpdate) {
  switch (aAutoUpdate) {
    case AddonManager.AUTOUPDATE_ENABLE:  return "enable";
    case AddonManager.AUTOUPDATE_DISABLE: return "disable";
    default:                              return "default";
  }
}

/**
 * @param {string} aValue - The Automatic Updates radio's value.
 * @returns {number} The AddonManager.AUTOUPDATE_* value it stands for.
 */
function autoUpdateFromRadio(aValue) {
  switch (aValue) {
    case "enable":  return AddonManager.AUTOUPDATE_ENABLE;
    case "disable": return AddonManager.AUTOUPDATE_DISABLE;
    default:        return AddonManager.AUTOUPDATE_DEFAULT;
  }
}

/**
 * Shows the script's current Automatic Updates when they change elsewhere
 * (a local edit switches them off; about:addons), unless the user has
 * already picked another value here.
 */
function refreshAutoUpdateRadio() {
  let autoRadio = document.getElementById("behave-autoupdate");
  if (!autoRadio || (gShownAutoUpdate === null)
      || (autoUpdateFromRadio(autoRadio.value) !== gShownAutoUpdate)) {
    return undefined;
  }
  autoRadio.value = autoUpdateRadioValue(gScript.checkRemoteUpdates);
  gShownAutoUpdate = autoUpdateFromRadio(autoRadio.value);
}

/**
 * Fires the moment the Automatic-updates radio changes.  If the user
 * flips it from Off to On / Default while the script still has local
 * edits, warn that the next update will overwrite those edits, and snap
 * the radio back to Off if they decline, as the Add-ons Manager's radio
 * does (ScriptAddon.confirmAutoUpdate in modules/addons.js).  OK doesn't
 * ask again for the value agreed to here.
 */
function onAutoUpdateChange() {
  let autoRadio = document.getElementById("behave-autoupdate");
  if (!autoRadio || !autoRadio.value) {
    return;
  }
  let next = autoUpdateFromRadio(autoRadio.value);
  let addon = ScriptAddonFactoryByScript(gScript);
  gConfirmedAutoUpdate = null;
  if (!addon.autoUpdateOverwritesEdits(next)) {
    return;
  }
  if (addon.confirmAutoUpdate(next)) {
    gConfirmedAutoUpdate = next;
  } else {
    // Snap back to Off.  A programmatic .value assignment doesn't re-fire
    // oncommand, and even if it did, "disable" can't satisfy the
    // re-enabling condition above — so there's no recursion risk.
    autoRadio.value = "disable";
  }
}

/**
 * Selects the menulist's <menuitem> whose `value` attribute matches
 * aValue, falling back to the first item when there's no match.
 */
function selectMenuByValue(aMenuList, aValue) {
  if (!aMenuList) return;
  let items = aMenuList.getElementsByTagName("menuitem");
  for (let i = 0; i < items.length; i++) {
    if (items[i].getAttribute("value") === aValue) {
      aMenuList.selectedIndex = i;
      return;
    }
  }
  if (items.length > 0) aMenuList.selectedIndex = 0;
}

/**
 * Rebuilds the position list when scripts are moved, installed or removed
 * elsewhere, unless the user has already picked a position here (OK then
 * moves the script there from wherever it is by then).
 */
function refreshPositionDropdown() {
  let menu = document.getElementById("behave-position");
  if (menu && menu.selectedItem && (parseInt(
      menu.selectedItem.getAttribute("value"), 10) !== gInitialPosition)) {
    return undefined;
  }
  populatePositionDropdown();
}

/**
 * The scripts the position list counts, in order: all but those removed
 * in the Add-ons Manager with Undo still offered (Script.setNeedsUninstall)
 * - and this one, however it stands.
 *
 * @returns {Script[]}
 */
function positionedScripts() {
  return (GM_util.getService().config.scripts || []).filter(
      function (aScript) {
        return (aScript === gScript) || !aScript.needsUninstall;
      });
}

/**
 * Builds the execution-position menulist with "1 of N", "2 of N", …
 * entries and selects the position matching the script's current index
 * among positionedScripts().  Stores it in gInitialPosition, so OK moves
 * the script only when the user picked another position.
 */
function populatePositionDropdown() {
  let scripts = positionedScripts();
  let total = scripts.length;
  let current = scripts.indexOf(gScript);
  if (current === -1) current = 0;
  gInitialPosition = current;

  let popup = document.getElementById("behave-position-popup");
  let menu = document.getElementById("behave-position");
  if (!popup || !menu) return;

  while (popup.firstChild) popup.removeChild(popup.firstChild);

  // Format "%1 of %2" via the localized properties bundle.  Fall back
  // to a plain "%1 / %2" if the bundle key is missing on this locale.
  let bundle = null;
  try {
    bundle = Services.strings.createBundle(
        "chrome://greasemonkey/locale/greasemonkey.properties");
  } catch (e) { /* very old builds may not have the bundle */ }

  for (let i = 0; i < total; i++) {
    let label;
    if (bundle) {
      try {
        label = bundle.GetStringFromName("scriptPrefs.position.format")
            .replace("%1", i + 1).replace("%2", total);
      } catch (e) {
        label = (i + 1) + " / " + total;
      }
    } else {
      label = (i + 1) + " / " + total;
    }
    let item = document.createElement("menuitem");
    item.setAttribute("value", "" + i);
    item.setAttribute("label", label);
    popup.appendChild(item);
  }
  menu.selectedIndex = current;

  // Populate the gray-text suffix showing total scripts.
  let suffix = document.getElementById("behave-position-suffix");
  if (suffix && bundle) {
    try {
      suffix.value = bundle.GetStringFromName("scriptPrefs.position.suffix")
          .replace("%1", total);
    } catch (e) {
      suffix.value = "";
    }
  }
}

////////////////////////////// Permissions section ////////////////////////////

function populatePermissionsSection() {
  // Some scripts (e.g. AdsBypasser) literally declare both
  //   @grant GM_registerMenuCommand
  //   @grant GM.registerMenuCommand
  // — that's two distinct grant strings, but a user reasonably reads
  // them as the same API surfaced under both naming conventions.  We
  // also see scripts that include the SAME grant twice by accident.
  // Dedupe both before joining so the Permissions row stays readable.
  let grants = uniq(gScript.grants       || []);
  let connects = uniq(gScript.connects   || []);
  let antifeatures = uniq(gScript.antifeatures || []);
  setMultilineDesc("perms-grants",       grants.join(", "));
  setMultilineDesc("perms-connects",     connects.join(", "));
  setMultilineDesc("perms-antifeatures", antifeatures.join(", "));

  // @require: a ScriptRequire per line; @resource: name and address.
  fillDependencyRows("perms-requires", (gScript.requires || []).map(
      function (r) {
        return (r && r.downloadURL) ? { "address": r.downloadURL } : null;
      }));
  fillDependencyRows("perms-resources", (gScript.resources || []).map(
      function (r) {
        if (!r || !(r.name || r.downloadURL)) return null;
        return { "name": r.name || "", "address": r.downloadURL || "" };
      }));
}

/** A pinned hash in a dependency address's #fragment (Tampermonkey's set). */
const PINNED_HASH_REGEXP = /^(md5|sha1|sha256|sha384|sha512)[=:\-]\S+$/i;

/**
 * Splits a dependency address into what the row shows and its pinned
 * hashes ("…/lib.js#sha256-…", "#sha256=…,sha512=…").  Only a fragment
 * made of hashes alone is taken off; any other fragment stays in the
 * address.
 *
 * @param {string} aAddress - A @require / @resource address, as written.
 * @returns {{address: string, hashes: string[]}}
 */
function splitPinnedHashes(aAddress) {
  let at = aAddress.indexOf("#");
  if (at < 0) {
    return { "address": aAddress, "hashes": [] };
  }
  let fragment = aAddress.slice(at + 1);
  try {
    // A space-separated list arrives as "%20".
    fragment = decodeURIComponent(fragment);
  } catch (e) {
    // A stray "%": read the fragment as it is.
  }
  let hashes = fragment.split(/[,;\s]+/).filter(function (aPart) {
    return aPart != "";
  });
  if (!hashes.length || !hashes.every(function (aPart) {
    return PINNED_HASH_REGEXP.test(aPart);
  })) {
    return { "address": aAddress, "hashes": [] };
  }
  return { "address": aAddress.slice(0, at), "hashes": hashes };
}

/**
 * Fills a Permissions row with one line per dependency.  A pinned hash
 * would crowd the line, so it stays hidden behind a small "SHA" link after
 * the address, which shows it (and hides it again) on the line below.
 *
 * @param {string} aId - The row's <vbox>.
 * @param {Array<?{name: (string|undefined), address: string}>} aEntries
 *   One per dependency; null entries are skipped.
 */
function fillDependencyRows(aId, aEntries) {
  let box = document.getElementById(aId);
  if (!box) {
    return undefined;
  }
  while (box.firstChild) {
    box.removeChild(box.firstChild);
  }
  let entries = aEntries.filter(function (aEntry) {
    return !!aEntry;
  });
  if (!entries.length) {
    // An empty value shows "—" (scriptPrefs.css).
    box.appendChild(permsValue(""));
    return undefined;
  }
  entries.forEach(function (aEntry) {
    let split = splitPinnedHashes(aEntry.address);
    let line = document.createElement("hbox");
    line.setAttribute("align", "start");
    let value = permsValue((aEntry.name && split.address)
        ? aEntry.name + "  →  " + split.address
        : (aEntry.name || split.address));
    value.setAttribute("flex", "1");
    line.appendChild(value);
    box.appendChild(line);
    if (!split.hashes.length) {
      return undefined;
    }
    let hash = permsValue(split.hashes.join("\n"));
    hash.classList.add("prefs-sha-value");
    hash.hidden = true;
    let toggle = document.createElement("label");
    toggle.className = "text-link prefs-sha-toggle";
    toggle.setAttribute("value",
        localizedString("scriptPrefs.sha.label", "SHA"));
    toggle.setAttribute("tooltiptext", localizedString(
        "scriptPrefs.sha.tooltip",
        "The hash this file is pinned to.  Click to show or hide it."));
    toggle.addEventListener("click", function () {
      hash.hidden = !hash.hidden;
    }, false);
    line.appendChild(toggle);
    box.appendChild(hash);
    return undefined;
  });
  return undefined;
}

/**
 * @param {string} aText
 * @returns {Element} A selectable Permissions value with the Copy menu.
 */
function permsValue(aText) {
  let el = document.createElement("description");
  el.className = "prefs-meta-value";
  el.setAttribute("context", "meta-context-menu");
  if (aText) {
    el.appendChild(document.createTextNode(aText));
  }
  return el;
}

function setMultilineDesc(aId, aText) {
  let el = document.getElementById(aId);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (aText) el.appendChild(document.createTextNode(aText));
}

/** Dedupes an array preserving the original order of first appearance. */
function uniq(aArr) {
  let seen = Object.create(null);
  let out = [];
  for (let i = 0; i < aArr.length; i++) {
    let v = aArr[i];
    if (!(v in seen)) { seen[v] = 1; out.push(v); }
  }
  return out;
}

////////////////////////// Metadata context-menu actions //////////////////////
//
// Earlier feedback (3.7.0 #4 first round) noted that drag-select worked on
// metadata fields but right-click → Copy did nothing.  In a XUL <window>
// rooted dialog, the platform's `cmd_copy` controller does not pick up
// selections that are entirely inside a <description> element — the
// command dispatcher walks up looking for a focused editable widget,
// finds nothing, and bails out without copying.  Doing the clipboard
// write ourselves via nsIClipboardHelper sidesteps that completely.

/** Element under the cursor when the context menu was triggered. */
var gMetaContextTarget = null;

function onMetaContextShowing(aEvent) {
  // The popup is anchored to the <description> the user right-clicked;
  // remember it so onMetaSelectAll can highlight just that field.
  let trig = aEvent.target.triggerNode;
  // Walk up to the nearest .prefs-meta-value if the trigger was a
  // child text node of a multiline description.
  while (trig && (!trig.classList
      || !trig.classList.contains("prefs-meta-value"))) {
    trig = trig.parentNode;
  }
  gMetaContextTarget = trig || null;
}

function onMetaCopy() {
  let selection = window.getSelection();
  let text = selection ? selection.toString() : "";
  if (!text && gMetaContextTarget) {
    // No selection: fall back to copying the whole field's text.  This
    // matches the platform behaviour of "Copy" in browser context menus
    // when there's nothing highlighted but a single field was clicked.
    text = gMetaContextTarget.textContent || "";
  }
  copyToClipboard(text);
}

/** @param {string} aText - Copied when not empty. */
function copyToClipboard(aText) {
  if (!aText) return;
  try {
    let helper = Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper);
    helper.copyString(aText);
  } catch (e) {
    Services.console.logStringMessage(
        "Greasemonkey scriptPrefs: clipboard copy failed: " + e);
  }
}

function onMetaSelectAll(aEvent) {
  let target = gMetaContextTarget;
  if (!target) return;
  // Build a Range covering the whole element's contents and replace
  // the current selection with it.  Works for both single-text-node
  // <description value=""> rows and multi-line <description>s.
  try {
    let range = document.createRange();
    range.selectNodeContents(target);
    let sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) {}
}

////////////////////////////// O4: list tooltips //////////////////////////////
//
// Read-only "Script-declared" lists (script-includes, script-matches,
// script-excludes) often hold long URL patterns that don't fit in the
// listbox row width.  Hover a row and we drop the cropped text into the
// row's `tooltiptext` so the platform tooltip layer surfaces the full
// value.  We only do this on the readonly lists because the editable
// user-side cludes already let the user edit a row to see its full text.

function installReadonlyListTooltips() {
  let ids = ["script-includes", "script-matches", "script-excludes"];
  for (let i = 0; i < ids.length; i++) {
    let cludes = document.getElementById(ids[i]);
    if (!cludes) continue;
    let listbox = document.getAnonymousElementByAttribute(
        cludes, "id", "listbox");
    if (!listbox) continue;
    listbox.addEventListener("mouseover", onListRowHover, false);
  }
}

function onListRowHover(aEvent) {
  let item = aEvent.target;
  // Walk up until we hit a listitem (the event might fire on a child
  // <description>/<image> inside the listitem's anonymous content).
  while (item && item.localName != "listitem") {
    item = item.parentNode;
  }
  if (!item) return;
  let label = item.getAttribute("label") || item.value || "";
  if (!label) return;
  // Always re-set; cheap, and avoids stale tooltips after pages are
  // reordered or replaced via the binding's `pages` setter.
  item.setAttribute("tooltiptext", label);
}

////////////////////////////// O5: scroll bubbling ////////////////////////////
//
// When the cludes listbox is at its top and the user scroll-wheels up,
// the platform XUL listbox swallows the event without bubbling — so the
// surrounding scroll container doesn't move.  Same problem at the bottom
// in reverse.  We re-dispatch any wheel event the listbox would have
// absorbed at its scroll boundary so the outer container picks it up and
// the dialog feels like a normal scrollable page.

function installScrollBubbling() {
  let ids = [
    "script-includes", "script-matches", "script-excludes",
    "user-includes",   "user-matches",   "user-excludes",
  ];
  for (let i = 0; i < ids.length; i++) {
    let cludes = document.getElementById(ids[i]);
    if (!cludes) continue;
    // Each list bubbles to its own tab's scroll container: the
    // script-declared lists live in the Settings tab, the user lists in
    // the User Preferences tab.  Both containers carry the
    // "settings-scroll" class, so walk up to the nearest one.
    let scroll = cludes.parentNode;
    while (scroll && !(scroll.classList
        && scroll.classList.contains("settings-scroll"))) {
      scroll = scroll.parentNode;
    }
    if (!scroll) continue;
    let listbox = document.getAnonymousElementByAttribute(
        cludes, "id", "listbox");
    if (!listbox) continue;
    listbox.addEventListener("DOMMouseScroll",
        function (aEvent) { bubbleWheelAtBoundary(aEvent, listbox, scroll); },
        false);
    listbox.addEventListener("wheel",
        function (aEvent) { bubbleWheelAtBoundary(aEvent, listbox, scroll); },
        false);
  }
}

function bubbleWheelAtBoundary(aEvent, aListbox, aScroll) {
  // Determine direction: positive = down, negative = up.  DOMMouseScroll
  // uses `detail`; wheel uses `deltaY`.
  let delta = (typeof aEvent.deltaY == "number" && aEvent.deltaY)
      ? aEvent.deltaY
      : (aEvent.detail || 0);
  if (!delta) return;

  // Visible rows vs total rows — if the listbox isn't scrollable at
  // all, every wheel tick should bubble.
  let firstIdx = 0;
  let lastIdx  = 0;
  try {
    firstIdx = aListbox.getIndexOfFirstVisibleRow();
    lastIdx  = firstIdx + aListbox.getNumberOfVisibleRows() - 1;
  } catch (e) { /* old XUL listbox — best-effort */ }
  let total = aListbox.getRowCount();

  let atTop    = firstIdx <= 0;
  let atBottom = lastIdx >= (total - 1);
  let scrollable = total > aListbox.getNumberOfVisibleRows();

  let pastBoundary =
      (!scrollable)
      || (delta < 0 && atTop)
      || (delta > 0 && atBottom);
  if (!pastBoundary) return;

  // Forward to the outer scroll container.  scrollByLines on a vbox
  // isn't supported, so just adjust scrollTop directly.
  aEvent.preventDefault();
  aEvent.stopPropagation();
  let pixels = (delta > 0 ? 1 : -1) * 40;
  if (typeof aScroll.scrollTop == "number") {
    aScroll.scrollTop += pixels;
  }
}

////////////////////////////// R4: window size persistence ///////////////////
//
// XUL `persist="width height"` would key per-document-URI, and every
// script's prefs URL has a unique `#<scriptId>` fragment, so each script
// would remember a separate size.  GM_prefRoot is keyed globally for
// the extension, so a single shared dimension lives across all scripts.

const PREF_WIN_W = "scriptPrefs.windowWidth";
const PREF_WIN_H = "scriptPrefs.windowHeight";
// Bumped from 720→840 in 3.7.0 patch.  720 left no room for the
// script-declared section's three side-by-side cludes (Included /
// Matched / Excluded), each of which has a wide "Add as user
// exclude/include/match" button (~150px natural width) that won't
// shrink below its label width — making the cludes column ~250px
// minimum, ×3 = ~750px just for the row, before groupbox margins.
// 840 gives the row + groupbox padding enough room to fit cleanly
// regardless of the script's @match / @exclude pattern lengths.
// Height stays at 720 — vertical content fits fine.
const DEFAULT_WIN_W = 840;
const DEFAULT_WIN_H = 720;
// Pre-3.7.0-patch default; used for the one-shot migration that
// upgrades any persisted-720 value to the new 840 baseline.  Anything
// other than 720 is assumed to be a deliberate user resize and left
// alone.
const LEGACY_DEFAULT_WIN_W = 720;

/**
 * Reads the persisted target window size, clamps to sane bounds, and
 * returns {w, h}.  Centralised so the load handler's initial resize
 * and the deferred snap-back both agree on what "the right size" is.
 *
 * Cap at DEFAULT_WIN_* upper bound: prior builds let savePersistedSize
 * write the auto-grown outerWidth back to the pref on close, which
 * "poisoned" the value (next open used the wider auto-grown size as
 * the new baseline, indefinitely).  Capping on read auto-recovers
 * those poisoned prefs without needing a one-time migration pref.
 * Users who deliberately resize to a width > 720 will see that on the
 * same session; the cap only fires once on the next open if they had
 * shrunk back below 720 before close.  Net effect: the dialog always
 * opens at ≤ 720×720, matching the user's expectation that "every
 * script opens at the same size" really means "the declared size".
 */
function readPersistedSize() {
  let w = DEFAULT_WIN_W;
  let h = DEFAULT_WIN_H;
  try { w = parseInt(GM_prefRoot.getValue(PREF_WIN_W, DEFAULT_WIN_W), 10); }
  catch (e) {}
  try { h = parseInt(GM_prefRoot.getValue(PREF_WIN_H, DEFAULT_WIN_H), 10); }
  catch (e) {}
  if (!w || isNaN(w) || w < 400) w = DEFAULT_WIN_W;
  if (!h || isNaN(h) || h < 400) h = DEFAULT_WIN_H;
  // One-shot migration: pre-patch default was 720.  Treat a still-
  // persisted 720 as "never deliberately resized" and upgrade to the
  // new 840 baseline.  Any other value is honoured as a user choice.
  if (w === LEGACY_DEFAULT_WIN_W) w = DEFAULT_WIN_W;
  if (w > DEFAULT_WIN_W) w = DEFAULT_WIN_W;
  if (h > DEFAULT_WIN_H) h = DEFAULT_WIN_H;
  return {"w": w, "h": h};
}

function applyPersistedSize() {
  let s = readPersistedSize();
  try { window.resizeTo(s.w, s.h); } catch (e) {}
}

/**
 * Resize the window back to the persisted target if XUL's layout pass
 * auto-grew it past that target during initial paint.  See the
 * setTimeout block in the load handler for the full rationale.
 * 4-pixel tolerance absorbs OS chrome adjustments that aren't really
 * "auto-grow".
 */
function snapBackToPersistedSize() {
  let s = readPersistedSize();
  try {
    if (window.outerWidth > s.w + 4 || window.outerHeight > s.h + 4) {
      window.resizeTo(s.w, s.h);
    }
  } catch (e) {}
}

/**
 * Writes the current outerWidth/outerHeight to the global GM_prefRoot
 * keys.  Used by both the debounced resize handler and the unload
 * handler.  Only in the normal window state: maximized or full screen is
 * the screen's size, not a preferred one, and minimized has none.
 */
function savePersistedSize() {
  try {
    // nsIDOMChromeWindow: STATE_MAXIMIZED 1, STATE_MINIMIZED 2,
    // STATE_NORMAL 3, STATE_FULLSCREEN 4.  The old check had 1-3 mixed
    // up, so it saved only when maximized.
    if (window.windowState != (window.STATE_NORMAL || 3)) {
      return;
    }
  } catch (e) {}
  let w = Math.floor(window.outerWidth  || DEFAULT_WIN_W);
  let h = Math.floor(window.outerHeight || DEFAULT_WIN_H);
  if (w < 400) w = DEFAULT_WIN_W;
  if (h < 400) h = DEFAULT_WIN_H;
  try { GM_prefRoot.setValue(PREF_WIN_W, w); } catch (e) {}
  try { GM_prefRoot.setValue(PREF_WIN_H, h); } catch (e) {}
}

/** Debounced save so we don't write the pref on every pixel of a drag. */
var gResizeSaveTimer = 0;
function onWindowResize() {
  if (gResizeSaveTimer) {
    window.clearTimeout(gResizeSaveTimer);
  }
  gResizeSaveTimer = window.setTimeout(function () {
    gResizeSaveTimer = 0;
    savePersistedSize();
  }, 150);
}

/////////////////////////// Enable / Disable toggle ///////////////////////////

/**
 * Flips gScript.enabled.  Does NOT close the dialog — toggling enabled
 * state is a small adjustment and the user is likely still configuring
 * other things.  Re-syncs the toggle button's label and tooltip after
 * the state change so the next click reads correctly.
 */
function onToggleEnabled() {
  gScript.enabled = !gScript.enabled;
  GM_util.getService().config._changed(gScript, "enabled");
  syncToggleEnabledButton();
}

/**
 * Reflects the current gScript.enabled state in the toggle button's
 * label.  Called once on dialog load and after every toggle click.
 */
function syncToggleEnabledButton() {
  let btn = document.getElementById("toggle-enabled");
  if (!btn) return;
  let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGreasemonkeyProperties);
  let key = gScript.enabled
      ? "scriptPrefs.toggle.disable"
      : "scriptPrefs.toggle.enable";
  try {
    btn.setAttribute("label", bundle.GetStringFromName(key));
  } catch (e) {
    // Locale missing the new key — leave the existing label as fallback.
  }
}

////////////////////////////// onDialogAccept /////////////////////////////////

/**
 * OK-button handler for the redesigned <window>-rooted dialog
 * (3.7.0 — was previously hooked by <dialog ondialogaccept="…"/>).
 * Commits and closes; Cancel uses window.close() directly so changes
 * are abandoned.
 */
function onDialogAcceptAndClose() {
  try {
    onDialogAccept();
  } finally {
    window.close();
  }
}

/**
 * Persists every editable field back to the Script object and notifies
 * the config service.  Returns true so the dialog actually closes.
 */
function onDialogAccept() {
  // ─── Pages section (existing behaviour) ──────────────────────────────
  gScript.userIncludes  = gElm.userIncludes.pages;
  gScript.userMatches   = gElm.userMatches.pages;
  gScript.userExcludes  = gElm.userExcludes.pages;
  gScript.userOverride  = !!gElm.userOverride.checked;
  GM_util.getService().config._changed(gScript, "cludes");

  // ─── Behaviour section ───────────────────────────────────────────────

  // Run-at
  let runAtMenu = document.getElementById("behave-runat");
  if (runAtMenu && runAtMenu.selectedItem) {
    let v = runAtMenu.selectedItem.getAttribute("value");
    if (v && v !== gScript.runAt) {
      gScript.runAt = v;
    }
  }

  // No-frames
  let nfBox = document.getElementById("behave-noframes");
  if (nfBox) {
    let want = !!nfBox.checked;
    if (want !== !!gScript.noframes) {
      gScript.noframes = want;
    }
  }

  // Inject-into
  let injectMenu = document.getElementById("behave-injectinto");
  if (injectMenu && injectMenu.selectedItem) {
    let v = injectMenu.selectedItem.getAttribute("value");
    if (v && v !== gScript.injectInto) {
      gScript.injectInto = v;
    }
  }

  // GM_cookie's HTTP-only cookies
  let httpOnlyBox = document.getElementById("behave-httponly");
  if (httpOnlyBox && (!!httpOnlyBox.checked !== !!gScript.httpOnlyCookies)) {
    gScript.httpOnlyCookies = httpOnlyBox.checked;
  }

  // Automatic Updates: only a value the user picked here is written (see
  // gShownAutoUpdate), through the add-on, which asks first when it would
  // switch updates back on over local edits (unless the user already
  // agreed to this value) and updates an open Add-ons Manager.
  let autoRadio = document.getElementById("behave-autoupdate");
  if (autoRadio && autoRadio.value) {
    let next = autoUpdateFromRadio(autoRadio.value);
    if ((next !== gShownAutoUpdate) && (next !== gScript.checkRemoteUpdates)) {
      ScriptAddonFactoryByScript(gScript).setAutoUpdate(
          next, next === gConfirmedAutoUpdate);
    }
  }

  // Position: counted among the listed scripts as they are now (another
  // may have moved or been removed meanwhile).  The script takes the place
  // of the one there, so a removed script still waiting for its Undo, not
  // counted, can't shift it.
  let posMenu = document.getElementById("behave-position");
  if (posMenu && posMenu.selectedItem) {
    let target = parseInt(posMenu.selectedItem.getAttribute("value"), 10);
    let config = GM_util.getService().config;
    let scripts = positionedScripts();
    let current = scripts.indexOf(gScript);
    let there = isNaN(target)
        ? null : scripts[Math.min(target, scripts.length - 1)];
    if (there && (target !== gInitialPosition) && (current > -1)
        && (there !== gScript)) {
      try {
        config.move(gScript, there);
      } catch (e) {
        // Don't block the dialog close on an internal config error;
        // the rest of the user's edits are still applied.
        Services.console.logStringMessage(
            "Greasemonkey scriptPrefs: position move failed: " + e);
      }
    }
  }

  // Saves config.xml and tells the content processes about the new
  // settings (run at, frames, cludes).
  GM_util.getService().config._changed(gScript, "modified", null);

  return true;
}

////////////////////////////// Values tab /////////////////////////////////////
//
// The Values tab shows every GM_setValue key for this script with type +
// value columns and Add / Edit / Delete buttons.  Backed by the script's
// shared storage (valuesStorage()).  Add / Edit (or a double-click) open
// the value editor, valueEditor.xul; Delete is a single confirm.  Every
// change goes through the Back's setValue / deleteValue, so running
// pages see it and the script's val-set / val-del observers fire.

function populateValuesTab() {
  loadValuesFromStorage();
  rebuildValuesTree();
  // Add is enabled whenever the values could be read; Edit / Delete only
  // when a row is selected.
  document.getElementById("values-add").disabled = !gValuesReadable;
  if (gValuesReadable) {
    document.getElementById("values-tree")
        .addEventListener("dblclick", onValueDblClick, false);
  }
  onValueSelect();
}

/**
 * Refreshes gValuesData from the storage backend.  Called on initial
 * load and after every Add / Edit / Delete so the tree always reflects
 * what's actually persisted.
 */
function loadValuesFromStorage() {
  gValuesData = [];
  let storage = valuesStorage();
  let names;
  try {
    // No file yet: nothing stored.  Don't let the listing create one.
    names = storage.dbFile.exists() ? (storage.listValues() || []) : [];
    gValuesReadable = true;
  } catch (e) {
    // A corrupt file: the rest of the dialog still works; the Values
    // tab just shows empty.
    gValuesReadable = false;
    Services.console.logStringMessage(
        "Greasemonkey scriptPrefs: reading the values failed: " + e);
    return;
  }
  names.sort();
  for (let i = 0; i < names.length; i++) {
    let raw = null;
    try { raw = storage.getValue(names[i]); } catch (e) { raw = null; }
    let parsed = null;
    let typeName = "null";
    try {
      parsed = JSON.parse(raw);
      typeName = jsTypeName(parsed);
    } catch (e) {
      // Stored value isn't valid JSON — surface as a string with an
      // "(invalid)" type so the user can still edit / delete it.
      parsed = "" + raw;
      typeName = "invalid";
    }
    gValuesData.push({
      "name":  names[i],
      "raw":   raw,
      "value": parsed,
      "type":  typeName,
    });
  }
}

/** Returns "string" / "number" / "boolean" / "object" / "null" / "array". */
function jsTypeName(aValue) {
  if (aValue === null) return "null";
  if (Array.isArray(aValue)) return "array";
  return typeof aValue;
}

/**
 * Wires gValuesData to the <tree> via a custom nsITreeView.  Recreated
 * after every mutation so the row count stays consistent with the data.
 */
function rebuildValuesTree() {
  let tree = document.getElementById("values-tree");
  let empty = document.getElementById("values-empty");
  if (!tree) return;

  if (gValuesData.length === 0) {
    tree.view = makeListTreeView(0, null);
    if (empty) empty.hidden = false;
  } else {
    tree.view = makeValuesTreeView(gValuesData);
    if (empty) empty.hidden = true;
  }

  // Update the toolbar count label.
  let countLabel = document.getElementById("values-count");
  if (countLabel) {
    countLabel.value = countString("scriptPrefs.values.countFormat",
        "%1 entry;%1 entries", gValuesData.length);
  }
}

/**
 * A plain list for a <tree> (nsITreeView): aRowCount rows, no nesting.
 * Empty, nothing can be selected.
 *
 * @param {number}   aRowCount
 * @param {Function} aCellText - (row, column id) -> the cell's text.
 * @returns {object}
 */
function makeListTreeView(aRowCount, aCellText) {
  return {
    "rowCount":         aRowCount,
    "getCellText":      function (aRow, aCol) {
      return (aRow < aRowCount) ? aCellText(aRow, aCol.id) : "";
    },
    "isContainer":      function () { return false; },
    "isContainerOpen":  function () { return false; },
    "isContainerEmpty": function () { return true; },
    "isSeparator":      function () { return false; },
    "isSorted":         function () { return false; },
    "getLevel":         function () { return 0; },
    "getImageSrc":      function () { return null; },
    "getRowProperties":  function () {},
    "getCellProperties": function () {},
    "getColumnProperties": function () {},
    "setTree":           function () {},
    "isEditable":        function () { return false; },
    "isSelectable":      function () { return aRowCount > 0; },
    "cycleHeader":       function () {},
    "cycleCell":         function () {},
    "selectionChanged":  function () {},
    "performAction":     function () {},
    "performActionOnRow":  function () {},
    "performActionOnCell": function () {},
  };
}

/**
 * @param {object[]} aData - gValuesData.
 * @returns {object} The Values tab's tree view.
 */
function makeValuesTreeView(aData) {
  return makeListTreeView(aData.length, function (aRow, aColumn) {
    let row = aData[aRow];
    switch (aColumn) {
      case "values-col-key":   return row.name;
      case "values-col-type":  return row.type;
      case "values-col-value":
        // Render the value column inline; truncate large objects so
        // the tree doesn't choke on a 1 MB JSON blob.
        let display;
        if ((row.type === "string") || (row.type === "object")
            || (row.type === "array")) {
          display = JSON.stringify(row.value);
        } else {
          display = "" + row.value;
        }
        if (display.length > 200) display = display.substring(0, 200) + "…";
        return display;
      default: return "";
    }
  });
}

/**
 * Toggles the Edit/Delete buttons based on whether a row is selected.
 * Called by the <tree>'s onselect attribute and after each mutation so
 * the toolbar stays in a coherent state.
 */
function onValueSelect() {
  let tree = document.getElementById("values-tree");
  let editBtn = document.getElementById("values-edit");
  let delBtn  = document.getElementById("values-delete");
  let hasSelection = tree && tree.currentIndex >= 0
      && tree.currentIndex < gValuesData.length;
  if (editBtn) editBtn.disabled = !hasSelection || !gValuesReadable;
  if (delBtn)  delBtn.disabled  = !hasSelection || !gValuesReadable;
}

function selectedValueRow() {
  let tree = document.getElementById("values-tree");
  if (!tree || tree.currentIndex < 0) return null;
  return gValuesData[tree.currentIndex] || null;
}

/////////////////////////////// Externals tab ////////////////////////////////

/** The Externals tab's rows (see externalRow). */
var gExternals = [];

/** Download Again is under way (its button is off meanwhile). */
var gExternalsDownloading = false;

/** How the Integrity column names a pinned hash's algorithm. */
const HASH_NAMES = {"sha256": "SHA-256", "sha384": "SHA-384", "sha512": "SHA-512"};

/**
 * Lists the script's @require and @resource files, as Violentmonkey's
 * Externals tab does: where each comes from, the size of its downloaded
 * copy, its state and, for one whose address pins a hash, whether the
 * copy matches it.  Built again when the script changes (its files
 * fetched after an import, or downloaded again from here).
 */
function populateExternalsTab() {
  let tree = document.getElementById("externals-tree");
  if (!tree) return;
  gExternals = (gScript.requires || []).map(function (aRequire) {
    return externalRow("@require", aRequire);
  }).concat((gScript.resources || []).map(function (aResource) {
    return externalRow("@resource " + aResource.name, aResource);
  }));
  tree.view = makeListTreeView(gExternals.length, function (aRow, aColumn) {
    let row = gExternals[aRow];
    switch (aColumn) {
      case "externals-col-type":    return row.type;
      case "externals-col-address": return row.address;
      case "externals-col-size":
        return (row.size === null) ? "" : formatSize(row.size);
      case "externals-col-state":   return row.state;
      case "externals-col-integrity": return row.integrity;
      default: return "";
    }
  });
  document.getElementById("externals-empty").hidden = !!gExternals.length;
  document.getElementById("externals-count").value = countString(
      "scriptPrefs.externals.countFormat", "%1 file;%1 files",
      gExternals.length);
  onExternalSelect();
}

/**
 * @param {string} aType - "@require", or "@resource" and its name.
 * @param {ScriptDependency} aDependency
 * @returns {{type: string, address: string, size: ?number, state: string,
 *     integrity: string, file: ?nsIFile, dependency: ScriptDependency}}
 *   file and size are null while there is no downloaded copy; integrity
 *   is empty without a pinned hash (or a copy to check).
 */
function externalRow(aType, aDependency) {
  let file = null;
  let size = null;
  try {
    let copy = aDependency.file;
    if (copy.exists()) {
      file = copy;
      size = copy.fileSize;
    }
  } catch (e) {
    // No file name yet: not downloaded.
  }
  let state;
  if (file) {
    state = localizedString("scriptPrefs.externals.downloaded", "Downloaded");
  } else if (gScript._dependenciesPending) {
    state = localizedString(
        "scriptPrefs.externals.waiting", "Waiting to download");
  } else {
    state = localizedString("scriptPrefs.externals.missing", "Missing");
  }
  let integrity = "";
  let pin = aDependency._integrity;
  if (pin && file) {
    let matches = false;
    try {
      matches = (GM_util.hashFile(file, pin.algo) === pin.hex);
    } catch (e) {
      // Unreadable: it doesn't match.
    }
    integrity = (matches
        ? localizedString("scriptPrefs.externals.hashMatches", "%1 matches")
        : localizedString(
            "scriptPrefs.externals.hashDiffers", "%1 doesn't match"))
        .replace("%1", HASH_NAMES[pin.algo] || pin.algo);
  }
  return {
    "address": splitPinnedHashes(aDependency.downloadURL).address,
    "dependency": aDependency,
    "file": file,
    "integrity": integrity,
    "size": size,
    "state": state,
    "type": aType,
  };
}

/** @returns {?object} The selected row of the Externals tab. */
function selectedExternal() {
  let tree = document.getElementById("externals-tree");
  if (!tree || (tree.currentIndex < 0)) return null;
  return gExternals[tree.currentIndex] || null;
}

/**
 * View is there for a row with a downloaded copy; Download Again when
 * the script has files, and none is being downloaded already.
 */
function onExternalSelect() {
  let row = selectedExternal();
  document.getElementById("externals-view").disabled = !(row && row.file);
  document.getElementById("externals-download").disabled =
      gExternalsDownloading || !gExternals.length;
}

/** @returns {boolean} Whether the right-click menu shows (on a row). */
function onExternalContextShowing() {
  let row = selectedExternal();
  if (!row) return false;
  document.getElementById("externals-context-view")
      .setAttribute("disabled", row.file ? "false" : "true");
  return true;
}

/**
 * Shows the selected file's downloaded copy in a browser tab: text in the
 * read-only source viewer, an image or other file as the browser shows it.
 */
function onExternalView() {
  let row = selectedExternal();
  if (!row || !row.file) return;
  let type = row.dependency.mimetype || "";
  let isText = (row.type == "@require") || !type
      || /^text\/|javascript|ecmascript|json|xml|css/i.test(type);
  openInBrowserTab(isText
      ? GM_util.sourceViewerUrl(row.file, row.dependency.downloadURL)
      : GM_util.getUriFromFile(row.file).spec);
}

function onExternalCopyAddress() {
  let row = selectedExternal();
  if (row) copyToClipboard(row.dependency.downloadURL);
}

/**
 * Downloads the script's files again (Script.downloadDependenciesAgain),
 * saying how it went beside the buttons; the list follows the script's
 * change.
 */
function onExternalsDownloadAgain() {
  if (gExternalsDownloading) return;
  gExternalsDownloading = true;
  setExternalsStatus(
      localizedString("scriptPrefs.externals.downloading", "Downloading…"));
  onExternalSelect();
  gScript.downloadDependenciesAgain(function (aSuccess, aMessage) {
    gExternalsDownloading = false;
    try {
      if (aSuccess) {
        setExternalsStatus(localizedString(
            "scriptPrefs.externals.downloadedAgain", "Downloaded again."));
      } else {
        setExternalsStatus(aMessage ? localizedString(
            "scriptPrefs.externals.downloadFailed", "Not downloaded: %1")
            .replace("%1", function () { return aMessage; }) : "");
      }
      populateExternalsTab();
    } catch (e) {
      // The window closed meanwhile.
    }
  });
}

/**
 * @param {string} aText - Shown on one line, in full in its tooltip
 *   (a download error runs over several).
 */
function setExternalsStatus(aText) {
  let status = document.getElementById("externals-status");
  status.value = aText.replace(/\s*\n\s*/g, " ");
  status.setAttribute("tooltiptext", aText);
}

////////////////////////////// Add / Edit / Delete /////////////////////////////

function onValueAdd() {
  if (!gValuesReadable) return;
  openValueEditor({
    "existingKeys": gValuesData.map(function (aRow) { return aRow.name; }),
  });
}

function onValueEdit() {
  let row = selectedValueRow();
  if (!row || !gValuesReadable) return;
  openValueEditor({"key": row.name, "raw": row.raw, "type": row.type});
}

/** Double-clicking a row edits it, like the Edit button. */
function onValueDblClick(aEvent) {
  let tree = document.getElementById("values-tree");
  if ((aEvent.button == 0)
      && (tree.treeBoxObject.getRowAt(aEvent.clientX, aEvent.clientY) >= 0)) {
    onValueEdit();
  }
}

/**
 * Opens the value editor (valueEditor.xul) on aArgs, described in
 * valueEditor.js (no key: add one), then stores what it saved and selects
 * that row.  The editor hands back strings only: an object made in its
 * window would be dead once the window closed.
 */
function openValueEditor(aArgs) {
  window.openDialog("chrome://greasemonkey/content/valueEditor.xul", "",
      "chrome,titlebar,dialog=no,modal,resizable,centerscreen", aArgs);
  if (typeof aArgs.resultKey != "string") return;

  try {
    valuesStorage().setValue(aArgs.resultKey, JSON.parse(aArgs.resultJson));
  } catch (e) {
    let bundle = bundleForValuesDialogs();
    Services.prompt.alert(window, (typeof aArgs.key == "string")
        ? bundleStr(bundle, "scriptPrefs.values.editTitle", "Edit value")
        : bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
        "" + e);
    return;
  }

  loadValuesFromStorage();
  rebuildValuesTree();
  selectValueRow(aArgs.resultKey);
}

/** Selects the row for aKey (after a rebuild, which drops the selection)
 *  and scrolls to it. */
function selectValueRow(aKey) {
  let tree = document.getElementById("values-tree");
  let index = gValuesData.findIndex(function (aRow) {
    return aRow.name === aKey;
  });
  try {
    if (index >= 0) {
      tree.view.selection.select(index);
      tree.treeBoxObject.ensureRowIsVisible(index);
    }
  } catch (e) {
    // Only a convenience: the value is stored either way.
  }
  onValueSelect();
}

function onValueDelete() {
  let row = selectedValueRow();
  if (!row || !gValuesReadable) return;
  let prompts = Services.prompt;
  let bundle = bundleForValuesDialogs();

  let title = bundleStr(bundle, "scriptPrefs.values.deleteTitle",
      "Delete value");
  let body = bundleStr(bundle, "scriptPrefs.values.deleteConfirm",
      "Delete the value for key '%1'?").replace("%1", row.name);
  if (!prompts.confirm(window, title, body)) return;

  try {
    valuesStorage().deleteValue(row.name);
  } catch (e) {
    prompts.alert(window, title, "" + e);
    return;
  }

  loadValuesFromStorage();
  rebuildValuesTree();
}

/** Cached bundle reference for the Values dialogs. */
function bundleForValuesDialogs() {
  try {
    return Services.strings.createBundle(
        "chrome://greasemonkey/locale/greasemonkey.properties");
  } catch (e) {
    return null;
  }
}

/**
 * Reads a localised string with a hard-coded English fallback so that a
 * locale missing the new key still shows usable (if untranslated) text
 * rather than an empty / undefined dialog body.
 */
function bundleStr(aBundle, aKey, aFallback) {
  if (!aBundle) return aFallback;
  try { return aBundle.GetStringFromName(aKey); }
  catch (e) { return aFallback; }
}
