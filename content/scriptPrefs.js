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
Cu.import("resource://gre/modules/Services.jsm");

// GM_CONSTANTS — for the localized auto-update confirmation bundle.
Cu.import("chrome://greasemonkey-modules/content/constants.js");

// AddonManager constants for the Auto-update radio mapping.
Cu.import("resource://gre/modules/AddonManager.jsm");

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

/** Initial position (0-based) at dialog open; used to compute the
 *  reorder delta on OK without doing redundant work when unchanged. */
var gInitialPosition = -1;

/** Lazy-instantiated GM_ScriptStorageBack for the Values tab.  Closed
 *  on window unload.  Each call to getValues / setValues / deleteValue
 *  reuses this single connection. */
var gValuesStorage = null;

/** In-memory snapshot of the script's stored key/value pairs.  Keys come
 *  from listValues(); values are the *parsed* result of JSON.parse on
 *  the raw DB column, so the tree view can render the type label
 *  ("string", "number", "boolean", "object", "null") without re-parsing
 *  on every redraw.  Re-built whenever a value is added / edited / deleted. */
var gValuesData = [];

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
  syncToggleEnabledButton();
  installReadonlyListTooltips();
  installScrollBubbling();

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
  // Close the SQLite connection cleanly when the dialog is dismissed.
  if (gValuesStorage) {
    try { gValuesStorage.close(); } catch (e) {}
    gValuesStorage = null;
  }
}, false);

////////////////////////////// Pages section //////////////////////////////////

function populatePagesSection() {
  // User-side cludes wire up exactly as in the previous design.
  gElm.userIncludes.pages = gScript.userIncludes;

  // The "moved to user-side via context-menu" callbacks no longer need a
  // tab switch (single-form layout), so the helpers just delegate.
  gElm.scriptIncludes.pages = gScript.includes;
  gElm.scriptIncludes.onAddUserExclude = function (aPage) {
    gElm.userExcludes.addPage(aPage);
  };

  let matchesPattern = [];
  for (let i = 0, iLen = gScript.matches.length; i < iLen; i++) {
    matchesPattern.push(gScript.matches[i].pattern);
  }
  gElm.scriptMatches.pages = matchesPattern;

  let userMatchesPattern = [];
  for (let i = 0, iLen = gScript.userMatches.length; i < iLen; i++) {
    userMatchesPattern.push(gScript.userMatches[i].pattern);
  }
  gElm.userMatches.pages = userMatchesPattern;

  gElm.scriptExcludes.pages = gScript.excludes;
  gElm.scriptExcludes.onAddUserInclude = function (aPage) {
    gElm.userIncludes.addPage(aPage);
  };
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
  setLabel("meta-updateurl",   gScript.updateURL      || "");
  setLabel("meta-downloadurl", gScript.downloadURL    || "");

  // Description can be multi-line; use a <description> instead of a
  // <label> in the XUL and write through textContent.
  let desc = document.getElementById("meta-description");
  if (desc) {
    while (desc.firstChild) desc.removeChild(desc.firstChild);
    let descText = gScript.localized.description || gScript.description || "";
    desc.appendChild(document.createTextNode(descText));
  }

  // Homepage / Support URL — clickable links.
  setLink("meta-homepage", gScript.homepageURL || "");
  setLink("meta-support",  gScript.supportURL  || "");

  // Timestamps come back as ms-since-epoch numbers (or null for very
  // old configs).  Format with the user's locale conventions.
  let installDate = gScript.installTime
      ? new Date(gScript.installTime).toLocaleString()
      : "—";
  let lastUpdate = gScript.modifiedDate
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
 *
 * Auto-scales the unit:
 *   < 1 KB  → "%1 bytes"
 *   < 1 MB  → "%1 KB" with one decimal place when not a round number
 *   ≥ 1 MB  → "%1 MB" with two decimal places
 */
function computeScriptSizeLabel() {
  let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGreasemonkeyProperties);
  let unknown;
  try { unknown = bundle.GetStringFromName("scriptPrefs.size.unknown"); }
  catch (e) { unknown = "Unknown"; }

  let bytes;
  try {
    let f = gScript.file;
    if (!f || !f.exists()) return unknown;
    bytes = f.fileSize;
  } catch (e) {
    return unknown;
  }

  if (bytes < 1024) {
    try {
      return bundle.GetStringFromName("scriptPrefs.size.bytes")
          .replace("%1", bytes.toString());
    } catch (e) { return bytes + " bytes"; }
  }
  if (bytes < 1024 * 1024) {
    let kb = bytes / 1024;
    let s = (kb < 10) ? kb.toFixed(1) : Math.round(kb).toString();
    try {
      return bundle.GetStringFromName("scriptPrefs.size.kb")
          .replace("%1", s);
    } catch (e) { return s + " KB"; }
  }
  let mb = bytes / (1024 * 1024);
  let s = mb.toFixed(2);
  try {
    return bundle.GetStringFromName("scriptPrefs.size.mb")
        .replace("%1", s);
  } catch (e) { return s + " MB"; }
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
 * Same as setLabel but for the homepage / support URL link fields, which
 * also need their stored URL stashed somewhere onLinkClick can read it.
 * (Reading textContent at click time would lose the original URL if it
 * ever displays differently than its stored form, e.g. truncated by CSS
 * ellipsis.)
 */
function setLink(aId, aUrl) {
  let el = document.getElementById(aId);
  if (!el) return;
  while (el.firstChild) el.removeChild(el.firstChild);
  if (aUrl) {
    el.appendChild(document.createTextNode(aUrl));
    el.setAttribute("tooltiptext", aUrl);
    el._gmHref = aUrl;
  } else {
    el.removeAttribute("tooltiptext");
    el._gmHref = null;
  }
}

/**
 * Click handler for <description class="text-link"> homepage/support
 * fields.  Opens the stored URL in a new tab of the most recent
 * browser window.
 */
function onLinkClick(aEvent, aId) {
  let el = document.getElementById(aId);
  if (!el || !el._gmHref) return;
  let chromeWin = Services.wm.getMostRecentWindow("navigator:browser");
  if (!chromeWin) return;
  try {
    chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(el._gmHref);
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

  // Auto-update — Script.checkRemoteUpdates is one of
  // AddonManager.AUTOUPDATE_DEFAULT | _ENABLE | _DISABLE.
  let autoRadio = document.getElementById("behave-autoupdate");
  let autoVal;
  switch (gScript.checkRemoteUpdates) {
    case AddonManager.AUTOUPDATE_ENABLE:  autoVal = "enable";  break;
    case AddonManager.AUTOUPDATE_DISABLE: autoVal = "disable"; break;
    default:                              autoVal = "default"; break;
  }
  autoRadio.value = autoVal;

  // Position dropdown — populate "1 of N" through "N of N", select the
  // current index.  This is the TM-style "Execution position" control.
  populatePositionDropdown();
}

/**
 * Fires the moment the Automatic-updates radio changes.  If the user
 * flips it from Off to On / Default while the script still has local
 * edits, warn that the next update will overwrite those edits, and snap
 * the radio back to Off if they decline.  Mirrors the Add-ons Manager
 * radio (ScriptAddon.applyBackgroundUpdates in modules/addons.js); the OK
 * commit then just persists whatever the radio settled on.
 */
function onAutoUpdateChange() {
  let autoRadio = document.getElementById("behave-autoupdate");
  if (!autoRadio || !autoRadio.value) {
    return;
  }
  let next;
  switch (autoRadio.value) {
    case "enable":  next = AddonManager.AUTOUPDATE_ENABLE;  break;
    case "disable": next = AddonManager.AUTOUPDATE_DISABLE; break;
    default:        next = AddonManager.AUTOUPDATE_DEFAULT; break;
  }
  let reenablingWhileEdited =
      (gScript.checkRemoteUpdates == AddonManager.AUTOUPDATE_DISABLE)
      && (next != AddonManager.AUTOUPDATE_DISABLE)
      && (gScript._modifiedTime > gScript._installTime);
  if (!reenablingWhileEdited) {
    return;
  }
  let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGmAddonsProperties);
  let confirmed = Services.prompt.confirm(
      null,
      "Greasemonkey",
      bundle.GetStringFromName("confirmEnableAutoUpdate"));
  if (!confirmed) {
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
 * Builds the execution-position menulist with "1 of N", "2 of N", …
 * entries and selects the position matching the script's current index
 * in config.scripts.  Stores the initial position in gInitialPosition
 * so onDialogAccept can compute a delta and call config.move() the
 * minimum number of times.
 */
function populatePositionDropdown() {
  let scripts = GM_util.getService().config.scripts || [];
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

  // @require list: each entry is a ScriptRequire with downloadURL.
  let reqUrls = (gScript.requires || []).map(function (r) {
    return r && r.downloadURL ? r.downloadURL : "";
  }).filter(function (s) { return !!s; });
  setMultilineDesc("perms-requires", reqUrls.join("\n"));

  // @resource list: each entry is a ScriptResource with name + downloadURL.
  let resLines = (gScript.resources || []).map(function (r) {
    if (!r) return "";
    if (r.name && r.downloadURL) return r.name + "  →  " + r.downloadURL;
    return r.name || r.downloadURL || "";
  }).filter(function (s) { return !!s; });
  setMultilineDesc("perms-resources", resLines.join("\n"));
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
  if (!text) return;
  try {
    let helper = Cc["@mozilla.org/widget/clipboardhelper;1"]
        .getService(Ci.nsIClipboardHelper);
    helper.copyString(text);
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
 * handler.  Skips while the window is maximised (windowState == 2)
 * so we don't persist screen-size as the "preferred" size.
 */
function savePersistedSize() {
  try {
    // STATE_MAXIMIZED == 2, STATE_FULLSCREEN == 4, STATE_MINIMIZED == 3.
    // Only persist when in the normal (1) or unset (0) state.
    let s = window.windowState;
    if (s == 2 || s == 3 || s == 4) return;
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

  // Auto-update radio → checkRemoteUpdates int
  let autoRadio = document.getElementById("behave-autoupdate");
  if (autoRadio && autoRadio.value) {
    let next;
    switch (autoRadio.value) {
      case "enable":  next = AddonManager.AUTOUPDATE_ENABLE;  break;
      case "disable": next = AddonManager.AUTOUPDATE_DISABLE; break;
      default:        next = AddonManager.AUTOUPDATE_DEFAULT; break;
    }
    if (next !== gScript.checkRemoteUpdates) {
      // The re-enable-while-edited disclaimer fires immediately when the
      // radio is flipped (onAutoUpdateChange below), so by commit time the
      // radio already reflects a confirmed choice — just persist it.
      gScript.checkRemoteUpdates = next;
    }
  }

  // Position — apply delta-by-delta via config.move() so the existing
  // notification path runs.  No-op when unchanged.
  let posMenu = document.getElementById("behave-position");
  if (posMenu && posMenu.selectedItem) {
    let target = parseInt(posMenu.selectedItem.getAttribute("value"), 10);
    if (!isNaN(target) && target !== gInitialPosition) {
      let delta = target - gInitialPosition;
      let config = GM_util.getService().config;
      if (config && typeof config.move == "function") {
        try {
          config.move(gScript, delta);
        } catch (e) {
          // Don't block the dialog close on an internal config error;
          // the rest of the user's edits are still applied.
          Services.console.logStringMessage(
              "Greasemonkey scriptPrefs: position move failed: " + e);
        }
      }
    }
  }

  // Notify any open Add-ons Manager so the row reflects new run-at,
  // auto-update, and execution-position values without a restart.
  GM_util.getService().config._changed(gScript, "modified", null);

  return true;
}

////////////////////////////// Values tab /////////////////////////////////////
//
// The Values tab shows every GM_setValue key for this script with type +
// value columns and Add / Edit / Delete buttons.  Backed by
// modules/storageBack.js (one shared connection per dialog instance,
// closed on window.onunload).  Add / Edit prompt for the JSON-encoded
// value; Delete is a single confirm.  All mutations go through the
// existing setValue / deleteValue paths so the script's GM_setValue
// observers (val-set / val-del) fire correctly.

function populateValuesTab() {
  // Lazy-open the storage connection.
  if (!gValuesStorage) {
    try {
      gValuesStorage = new GM_ScriptStorageBack(gScript);
    } catch (e) {
      // If the script's storage DB is missing / corrupt, the rest of
      // the dialog still works; the Values tab just shows empty.
      gValuesStorage = null;
      Services.console.logStringMessage(
          "Greasemonkey scriptPrefs: storage open failed: " + e);
    }
  }
  loadValuesFromStorage();
  rebuildValuesTree();
  // Add button is enabled whenever the storage connection is alive;
  // Edit / Delete only when a row is selected.
  document.getElementById("values-add").disabled = !gValuesStorage;
  onValueSelect();
}

/**
 * Refreshes gValuesData from the storage backend.  Called on initial
 * load and after every Add / Edit / Delete so the tree always reflects
 * what's actually persisted.
 */
function loadValuesFromStorage() {
  gValuesData = [];
  if (!gValuesStorage) return;
  let names;
  try {
    names = gValuesStorage.listValues() || [];
  } catch (e) {
    return;
  }
  names.sort();
  for (let i = 0; i < names.length; i++) {
    let raw = null;
    try { raw = gValuesStorage.getValue(names[i]); } catch (e) { raw = null; }
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
    tree.view = makeEmptyTreeView();
    if (empty) empty.hidden = false;
  } else {
    tree.view = makeValuesTreeView(gValuesData);
    if (empty) empty.hidden = true;
  }

  // Update the toolbar count label.
  let countLabel = document.getElementById("values-count");
  if (countLabel) {
    let bundle = null;
    try {
      bundle = Services.strings.createBundle(
          "chrome://greasemonkey/locale/greasemonkey.properties");
    } catch (e) {}
    if (bundle) {
      try {
        countLabel.value = bundle
            .GetStringFromName("scriptPrefs.values.countFormat")
            .replace("%1", gValuesData.length);
      } catch (e) {
        countLabel.value = gValuesData.length + " entries";
      }
    } else {
      countLabel.value = gValuesData.length + " entries";
    }
  }
}

function makeEmptyTreeView() {
  return {
    "rowCount":         0,
    "getCellText":      function () { return ""; },
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
    "isSelectable":      function () { return false; },
    "cycleHeader":       function () {},
    "cycleCell":         function () {},
    "selectionChanged":  function () {},
    "performAction":     function () {},
    "performActionOnRow":  function () {},
    "performActionOnCell": function () {},
  };
}

function makeValuesTreeView(aData) {
  return {
    "rowCount": aData.length,
    "getCellText": function (aRow, aCol) {
      let row = aData[aRow];
      if (!row) return "";
      switch (aCol.id) {
        case "values-col-key":   return row.name;
        case "values-col-type":  return row.type;
        case "values-col-value":
          // Render the value column inline; truncate large objects so
          // the tree doesn't choke on a 1 MB JSON blob.
          let display;
          if (row.type === "string")  display = JSON.stringify(row.value);
          else if (row.type === "object" || row.type === "array")
                                      display = JSON.stringify(row.value);
          else                        display = "" + row.value;
          if (display.length > 200) display = display.substring(0, 200) + "…";
          return display;
        default: return "";
      }
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
    "isSelectable":      function () { return true; },
    "cycleHeader":       function () {},
    "cycleCell":         function () {},
    "selectionChanged":  function () {},
    "performAction":     function () {},
    "performActionOnRow":  function () {},
    "performActionOnCell": function () {},
  };
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
  if (editBtn) editBtn.disabled = !hasSelection || !gValuesStorage;
  if (delBtn)  delBtn.disabled  = !hasSelection || !gValuesStorage;
}

function selectedValueRow() {
  let tree = document.getElementById("values-tree");
  if (!tree || tree.currentIndex < 0) return null;
  return gValuesData[tree.currentIndex] || null;
}

////////////////////////////// Add / Edit / Delete /////////////////////////////

function onValueAdd() {
  if (!gValuesStorage) return;
  let prompts = Services.prompt;
  let bundle = bundleForValuesDialogs();

  // 1) Ask for the key.
  let keyHolder = { "value": "" };
  let confirmed = prompts.prompt(window,
      bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
      bundleStr(bundle, "scriptPrefs.values.addKey",   "Enter the key name:"),
      keyHolder, null, {});
  if (!confirmed || !keyHolder.value) return;
  let key = keyHolder.value;

  // Refuse to silently overwrite an existing key — guide the user to
  // Edit instead.
  for (let i = 0; i < gValuesData.length; i++) {
    if (gValuesData[i].name === key) {
      prompts.alert(window,
          bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
          bundleStr(bundle, "scriptPrefs.values.addKeyExists",
              "A value already exists for that key.  Use Edit to change it."));
      return;
    }
  }

  // 2) Ask for the JSON-encoded value.  Pre-fill with empty string for
  //    a sane default that immediately parses.
  let valHolder = { "value": "\"\"" };
  confirmed = prompts.prompt(window,
      bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
      bundleStr(bundle, "scriptPrefs.values.addValue",
          "Enter the JSON-encoded value:"),
      valHolder, null, {});
  if (!confirmed) return;

  let parsed;
  try {
    parsed = JSON.parse(valHolder.value);
  } catch (e) {
    prompts.alert(window,
        bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
        bundleStr(bundle, "scriptPrefs.values.invalidJson",
            "Invalid JSON: %1").replace("%1", "" + e));
    return;
  }

  try {
    gValuesStorage.setValue(key, parsed);
  } catch (e) {
    prompts.alert(window,
        bundleStr(bundle, "scriptPrefs.values.addTitle", "Add value"),
        "" + e);
    return;
  }

  loadValuesFromStorage();
  rebuildValuesTree();
}

function onValueEdit() {
  let row = selectedValueRow();
  if (!row || !gValuesStorage) return;
  let prompts = Services.prompt;
  let bundle = bundleForValuesDialogs();

  // Pre-fill with the current JSON.  Object / array values get pretty-
  // printed with 2-space indent so the user can edit comfortably.
  let initial;
  try {
    if (row.type === "object" || row.type === "array") {
      initial = JSON.stringify(row.value, null, 2);
    } else if (row.type === "invalid") {
      initial = row.raw || "";
    } else {
      initial = JSON.stringify(row.value);
    }
  } catch (e) {
    initial = row.raw || "";
  }

  let valHolder = { "value": initial };
  let confirmed = prompts.prompt(window,
      bundleStr(bundle, "scriptPrefs.values.editTitle", "Edit value")
          + " — " + row.name,
      bundleStr(bundle, "scriptPrefs.values.editValue",
          "Edit the JSON-encoded value:"),
      valHolder, null, {});
  if (!confirmed) return;

  let parsed;
  try {
    parsed = JSON.parse(valHolder.value);
  } catch (e) {
    prompts.alert(window,
        bundleStr(bundle, "scriptPrefs.values.editTitle", "Edit value"),
        bundleStr(bundle, "scriptPrefs.values.invalidJson",
            "Invalid JSON: %1").replace("%1", "" + e));
    return;
  }

  try {
    gValuesStorage.setValue(row.name, parsed);
  } catch (e) {
    prompts.alert(window,
        bundleStr(bundle, "scriptPrefs.values.editTitle", "Edit value"),
        "" + e);
    return;
  }

  loadValuesFromStorage();
  rebuildValuesTree();
}

function onValueDelete() {
  let row = selectedValueRow();
  if (!row || !gValuesStorage) return;
  let prompts = Services.prompt;
  let bundle = bundleForValuesDialogs();

  let title = bundleStr(bundle, "scriptPrefs.values.deleteTitle",
      "Delete value");
  let body = bundleStr(bundle, "scriptPrefs.values.deleteConfirm",
      "Delete the value for key '%1'?").replace("%1", row.name);
  if (!prompts.confirm(window, title, body)) return;

  try {
    gValuesStorage.deleteValue(row.name);
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
