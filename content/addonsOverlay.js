// This file is concerned with altering the Firefox 4+ AOM window,
// for those sorts of functionality we want that the API does not handle.
// (As opposed to addons4.jsm which is responsible
// for what the API does handle.)
if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");

(function private_scope() {
Cu.import("resource://gre/modules/AddonManager.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/addons.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/droppedUrls.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const SORT_BY = {
  "valueDef": "uiState,name",
  "checkStateReverse": "!",
  "checkStateValueAscending": "2",
  "checkStateValueDescending": "1",
};

const EXECUTION_INDEX_MAX = 9999;

const SCRIPT_DETAIL_VIEW_REGEXP = new RegExp(
    GM_CONSTANTS.scriptViewIDDetailPrefix
    + ".+"
    + encodeURIComponent(GM_CONSTANTS.scriptIDSuffix),
    "");

const FILE_SCRIPT_EXTENSION_REGEXP = new RegExp(
    GM_CONSTANTS.fileScriptExtensionRegexp + "$", ""); 

window.addEventListener("focus", focus, false);
window.addEventListener("load", init, false);
window.addEventListener("unload", unload, false);

// Patch the default createItem() to add our custom property.
var _createItemOrig = createItem;
createItem = function GM_createItem(aObj, aIsInstall, aIsRemote) {
  let item = _createItemOrig(aObj, aIsInstall, aIsRemote);
  if (aObj.type == GM_CONSTANTS.scriptAddonType) {
    // Save a reference to this richlistitem on the Addon object,
    // so we can fix attributes if/when it changes.
    aObj.richlistitem = item;
    setRichlistitemNamespace(aObj);
    setRichlistitemExecutionIndex(aObj);
  }

  return item;
};

// Patch the default onDrop() to make user script installation work.
var _gDragDrop_onDrop_Orig = gDragDrop.onDrop;
gDragDrop.onDrop = function GM_onDrop(aEvent) {
  let urls = droppedUrls(aEvent);

  let droppedNonUserScript = false;
  for (let i = urls.length - 1, url = null; url = urls[i]; i--) {
    if (FILE_SCRIPT_EXTENSION_REGEXP.test(url)) {
      GM_util.showInstallDialog(url);
    } else {
      droppedNonUserScript = true;
    }
  }

  // Pass call through to the original handler,
  // if any non-user-script was part of this drop action.
  if (droppedNonUserScript) {
    _gDragDrop_onDrop_Orig(aEvent);
  }
  else {
    aEvent.preventDefault();
  }
};

// Set up an "observer" on the config, to keep the displayed items up to date
// with their actual state.
var observer = {
  "notifyEvent": function observer_notifyEvent(aScript, aEvent, aData) {
    let events = {
      "edit-enabled": "edit-enabled",
      "install": "install",
      "modified": "modified",
      "move": "move",
      "uninstall": "uninstall",
    };
    let _eventsAlsoDetail = [
      events["edit-enabled"],
    ];
    let type = 0;
    if (isScriptView()) {
      type = 1;
    }
    if (isScriptDetailView() && _eventsAlsoDetail.includes(aEvent)) {
      type = 2;
    }
    if (type == 0) {
      return undefined;
    }

    var addon = ScriptAddonFactoryByScript(aScript);

    let item;
    switch (aEvent) {
      case events["edit-enabled"]:
        let callback;

        switch (type) {
          case 1:
            item = gListView.getListItemForID(addon.id);

            break;
          case 2:
            item = gDetailView;

            break;
        }
        if (!item) {
          GM_util.logError(
              GM_CONSTANTS.info.scriptHandler + " - " + '"' + aScript.id + '":'
              + "\n" + '"notifyEvent" - "' + aEvent + '" - item: ' + item,
              true, aScript.fileURL, null);
          break;
        }
        callback = aData ? item.onEnabled : item.onDisabled;
        if (!callback) {
          // This observer triggers in the case of an uninstall undo.
          // But does not need to - and can not - run.
          // Ignore this case.
          break;
        }
        item.userDisabled = !aData;

        if (type == 2) {
          item._updateView(addon, !addon.isCompatible);
        }
        callback.call(item);

        break;
      case events["install"]:
        gListView.addItem(addon);
        // The newly-appended richlistitem needs to respect any active
        // live-search filter.  Re-apply.
        try {
          if (typeof gmLiveSearchInput == "function") gmLiveSearchInput();
        } catch (e) {}

        break;
      case events["move"]:
        // Refresh every richlistitem's executionIndex attribute and
        // re-apply the sort, mirroring what reorderScriptExecution()
        // does after its own config.move() call.  This makes the AOM
        // row order reflect any caller of config.move() — including
        // the per-script Options dialog (scriptPrefs.js) where the
        // user picks a position from the dropdown.  Pre-fix, only the
        // right-click "Execute first/sooner/later/last" path worked,
        // because it manually invoked this same logic; the Options
        // dialog called config.move() but the row order didn't redraw
        // until the user switched tabs.
        AddonManager.getAddonsByTypes(
            [GM_CONSTANTS.scriptAddonType], function (aAddons) {
          for (let i = 0, iLen = aAddons.length; i < iLen; i++) {
            let movedAddon = aAddons[i];
            if (addonExecutesRichlistitem(movedAddon)) {
              setRichlistitemExecutionIndex(movedAddon);
            }
          }
          applySort();
          let richlistbox = document.getElementById("addon-list");
          if (richlistbox && richlistbox.currentItem) {
            richlistbox.ensureElementIsVisible(richlistbox.currentItem);
          }
        });
        break;
      case events["modified"]:
        if (!aData) {
          break;
        }
        var oldAddon = ScriptAddonFactoryByScript({
          "id": aData,
        });
        if (!oldAddon) {
          break;
        }
        addon = ScriptAddonFactoryByScript(aScript, true);

        // Use old and new the addon references to update the view.
        item = createItem(addon);
        let oldItem = gListView.getListItemForID(oldAddon.id);
        if (oldItem) {
          oldItem.parentNode.replaceChild(item, oldItem);
        }

        break;
      case events["uninstall"]:
        if (!aData) {
          // In this observer context, "aData" is a boolean,
          // true means the uninstall happened "for update".
          // If it was _not_ for update, remove this item from the UI.
          gListView.removeItem(addon);
        }

        break;
    }

    setEmptyWarningVisible();
  },
};

// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

function addonIsInstalledScript(aAddon) {
  if (!aAddon) {
    return false;
  }
  if (aAddon.type != GM_CONSTANTS.scriptAddonType) {
    return false;
  }
  if (aAddon._script.needsUninstall) {
    return false;
  }

  return true;
};

function isScriptView() {
  return gViewController.currentViewId == GM_CONSTANTS.scriptViewID;
}

function isScriptDetailView() {
  // return SCRIPT_DETAIL_VIEW_REGEXP.test(gViewController.currentViewId);
  return gDetailView._addon !== null;
}

function addonExecutesRichlistitem(aAddon) {
  return !(typeof aAddon.richlistitem == "undefined");
}

function addonExecutesNonFirst(aAddon) {
  if (!aAddon) {
    return false;
  }
  if (aAddon.type != GM_CONSTANTS.scriptAddonType) {
    return false;
  }

  return (aAddon.executionIndex != 0) && addonExecutesRichlistitem(aAddon);
}

function addonExecutesNonLast(aAddon) {
  if (!aAddon) {
    return false;
  }
  if (aAddon.type != GM_CONSTANTS.scriptAddonType) {
    return false;
  }

  return ((GM_util.getService().config.scripts.length - 1)
      != aAddon.executionIndex) && addonExecutesRichlistitem(aAddon);
}

function addonUpdateCanBeAllowed(aAddon) {
  if (!aAddon) {
    return false;
  }
  if (aAddon.type != GM_CONSTANTS.scriptAddonType) {
    return false;
  }

  return aAddon._script.isRemoteUpdateAllowed(false);
}

function addonUpdateCanBeForced(aAddon) {
  if (!aAddon) {
    return false;
  }
  if (aAddon.type != GM_CONSTANTS.scriptAddonType) {
    return false;
  }
  let script = aAddon._script;

  // Can be forced if non-forced isn't allowed, but forced is.
  return !script.isRemoteUpdateAllowed(false)
      && script.isRemoteUpdateAllowed(true);
}

function sortedByExecOrder() {
  return document.getElementById("greasemonkey-sort-bar")
      .getElementsByAttribute("sortBy", "executionIndex")[0]
      .hasAttribute("checkState");
};

function focus() {
  // When the window gains focus, it might be from switching to an editor
  // and back, so scan for updated scripts.
  let config = GM_util.getService().config;
  config.updateModifiedScripts("document-start", null);
  config.updateModifiedScripts("document-end", null);
  config.updateModifiedScripts("document-idle", null);
}

function init() {
  GM_util.getService().config.addObserver(observer);

  gViewController.commands.cmd_userscript_edit = {
      "isEnabled": addonIsInstalledScript,
      "doCommand": function (aAddon) {
        GM_util.openInEditor(aAddon._script);
      }
    };
  gViewController.commands.cmd_userscript_show = {
      "isEnabled": addonIsInstalledScript,
      "doCommand": function (aAddon) {
        GM_openFolder(aAddon._script.file);
      }
    };
  gViewController.commands.cmd_userscript_remove = {
      "isEnabled": addonIsInstalledScript,
      "doCommand": function (aAddon) {
        // The addon's own uninstall() marks PENDING_UNINSTALL and fires
        // onUninstalling, so the Add-ons Manager shows its "removed —
        // Undo" affordance (cancelUninstall reverts).  The generic
        // cmd_uninstallItem removed immediately; this matches the row
        // Remove button instead.
        aAddon.uninstall();
      }
    };
  gViewController.commands.cmd_userscript_showItemPreferences = {
      // Always enabled for installed user scripts — including disabled
      // ones.  The AOM's built-in prefs button gates on `isActive`; ours
      // does not, which is the whole point of having our own command.
      "isEnabled": addonIsInstalledScript,
      "doCommand": function (aAddon) {
        gmOpenScriptPrefs(aAddon);
      }
    };

  gViewController.commands.cmd_userscript_execute_first = {
      "isEnabled": addonExecutesNonFirst,
      "doCommand": function (aAddon) {
        reorderScriptExecution(aAddon, -(EXECUTION_INDEX_MAX));
      }
    };
  gViewController.commands.cmd_userscript_execute_sooner = {
      "isEnabled": addonExecutesNonFirst,
      "doCommand": function (aAddon) {
        reorderScriptExecution(aAddon, -1);
      }
    };
  gViewController.commands.cmd_userscript_execute_later = {
      "isEnabled": addonExecutesNonLast,
      "doCommand": function (aAddon) {
        reorderScriptExecution(aAddon, 1);
      }
    };
  gViewController.commands.cmd_userscript_execute_last = {
      "isEnabled": addonExecutesNonLast,
      "doCommand": function (aAddon) {
        reorderScriptExecution(aAddon, EXECUTION_INDEX_MAX);
      }
    };

  gViewController.commands.cmd_userscript_manualFindItemUpdates = {
      "isEnabled": addonUpdateCanBeAllowed,
      "doCommand": function (aAddon) {
        // If the script has local edits, warn the user that proceeding
        // will overwrite their changes.  Matches Violentmonkey's
        // confirmManualUpdate flow (see Issue #9).
        let script = aAddon._script;
        let hasLocalEdits = script
            && (script._modifiedTime > script._installTime);
        if (hasLocalEdits) {
          let result = confirm(
              GM_CONSTANTS.localeStringBundle.createBundle(
                    GM_CONSTANTS.localeGmAddonsProperties)
                    .GetStringFromName("confirmForceUpdate"));
          if (!result) {
            return;
          }
          // User confirmed: overwrite edits.  forceUpdate=true ensures
          // the enabled/scheme guards don't re-block us if the script is
          // also currently disabled.
          aAddon.forceUpdate = true;
          gViewController.commands.cmd_findItemUpdates.doCommand(aAddon);
          aAddon.forceUpdate = false;
          return;
        }
        aAddon.manualUpdate = true;
        gViewController.commands.cmd_findItemUpdates.doCommand(aAddon);
        aAddon.manualUpdate = false;
      }
  };

  gViewController.commands.cmd_userscript_forcedFindItemUpdates = {
      "isEnabled": addonUpdateCanBeForced,
      "doCommand": function (aAddon) {
        let result = confirm(
            GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGmAddonsProperties)
                  .GetStringFromName("confirmForceUpdate"));
        if (result) {
          aAddon.forceUpdate = true;
          gViewController.commands.cmd_findItemUpdates.doCommand(aAddon);
          aAddon.forceUpdate = false;
        }
      }
  };

  window.addEventListener("ViewChanged", onViewChanged, false);
  // Initialize on load as well as when it changes later.
  onViewChanged();

  document.getElementById("addonitem-popup").addEventListener(
      "popupshowing", onPopupShowing, false);

  document.getElementById("greasemonkey-sort-bar").addEventListener(
      "command", onSortersClicked, false);
  applySort();

  // Orphan-recovery affordance.  The label is hidden in the XUL; reveal
  // it (and dynamically set its text to include the count) iff a fresh
  // scan of <profile>/gm_scripts/ finds any orphaned script directories.
  //
  // refreshOrphans() re-walks the filesystem instead of returning the
  // cached snapshot from startup.  Without that, a successful
  // Recover-Orphans run leaves the in-memory list stale: subsequent
  // pane re-renders would re-show the link with the original count,
  // and clicking it would try to read .user.js files from paths that
  // were already renamed to ".recovered" — producing NS_ERROR_FILE_NOT_FOUND
  // errors in the summary.  A directory walk on pane open is cheap
  // (one stat per top-level entry under gm_scripts/) and keeps the
  // displayed state honest.
  try {
    let recoverLink = document.getElementById("gm-recover-orphans");
    if (recoverLink) {
      let config = GM_util.getService().config;
      let orphans;
      if (config.refreshOrphans) {
        orphans = config.refreshOrphans();
      } else if (config.getOrphans) {
        orphans = config.getOrphans();
      } else {
        orphans = [];
      }
      if (orphans.length > 0) {
        // Localized via gmAddons.properties; "#1" → the orphan count.
        // Falls back to English if a locale file predates these keys, so
        // non-English users still get the link (the same text they saw
        // before this string was localized) instead of losing it.
        let n = orphans.length;
        let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmAddonsProperties);
        let label, tip;
        try {
          label = bundle.GetStringFromName("recoverOrphans.label")
              .replace("#1", n);
          tip = bundle.GetStringFromName("recoverOrphans.tooltip");
        } catch (eL10n) {
          label = "Recover " + n + " orphan(s)...";
          tip = "Reinstall script directories that exist in gm_scripts/"
              + " but have no entry in config.xml";
        }
        recoverLink.setAttribute("value", label);
        recoverLink.setAttribute("tooltiptext", tip);
        recoverLink.hidden = false;
      } else {
        // Defensive: a prior pane open may have unhidden the link;
        // if the fresh scan finds nothing, hide it again.
        recoverLink.hidden = true;
      }
    }
  } catch (e) {
    // Non-fatal — log but don't block the User Scripts pane from rendering.
    Components.utils.reportError(
        "Greasemonkey: orphan-link init failed: " + e);
  }

  // Apply the about:config UI visibility toggles (Import/Export, search).
  gmApplyManagerPrefs();

  // Wire up the opt-in responsive (two-row-when-narrow) header.  No-op unless
  // extensions.greasemonkey.manager.responsiveHeader.enabled is true.
  gmSetupResponsiveHeader();
};

function getSortBy(aButtons) {
  let sortBy = GM_prefRoot.getValue("sortBy", SORT_BY.valueDef);
  let sortByValue = sortBy.replace(SORT_BY.checkStateReverse, "");
  let sortByCheckStateAscending =
      !(sortBy.substring(0, 1) == SORT_BY.checkStateReverse);

  // Remove checkState from all buttons.
  for (let i = 0, iLen = aButtons.length; i < iLen; i++) {
    let el = aButtons[i];
    el.removeAttribute("checkState");
  }

  let button = null;
  for (let i = 0, iLen = aButtons.length; i < iLen; i++) {
    button = aButtons[i];
    if (button.getAttribute("sortBy") == sortByValue) {
      button.setAttribute("checkState",
      (sortByCheckStateAscending
          ? SORT_BY.checkStateValueAscending
          : SORT_BY.checkStateValueDescending));
      break;
    }
  }

  return button;
}

function setSortBy(aButton) {
  let ascending = SORT_BY.checkStateValueDescending
      != aButton.getAttribute("checkState");

  GM_prefRoot.setValue(
      "sortBy",
      (!ascending ? SORT_BY.checkStateReverse : "")
      + aButton.getAttribute("sortBy"));
}

function onSortersClicked(aEvent) {
  if (aEvent.target.tagName != "button") {
    return undefined;
  }
  let button = aEvent.target;

  let checkState = button.getAttribute("checkState");

  // Remove checkState from all buttons.
  let buttons = document.getElementById("greasemonkey-sort-bar")
      .getElementsByTagName("button");
  for (let i = 0, el = null; el = buttons[i]; i++) {
    el.removeAttribute("checkState");
  }

  // Toggle state of this button.
  if (checkState == SORT_BY.checkStateValueAscending) {
    button.setAttribute("checkState", SORT_BY.checkStateValueDescending);
  } else {
    button.setAttribute("checkState", SORT_BY.checkStateValueAscending);
  }

  setSortBy(button);

  applySort();
};

function applySort() {
  if (gViewController.currentViewId != GM_CONSTANTS.scriptViewID) {
    return undefined;
  }

  // Find checked button.
  let buttons = document.getElementById("greasemonkey-sort-bar")
      .getElementsByTagName("button");
  getSortBy(buttons);
  let button = null;
  for (let i = 0; button = buttons[i]; i++) {
    if (button.hasAttribute("checkState")) {
      break;
    }
  }

  let ascending = SORT_BY.checkStateValueDescending
      != button.getAttribute("checkState");
  let sortBy = button.getAttribute("sortBy").split(",");

  setSortBy(button);

  let list = document.getElementById("addon-list");
  let elements = Array.slice(list.childNodes, 0);
  sortElements(elements, sortBy, ascending);
  while (list.lastChild) {
    list.removeChild(list.lastChild);
  }
  elements.forEach(function (aElm) {
    list.appendChild(aElm);
  });

  // Re-apply the live-search filter so re-ordering doesn't make
  // hidden rows reappear.  No-op if the search box is empty.
  try {
    if (typeof gmLiveSearchInput == "function") gmLiveSearchInput();
  } catch (e) {}
};

function onViewChanged(aEvent) {
  if (gViewController.currentViewId == GM_CONSTANTS.scriptViewID) {
    document.documentElement.classList.add("greasemonkey");
    setEmptyWarningVisible();
    applySort();
    // The User Scripts pane just became visible (and laid out) — re-check
    // whether the responsive header should stack.  No-op when the pref is off.
    gmScheduleHeaderEval();
  } else {
    document.documentElement.classList.remove("greasemonkey");
  }
  updateDetailEditButton();
  updateDetailPrefsButton();
};

/**
 * Shows / hides the "Edit" button next to the built-in Options button in
 * the Add-ons Manager detail (About) pane.  The button only makes sense
 * for Greasemonkey user scripts (they have an on-disk .user.js file that
 * the user's configured external editor can open), so we hide it for
 * every other add-on type and for non-detail views.
 *
 * Wired to cmd_userscript_edit via the command= attribute on the button
 * itself (see addonsOverlay.xul), so no click handler is needed here —
 * the command dispatcher uses gDetailView._addon as its argument.
 */
function updateDetailEditButton() {
  let btn = document.getElementById("gm-detail-edit-btn");
  if (!btn) { return; }

  let viewId = gViewController.currentViewId;
  let isDetail = viewId
      && (viewId.indexOf(GM_CONSTANTS.scriptViewIDDetailPrefix) == 0);
  if (!isDetail) {
    btn.hidden = true;
    return;
  }

  let addon = null;
  try {
    // gDetailView is the extensions.js view controller for the detail
    // pane.  Its _addon is the add-on currently being shown.
    if (typeof gDetailView != "undefined" && gDetailView) {
      addon = gDetailView._addon || null;
    }
  } catch (e) {
    addon = null;
  }

  btn.hidden = !(addon && (addon.type == GM_CONSTANTS.scriptAddonType));
};

/**
 * For Greasemonkey user-script detail views, hides the AOM's built-in
 * Options button (#detail-prefs-btn) and shows our own
 * (#gm-detail-prefs-btn) in the same spot.  Our button is wired to
 * cmd_userscript_showItemPreferences via the command= attribute in
 * addonsOverlay.xul, and that command always opens the prefs dialog
 * regardless of `isActive` — fixes the disabled-script bug that
 * resisted every attempt to override the AOM's button from the outside.
 *
 * For every other addon type and every non-detail view, the AOM button
 * is restored to whatever state it had before we touched it (visible
 * for addons with optionsURL, hidden otherwise) and the original
 * tooltip is put back.  That stops the user-script tooltip from
 * leaking into the Extensions tab (#3 in the v3.7.0 feedback).
 */
function updateDetailPrefsButton() {
  let aomBtn = document.getElementById("detail-prefs-btn");
  let gmBtn  = document.getElementById("gm-detail-prefs-btn");

  let viewId = gViewController.currentViewId;
  let isDetail = viewId
      && (viewId.indexOf(GM_CONSTANTS.scriptViewIDDetailPrefix) == 0);

  let addon = null;
  if (isDetail) {
    try {
      if (typeof gDetailView != "undefined" && gDetailView) {
        addon = gDetailView._addon || null;
      }
    } catch (e) { addon = null; }
  }

  let isUserscript = !!(addon
      && addon.type == GM_CONSTANTS.scriptAddonType);

  if (!isUserscript) {
    // Restore AOM's button to whatever it was before we touched it.
    // Both `hidden` and an explicit `style.display = none` so the AOM
    // CSS rule that hides .addon-control for inactive addons takes back
    // over without our inline style winning the cascade.
    if (gmBtn) {
      gmBtn.hidden = true;
      gmBtn.style.display = "none";
    }
    if (aomBtn && aomBtn._gmHiddenByGM) {
      aomBtn.hidden = aomBtn._gmAomOrigHidden;
      aomBtn._gmHiddenByGM = false;
    }
    return;
  }

  // ─── Userscript detail view ────────────────────────────────────────
  // Hide AOM's button (remembering its original hidden state so we can
  // restore it on leave), show ours.
  if (aomBtn && !aomBtn._gmHiddenByGM) {
    aomBtn._gmAomOrigHidden = aomBtn.hidden;
    aomBtn._gmHiddenByGM = true;
  }
  if (aomBtn) aomBtn.hidden = true;

  if (gmBtn) {
    gmBtn.hidden = false;
    // ── Disabled-script Options-button fix (3.7.0 feedback #1) ─────
    // Belt-and-braces:
    //   1. Inline `display` overrides any AOM CSS that hides
    //      .addon-control descendants for inactive add-ons.
    //   2. Clearing `disabled` keeps the button click-able even if
    //      AOM's gDetailView_updateState walks the detail pane and
    //      tries to gray it out.  We dropped the `addon-control`
    //      class in addonsOverlay.xul so the iterator should not
    //      touch us, but this is cheap defence-in-depth.
    gmBtn.style.display = "-moz-box";
    gmBtn.removeAttribute("disabled");
    if ("disabled" in gmBtn) gmBtn.disabled = false;
    // Set our button's label + tooltip from locale.  Doing it here
    // (rather than in the XUL via &entity;) so the strings can come
    // from the gmAddons.properties bundle and stay in sync with the
    // AOM's "Options" wording on platforms where we want to mirror it.
    try {
      let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGmAddonsProperties);
      gmBtn.setAttribute("tooltiptext",
          bundle.GetStringFromName("scriptPrefs.optionsBtn.tooltip"));
    } catch (e) {}
    // Re-use the AOM's "Options" label from the platform DTD by reading
    // the AOM button's label.  Falls back to a hard-coded "Options" if
    // the AOM button somehow has no label.
    if (!gmBtn.getAttribute("label")) {
      let aomLabel = aomBtn ? aomBtn.getAttribute("label") : null;
      gmBtn.setAttribute("label", aomLabel || "Options");
    }
  }
}

/**
 * Opens the per-script preferences window as a non-modal, resizable,
 * maximizable top-level chrome window.  Used by both the AOM Options
 * button (via the capture-phase listener installed in
 * updateDetailPrefsButton) and any other future entry point that wants
 * to surface a script's prefs.
 *
 * If a prefs window for this exact script is already open, focuses it
 * instead of stacking duplicates.
 */
function gmOpenScriptPrefs(aAddon) {
  let url = aAddon.optionsURL;
  if (!url) return;

  // Already open?  Focus it.
  let enumerator = Services.wm.getEnumerator(null);
  while (enumerator.hasMoreElements()) {
    let win = enumerator.getNext();
    try {
      if (win.closed) continue;
      if (win.document && win.document.documentURI === url) {
        win.focus();
        return;
      }
    } catch (e) { /* tear-down race; keep looking */ }
  }

  // ── 3.7.0 feedback #2: window must be resizable + minimisable ───
  // Earlier attempts that asked for "chrome,titlebar,toolbar,...,
  // resizable,dialog=no" produced a window whose corners couldn't be
  // dragged on Pale Moon.  The recipe Pale Moon's own PageInfo
  // window uses ("chrome,toolbar,dialog=no,resizable,minimizable,
  // centerscreen") DOES give a fully resizable, Min/Max-equipped
  // chrome window — so we adopt it verbatim here.  The presence of
  // `minimizable` is what convinces Windows' WM to add the Min/Max
  // buttons to the title bar; without it some builds render only a
  // close button.
  let features = "chrome,toolbar,dialog=no,resizable,minimizable,centerscreen";
  let browserWin = Services.wm.getMostRecentWindow("navigator:browser");
  if (browserWin) {
    browserWin.openDialog(url, "_blank", features);
  } else {
    Services.ww.openWindow(null, url, "_blank", features, null);
  }
}

function onPopupShowing(aEvent) {
  // e.g. the restart to gDetailView - aAddon.richlistitem is undefined
  gViewController.updateCommands();

  // Flip the first context-menu item between Enable and Disable based on
  // the right-clicked script's state, pointing it at the matching AOM
  // command.  Best-effort: if the selected addon can't be read, the item
  // keeps its default (Disable) and the AOM command's own isEnabled guard
  // still applies.
  try {
    let toggle = document.getElementById("gm-context-toggle");
    let list = document.getElementById("addon-list");
    let item = list ? list.selectedItem : null;
    let addon = item ? item.mAddon : null;
    if (toggle && addon) {
      let disabled = addon.userDisabled;
      toggle.setAttribute("label",
          toggle.getAttribute(disabled ? "enablelabel" : "disablelabel"));
      toggle.setAttribute("command",
          disabled ? "cmd_enableItem" : "cmd_disableItem");
    }
  } catch (e) {
    // Non-fatal — leave the default label/command.
  }
};

function setEmptyWarningVisible() {
  let emptyWarning = document.getElementById("user-script-list-empty");
  emptyWarning.collapsed = !!GM_util.getService().config.scripts.length;
}

function selectScriptExecOrder() {
  if (sortedByExecOrder()) {
    return undefined;
  }

  let button = document.getElementById("greasemonkey-sort-bar")
      .getElementsByAttribute("sortBy", "executionIndex")[0];
  // Sort the script list by execution order.
  onSortersClicked({
    "target": button,
  });
};

function reorderScriptExecution(aAddon, aMoveBy) {
  selectScriptExecOrder();
  GM_util.getService().config.move(aAddon._script, aMoveBy);
  AddonManager.getAddonsByTypes(
      [GM_CONSTANTS.scriptAddonType], function (aAddons) {
    // Fix all the "executionOrder" attributes.
    for (let i = 0, iLen = aAddons.length; i < iLen; i++) {
      let addon = aAddons[i];
      setRichlistitemExecutionIndex(addon);
    }
    // Re-sort the list, with these fixed attributes.
    applySort();
    // Ensure the selected element is still visible.
    let richlistbox = document.getElementById("addon-list");
    richlistbox.ensureElementIsVisible(richlistbox.currentItem);
  });
};

function setRichlistitemExecutionIndex(aAddon) {
  // String format with leading zeros, so it will sort properly.
  let str = aAddon.executionIndex.toString();
  while (str.length < (EXECUTION_INDEX_MAX.toString().length + 1)) {
    str = "0" + str;
  }
  aAddon.richlistitem.setAttribute("executionIndex", str);
};

function setRichlistitemNamespace(aAddon) {
  aAddon.richlistitem.setAttribute("namespace", aAddon.namespace);
};

function unload() {
  var GM_config = GM_util.getService().config;
  // Since .getAddonsByTypes() is asynchronous,
  // AddonManager gets destroyed by the time the callback runs.
  // Cache this value we need from it.
  var pending_uninstall = AddonManager.PENDING_UNINSTALL;

  AddonManager.getAddonsByTypes(
      [GM_CONSTANTS.scriptAddonType], function (aAddons) {
    let didUninstall = false;
    for (let i = 0, addon = null; addon = aAddons[i]; i++) {
      if (addon.pendingOperations & pending_uninstall) {
        addon.performUninstall();
        didUninstall = true;
      }
    }
    // Guarantee that the config.xml is saved to disk.
    if (didUninstall) {
      GM_config.save(true);
    }
  });

  GM_config.removeObserver(observer);
};
})();

/**
 * Click handler for the Greasemonkey Options button in the AOM
 * detail-view (#gm-detail-prefs-btn).  Lives at module scope (not
 * inside the IIFE) because XUL inline `onclick="…"` is evaluated in
 * the document's global scope.
 *
 * Why we use this instead of `command="cmd_userscript_showItemPreferences"`:
 * Pale Moon's extensions.js disables every `.addon-control` button in
 * the detail pane when the addon is inactive (userDisabled), and a
 * disabled XUL button silently swallows the click that would otherwise
 * dispatch the command.  Routing through onclick + a direct call to
 * the controller bypasses that path entirely.
 */
function gmDetailPrefsClicked(aEvent) {
  if (aEvent && aEvent.button) return;
  let addon = null;
  try {
    if (typeof gDetailView != "undefined" && gDetailView) {
      addon = gDetailView._addon || null;
    }
  } catch (e) {}
  if (!addon) return;
  // Defensive: even if our class drop didn't help, a disabled button
  // sometimes still fires onclick.  Just call the command's doCommand
  // directly so the dialog opens regardless of UI state.
  try {
    let cmd = gViewController.commands.cmd_userscript_showItemPreferences;
    if (cmd && typeof cmd.doCommand == "function") {
      cmd.doCommand(addon);
    }
  } catch (e) {
    Components.utils.reportError(
        "Greasemonkey: gmDetailPrefsClicked failed: " + e);
  }
}

/**
 * Live-search filter for the Greasemonkey tab in about:addons (3.7.0).
 * Walks #addon-list and toggles `hidden` on every richlistitem whose
 * name / namespace / description / id does NOT contain the query.
 *
 * Lives at module scope because XUL inline `oninput="…"` is evaluated
 * in the document's global, not inside the IIFE above.
 *
 * Independent of the AOM's own top-right "Search all add-ons" box —
 * that one navigates to a different view; ours just filters in place
 * so the user can sort + scope at the same time.
 */
function gmLiveSearchInput() {
  let input = document.getElementById("gm-live-search");
  if (!input) return;
  let q = (input.value || "").toLowerCase().trim();
  let list = document.getElementById("addon-list");
  if (!list) return;

  // childNodes covers both legacy XUL trees and modern DOM-rooted lists.
  let nodes = list.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    let r = nodes[i];
    if (!r || r.localName != "richlistitem") continue;
    if (!q) {
      r.hidden = false;
      continue;
    }
    let hay = ((r.getAttribute("name")        || "") + "\n"
             + (r.getAttribute("namespace")   || "") + "\n"
             + (r.getAttribute("description") || "") + "\n"
             + (r.getAttribute("value")       || "") + "\n"
             + (r.getAttribute("version")     || ""))
        .toLowerCase();
    r.hidden = (hay.indexOf(q) < 0);
  }
}

function GM_openUserscriptsOrg() {
  let chromeWin = GM_util.getBrowserWindow();
  chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(
      "http://wiki.greasespot.net/User_Script_Hosting");
  /*
  chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(
      GM_CONSTANTS.dataUserScriptHosting);
  */
}

// ── "New…" split-menu actions ───────────────────────────────────────────────

// Open a script-host site in a new browser tab (GreasyFork / OpenUserJS /
// GitHub Gist).  Same mechanism GM_openUserscriptsOrg uses.
function GM_openSite(aUrl) {
  let chromeWin = GM_util.getBrowserWindow();
  chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(aUrl);
}

// "Install from URL…" — open the small dismissible panel anchored to the
// New… button.  Clicking outside or Cancel hides it (autohide panel).
function GM_installFromUrlShow() {
  let input = document.getElementById("gm-install-url-input");
  if (input) {
    input.value = "";
  }
  let panel = document.getElementById("gm-install-url-panel");
  if (!panel) {
    return;
  }
  let anchor = document.getElementById("gm-new-menu");
  if (anchor) {
    panel.openPopup(anchor, "after_start", 0, 0, false, false);
  } else {
    panel.openPopup(null, "", 0, 0, false, false);
  }
}

// Install the typed URL through the standard install dialog (the same path
// drag-and-drop uses at GM_onDrop), then close the panel.  An unparseable
// or non-http(s)/file URL is rejected up front with the same localized
// "Invalid URL" message GM uses elsewhere, instead of failing silently.
function GM_installFromUrlGo() {
  let input = document.getElementById("gm-install-url-input");
  let panel = document.getElementById("gm-install-url-panel");
  let url = input ? input.value.trim() : "";
  if (!url) {
    return;
  }
  let valid = false;
  try {
    let uri = Services.io.newURI(url, null, null);
    valid = (uri.scheme == "http" || uri.scheme == "https"
        || uri.scheme == "file");
  } catch (e) {
    valid = false;
  }
  if (!valid) {
    let bundle = GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties);
    Services.prompt.alert(null, "Greasemonkey",
        bundle.GetStringFromName("error.invalidUrl").replace("%1", url));
    return;
  }
  if (panel) {
    panel.hidePopup();
  }
  GM_util.showInstallDialog(url);
}

// Open the "New…" dropdown anchored under its text-link.  (We use a
// text-link + JS-opened menupopup instead of a <button type="menu"> so it
// visually matches the neighbouring Export All… / Import… links.)
function GM_newMenuShow(aEvent) {
  let popup = document.getElementById("gm-new-menu-popup");
  let anchor = document.getElementById("gm-new-menu");
  if (popup && anchor) {
    popup.openPopup(anchor, "after_start", 0, 0, false, false);
  }
}

// Honour the about:config UI toggles (manager.importExport.enabled /
// manager.search.enabled): hide the Import/Export links and/or the live-
// search box when turned off.  Read when the User Scripts pane inits;
// changing the pref takes effect on the next about:addons open.
function gmApplyManagerPrefs() {
  try {
    let showIE = GM_prefRoot.getValue("manager.importExport.enabled", true);
    let showSearch = GM_prefRoot.getValue("manager.search.enabled", true);
    let exportLink = document.getElementById("gm-export-all");
    let importLink = document.getElementById("gm-import");
    if (exportLink) { exportLink.hidden = !showIE; }
    if (importLink) { importLink.hidden = !showIE; }
    let searchBox = document.getElementById("gm-live-search");
    if (searchBox) { searchBox.hidden = !showSearch; }
  } catch (e) {
    Components.utils.reportError(
        "Greasemonkey: applying manager UI prefs failed: " + e);
  }
}

// ── Opt-in responsive header (manager.responsiveHeader.enabled) ──────────────
// Default OFF: the sort bar stays the classic single row, exactly as it has
// always been.  When the pref is true we watch the header's width and toggle
// the "gm-sortbar-stacked" class (see addons.css) whenever the single row
// would overflow — so the actions and the search/sort controls wrap onto two
// rows instead of the sort buttons being cropped off the right edge.
//
// We measure the two groups' natural widths directly rather than relying on a
// CSS media-query breakpoint, so the decision is correct in any locale, font
// size, or zoom level, and regardless of the category sidebar's width.

var gmResponsiveHeaderEnabled = false;
var gmHeaderEvalPending = false;

function gmSetupResponsiveHeader() {
  try {
    gmResponsiveHeaderEnabled =
        GM_prefRoot.getValue("manager.responsiveHeader.enabled", false);
  } catch (e) {
    gmResponsiveHeaderEnabled = false;
  }
  if (!gmResponsiveHeaderEnabled) {
    return;
  }
  // Re-evaluate on window resize (this also fires on full-page zoom, which
  // shrinks the CSS-pixel viewport) — and once now.
  window.addEventListener("resize", gmScheduleHeaderEval, false);
  gmScheduleHeaderEval();
}

// Coalesce bursts of resize events into a single evaluation on the next tick.
function gmScheduleHeaderEval() {
  if (!gmResponsiveHeaderEnabled || gmHeaderEvalPending) {
    return;
  }
  gmHeaderEvalPending = true;
  window.setTimeout(gmEvaluateHeader, 0);
}

function gmEvaluateHeader() {
  gmHeaderEvalPending = false;
  if (!gmResponsiveHeaderEnabled) {
    return;
  }
  // The bar only exists / is laid out on the User Scripts pane.
  if (gViewController.currentViewId != GM_CONSTANTS.scriptViewID) {
    return;
  }
  let bar = document.getElementById("greasemonkey-sort-bar");
  let actions = document.getElementById("gm-sortbar-actions");
  let listControls = document.getElementById("gm-sortbar-listcontrols");
  if (!bar || !actions || !listControls) {
    return;
  }
  // Measure the groups' natural widths in the UN-stacked state.  Removing the
  // class and re-adding it within this one synchronous function never paints
  // an intermediate frame, so there is no flicker.
  if (bar.classList.contains("gm-sortbar-stacked")) {
    bar.classList.remove("gm-sortbar-stacked");
  }
  let have = bar.getBoundingClientRect().width;
  if (have < 1) {
    // Not laid out yet (e.g. pane hidden) — leave it single-row.
    return;
  }
  // 24px slack covers the .view-header padding and a minimum inter-group gap,
  // and doubles as hysteresis so the layout doesn't oscillate at the edge.
  let need = actions.getBoundingClientRect().width
      + listControls.getBoundingClientRect().width + 24;
  if (need > have) {
    bar.classList.add("gm-sortbar-stacked");
  }
}

// Lazy scope for the backup module so we don't pay the import cost until
// the user actually clicks Export or Import.
var GM_backup_scope = null;
function GM_backup_get() {
  if (!GM_backup_scope) {
    GM_backup_scope = {};
    Components.utils.import(
        "chrome://greasemonkey-modules/content/backup.js", GM_backup_scope);
  }
  return GM_backup_scope;
}

function GM_backup_defaultFilename() {
  // greasemonkey-YYYY-MM-DD.zip
  let d = new Date();
  let pad = function (n) { return (n < 10 ? "0" : "") + n; };
  return "greasemonkey-"
      + d.getFullYear() + "-"
      + pad(d.getMonth() + 1) + "-"
      + pad(d.getDate()) + ".zip";
}

function GM_backup_stringBundle() {
  return Components.classes[
      "@mozilla.org/intl/stringbundle;1"]
      .getService(Components.interfaces.nsIStringBundleService)
      .createBundle(
          "chrome://greasemonkey/locale/gmAddons.properties");
}

function GM_backupExport() {
  let fp = Components.classes["@mozilla.org/filepicker;1"]
      .createInstance(Components.interfaces.nsIFilePicker);
  fp.init(window,
      GM_backup_stringBundle().GetStringFromName("backup.exportTitle"),
      Components.interfaces.nsIFilePicker.modeSave);
  fp.defaultString = GM_backup_defaultFilename();
  // Without defaultExtension some pickers (GTK notably) save the file
  // extensionless when the user types a bare name — which the import
  // picker's *.zip filter would then hide.
  fp.defaultExtension = "zip";
  fp.appendFilter("ZIP archive", "*.zip");

  // nsIFilePicker's show() is synchronous on Pale Moon/Basilisk.
  let result = fp.show();
  if (result != Components.interfaces.nsIFilePicker.returnOK
      && result != Components.interfaces.nsIFilePicker.returnReplace) {
    return;
  }

  let backup = GM_backup_get();
  backup.GM_BackupExport(fp.file, /* includeValues */ true,
      function (aSuccess, aCount, aErr) {
    let bundle = GM_backup_stringBundle();
    if (aSuccess) {
      let msg = bundle.GetStringFromName("backup.exported")
          .replace("%1", aCount)
          .replace("%2", fp.file.path);
      // Per-script export problems (missing source file, zip entry
      // failures) used to be swallowed here — the user saw a clean
      // success dialog for an incomplete backup.
      if (aErr) {
        msg += "\n\n" + aErr.split("; ").join("\n");
      }
      alert(msg);
    } else {
      let msg = bundle.GetStringFromName("backup.failed")
          .replace("%1", aErr || "");
      alert(msg);
    }
  });
}

function GM_backupImport() {
  let fp = Components.classes["@mozilla.org/filepicker;1"]
      .createInstance(Components.interfaces.nsIFilePicker);
  fp.init(window,
      GM_backup_stringBundle().GetStringFromName("backup.importTitle"),
      Components.interfaces.nsIFilePicker.modeOpen);
  fp.appendFilter("ZIP archive", "*.zip");

  let result = fp.show();
  if (result != Components.interfaces.nsIFilePicker.returnOK) {
    return;
  }

  let backup = GM_backup_get();
  backup.GM_BackupImport(fp.file, function (aSuccess, aResult, aErr) {
    let bundle = GM_backup_stringBundle();
    if (!aSuccess) {
      let msg = bundle.GetStringFromName("backup.failed")
          .replace("%1", aErr || "");
      alert(msg);
      return;
    }
    let msg = bundle.GetStringFromName("backup.imported")
        .replace("%1", aResult.imported)
        .replace("%2", aResult.skipped);
    if (aResult.errors && aResult.errors.length) {
      msg += "\n\n" + aResult.errors.join("\n");
    }
    alert(msg);
  });
}

/**
 * "Recover Orphans..." link handler in the User Scripts pane.
 *
 * Walks the orphan list that Config._scanOrphans() built during
 * service startup (each entry is a <profile>/gm_scripts/<basedir>/
 * directory that contains a *.user.js file but has no <Script>
 * entry in config.xml — the classic post-downgrade-and-back state).
 * For each orphan we:
 *
 *   1. Read the .user.js source text off disk.
 *   2. Pipe it through installScriptFromSource({skipEditor: true})
 *      so the existing parseScript / RemoteScript install pipeline
 *      builds a NEW <Script> entry with a freshly-allocated basedir.
 *   3. Rename the original orphan directory to "<basedir>.recovered"
 *      so the next startup's orphan scan doesn't flag it again.  The
 *      rename preserves the user's data as a manual-recovery fallback
 *      should the install have introduced a regression — they can
 *      restore by renaming back and reverting GM to a working build.
 *
 * Installs are serialised (next starts after previous callback) so
 * RemoteScript writes to config.xml don't race.  GM_setValue storage
 * stored in the OLD <basedir>.db is left behind (the install creates
 * a fresh DB under the new basedir); a future enhancement could
 * migrate the rows over, but for now the user gets a fresh slate
 * which is the expected behaviour for "reinstall".
 */
function GM_recoverOrphans() {
  let config = GM_util.getService().config;
  let orphans = config.getOrphans ? config.getOrphans() : [];
  if (orphans.length == 0) {
    alert("No orphaned scripts to recover.");
    return;
  }

  let proceed = confirm(
      "Found " + orphans.length + " orphaned script director"
      + (orphans.length == 1 ? "y" : "ies")
      + " under <profile>/gm_scripts/.\n\n"
      + "Reinstalling will:\n"
      + "  • Register each script anew in config.xml.\n"
      + "  • Create a fresh GM_setValue storage for each.\n"
      + "  • Permanently delete the original folder and its"
      + "\n    associated <basedir>.db storage file.\n\n"
      + "GM_setValue data is NOT migrated.  If a script's stored"
      + "\nvalues matter to you, back them up before proceeding.\n\n"
      + "Proceed?");
  if (!proceed) {
    return;
  }

  // We need access to the chrome-side installer.  installScriptFromSource
  // is exported from the modules/util/ lazy-getter set on GM_util, so a
  // simple property reference grabs the bound implementation.
  let installScriptFromSource = GM_util.installScriptFromSource;
  if (typeof installScriptFromSource !== "function") {
    alert("Internal error: installScriptFromSource is unavailable.");
    return;
  }

  // Results accumulator for the summary alert at the end.
  let recovered = 0;
  let failed = 0;
  let errors = [];

  function next(i) {
    if (i >= orphans.length) {
      let msg = "Orphan recovery complete.\n"
          + "  Recovered: " + recovered + "\n"
          + "  Failed: " + failed;
      if (errors.length > 0) {
        msg += "\n\nErrors:\n" + errors.join("\n");
      }
      alert(msg);
      // Re-scan now that every recovered directory has been renamed to
      // ".recovered" (which the scanner skips).  Without this, the
      // in-memory orphan list would still hold the original entries
      // and a subsequent pane re-render would re-show the link with
      // its original count — and clicking it would try to read from
      // the now-renamed paths and fail with NS_ERROR_FILE_NOT_FOUND.
      try {
        if (config.refreshOrphans) {
          config.refreshOrphans();
        }
      } catch (e) {
        Components.utils.reportError(
            "Greasemonkey: post-recovery orphan re-scan failed: " + e);
      }
      // Hide the link immediately — the next pane open will also call
      // refreshOrphans() and confirm there's nothing left to recover.
      let link = document.getElementById("gm-recover-orphans");
      if (link) {
        link.hidden = true;
      }
      return;
    }
    let orphan = orphans[i];
    let source;
    try {
      source = GM_util.getContents(orphan.userJsFile);
    } catch (e) {
      failed++;
      errors.push(orphan.basedir + ": couldn't read .user.js: " + e);
      next(i + 1);
      return;
    }
    if (!source) {
      failed++;
      errors.push(orphan.basedir + ": .user.js was empty");
      next(i + 1);
      return;
    }

    installScriptFromSource(source, function (aErr) {
      if (aErr) {
        failed++;
        errors.push(orphan.basedir + ": "
            + (aErr.message || aErr.toString()));
      } else {
        recovered++;
        // Delete the orphan directory and its sibling .db storage
        // file outright.  The install pipeline already copied the
        // script source into a fresh gm_scripts/<id>-N/ subdir and
        // initialised a new .db for it, so the originals are now
        // dead weight.  GM_setValue data isn't migrated through
        // recovery anyway, so the old .db has no live referent.
        //
        // Storage convention (see modules/storageBack.js:16):
        //   <profile>/gm_scripts/<basedir>/   ← script directory
        //   <profile>/gm_scripts/<basedir>.db ← sibling SQLite file
        //
        // Both go.  Failures here are logged but non-fatal — the
        // install already succeeded; the worst case is a leftover
        // folder the user can remove via file explorer.
        try {
          let oldDir = orphan.userJsFile.parent;
          let gmScriptsDir = oldDir.parent;
          oldDir.remove(true); // deep=true (recursive directory removal)

          try {
            let dbFile = gmScriptsDir.clone();
            dbFile.append(orphan.basedir + ".db");
            if (dbFile.exists()) {
              dbFile.remove(false); // file, not directory
            }
          } catch (e2) {
            Components.utils.reportError(
                "Greasemonkey: post-recovery .db cleanup of "
                + orphan.basedir + " failed: " + e2);
          }
        } catch (e) {
          Components.utils.reportError(
              "Greasemonkey: post-recovery dir cleanup of "
              + orphan.basedir + " failed: " + e);
        }
      }
      next(i + 1);
    }, { "skipEditor": true });
  }

  next(0);
}
