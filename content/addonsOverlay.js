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
      "uninstall": "uninstall",
    };
    let _eventsAlsoDetail = [
      events["edit-enabled"],
    ];
    let type = 0;
    if (isScriptView()) {
      type = 1;
    }
    if (isScriptDetailView() && GM_util.inArray(_eventsAlsoDetail, aEvent)) {
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
};

function onViewChanged(aEvent) {
  if (gViewController.currentViewId == GM_CONSTANTS.scriptViewID) {
    document.documentElement.classList.add("greasemonkey");
    setEmptyWarningVisible();
    applySort();
  } else {
    document.documentElement.classList.remove("greasemonkey");
  }
};

function onPopupShowing(aEvent) {
  // e.g. the restart to gDetailView - aAddon.richlistitem is undefined
  gViewController.updateCommands();
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

function GM_openUserscriptsOrg() {
  let chromeWin = GM_util.getBrowserWindow();
  chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(
      "http://wiki.greasespot.net/User_Script_Hosting");
  /*
  chromeWin.gBrowser.selectedTab = chromeWin.gBrowser.addTab(
      GM_CONSTANTS.dataUserScriptHosting);
  */
}
