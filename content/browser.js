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

// Strict mode:
// TypeError: setting a property that has only a getter
// Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

var gGreasemonkeyVersion = "unknown";
Cu.import("resource://gre/modules/AddonManager.jsm");
AddonManager.getAddonByID(GM_CONSTANTS.addonGUID, function (aAddon) {
  gGreasemonkeyVersion = "" + aAddon.version;
});


const FILE_SCRIPT_EXTENSION_1_REGEXP = new RegExp(
    GM_CONSTANTS.fileScriptExtensionRegexp + "$", ""); 
const FILE_SCRIPT_EXTENSION_2_REGEXP = new RegExp(
    GM_CONSTANTS.fileScriptExtensionRegexp + "(\\?|$)", "");
const FILE_SCRIPT_CONTENT_TYPE_NO_REGEXP = new RegExp(
    GM_CONSTANTS.fileScriptContentTypeNoRegexp, "i");

// This file is the JavaScript backing for the UI wrangling which happens
// in browser.xul.
// It also initializes the Greasemonkey singleton which contains
// all the main injection logic, though that should probably be
// a proper XPCOM service and wouldn't need to be initialized in that case.

function GM_BrowserUI() {};

GM_BrowserUI.init = function () {
  window.addEventListener("load", GM_BrowserUI.chromeLoad, false);
  window.addEventListener("unload", GM_BrowserUI.chromeUnload, false);
  window.messageManager.addMessageListener("greasemonkey:DOMContentLoaded",
      function (aMessage) {
        let contentType = aMessage.data.contentType;
        let href = aMessage.data.href;
        GM_BrowserUI.checkDisabledScriptNavigation(contentType, href);
      });
  /*
  window.messageManager.addMessageListener("greasemonkey:is-window-visible",
      function (aMessage) {
        let browser = aMessage.target;
        let contentWin = browser.ownerDocument.defaultView;

        let winUtils = contentWin
            .QueryInterface(Components.interfaces.nsIInterfaceRequestor)
            .getInterface(Components.interfaces.nsIDOMWindowUtils);

        // Always is true. (sendSyncMessage)
        if (winUtils && winUtils.isParentWindowMainWidgetVisible) {
          return true;
        } else {
          return false;
        }
      });
  */
  // The greasemonkey:open-in-tab / :tab-close / :window mm listeners
  // that used to live here were retired in Phase 4f-2.  Their senders
  // (modules/GM_openInTab.js + modules/miscApis.js GM_window) now call
  // GM_BrowserUI.openInTab / .tabClose / .window directly via
  // getChromeWinForContentWin, so the listeners had no remaining
  // senders and were unreachable code.  The handler functions
  // themselves remain on GM_BrowserUI as plain methods.
};

/**
 * The browser XUL has loaded. Find the elements we need
 * and set up our listeners and wrapper objects.
 */
GM_BrowserUI.chromeLoad = function (aEvent) {
  GM_BrowserUI.bundle = GM_CONSTANTS.localeStringBundle.createBundle(
      GM_CONSTANTS.localeGmBrowserProperties);

  // Update visual status when enabled state changes.
  GM_prefRoot.watch("enabled", GM_BrowserUI.refreshStatus);
  GM_BrowserUI.refreshStatus();

  document.getElementById("contentAreaContextMenu")
      .addEventListener("popupshowing", GM_BrowserUI.contextMenuShowing, false);

  GM_BrowserUI.gmSvc = GM_util.getService();
  // Reference this once, so that the getter is called at least once,
  // and the initialization routines will run, no matter what.
  GM_BrowserUI.gmSvc.config;

  // Initialize the chrome side handling of menu commands.
  GM_MenuCommander.initialize();

  GM_BrowserUI.showToolbarButton();

  // Make sure this is imported at least once, so its internal timer starts.
  // Cu.import("...stats.js");
};

/**
 * Opens the specified URL in a new tab.
 */
GM_BrowserUI.openTab = function (aUrl) {
  gBrowser.selectedTab = gBrowser.addTab(aUrl);
};

/**
 * Handles tab opening for a GM_openInTab API call.
 */
GM_BrowserUI.openInTab = function (aMessage) {
  var browser = aMessage.target;
  var tabBrowser = browser.getTabBrowser();
  var scriptTab = tabBrowser.getTabForBrowser(browser);
  var scriptTabIsCurrentTab = scriptTab == tabBrowser.mCurrentTab;
  // Work around a race condition in Firefox code
  // with Electrolysis (e10s) disabled.
  // See #2107 and #2234.
  // http://bugzil.la/1200334
  GM_util.timeout(function () {
    let getBool = Services.prefs.getBoolPref;

    let prefBg = (aMessage.data.inBackground === null)
        ? getBool("browser.tabs.loadInBackground")
        : aMessage.data.inBackground;
    let prefRel = (aMessage.data.afterCurrent === null)
        ? getBool("browser.tabs.insertRelatedAfterCurrent")
        : aMessage.data.afterCurrent;

    let newTab = tabBrowser.addTab(
        aMessage.data.url,
        {
          "ownerTab": prefBg ? null : tabBrowser.selectedTab,
          "relatedToCurrent": scriptTabIsCurrentTab,
        });

    if (scriptTabIsCurrentTab && !prefBg) {
      tabBrowser.selectedTab = newTab;
    }

    if (prefRel) {
      tabBrowser.moveTabTo(newTab, scriptTab._tPos + 1);
    } else {
      tabBrowser.moveTabTo(newTab, tabBrowser.tabs.length - 1);
    }

    // Track the tab for .close() and .onclose support.
    let tabId = aMessage.data.tabId;
    if (tabId) {
      if (!GM_BrowserUI._openedTabs) {
        GM_BrowserUI._openedTabs = {};
      }
      GM_BrowserUI._openedTabs[tabId] = newTab;

      // Listen for tab close to notify the content process.
      let container = tabBrowser.tabContainer;
      function onTabClose(aEvent) {
        if (aEvent.target == newTab) {
          container.removeEventListener("TabClose", onTabClose, false);
          delete GM_BrowserUI._openedTabs[tabId];
          browser.messageManager.sendAsyncMessage(
              "greasemonkey:tab-closed", {"tabId": tabId});
        }
      }
      container.addEventListener("TabClose", onTabClose, false);
    }
  }, 0);
};

/**
 * Handles programmatic tab close for GM_openInTab .close() calls.
 */
GM_BrowserUI.tabClose = function (aMessage) {
  let tabId = aMessage.data.tabId;
  if (GM_BrowserUI._openedTabs && GM_BrowserUI._openedTabs[tabId]) {
    let tab = GM_BrowserUI._openedTabs[tabId];
    let tabBrowser = aMessage.target.getTabBrowser();
    tabBrowser.removeTab(tab);
    // The TabClose event listener will handle cleanup and notification.
  }
};

/**
 * Handles tab close/focus for a GM_windowClose/GM_windowFocus API call.
 */
GM_BrowserUI.window = function (aMessage) {
  var browser = aMessage.target;
  var tabBrowser = browser.getTabBrowser();
  var scriptTab = tabBrowser.getTabForBrowser(browser);
  var what = aMessage.data.what;
  var fileURL = aMessage.data.fileURL;
  // Work around a race condition in Firefox code
  // with Electrolysis (e10s) disabled.
  // See #2107 and #2234.
  // http://bugzil.la/1200334
  // GM_util.timeout(function () {
    switch (what) {
      case "close":
        try {
          tabBrowser.removeTab(scriptTab);
        } catch (e) {
          GM_util.logError(
              "GM_windowClose():" + "\n" + e,
              false, fileURL, null);
        }
        break;
      case "focus":
        try {
          tabBrowser.selectedTab = scriptTab;
        } catch (e) {
          GM_util.logError(
              "GM_windowFocus():" + "\n" + e,
              false, fileURL, null);
        }
        break;
    }
  // }, 0);
};

/**
 * The browser XUL has unloaded. Destroy references/watchers/listeners.
 */
GM_BrowserUI.chromeUnload = function () {
  GM_prefRoot.unwatch("enabled", GM_BrowserUI.refreshStatus);
  GM_MenuCommander.uninitialize();
};

/**
 * Called when the content area context menu is showing. We figure out whether
 * to show our context items.
 */
GM_BrowserUI.contextMenuShowing = function () {
  GM_BrowserUI.getUserScriptUrlUnderPointer(function (aUrl) {
    var contextItem = document.getElementById("greasemonkey-view-userscript");
    var contextSep = document.getElementById("greasemonkey-install-sep");
    contextItem.hidden = contextSep.hidden = !aUrl;
    // See #1914.
    if (contextSep.nextElementSibling) {
      var contextSepNES = contextSep.nextElementSibling;
      while (contextSepNES) {
        let contextSepNESStyleDisplay = contextSepNES.ownerDocument.defaultView
            .getComputedStyle(contextSepNES, null).getPropertyValue("display");
        if ((contextSepNESStyleDisplay.toLowerCase() != "none")
            && !contextSepNES.hidden) {
          if (contextSepNES.tagName.toLowerCase() == "menuseparator") {
            contextSep.hidden = true;
          }
          break;
        }
        contextSepNES = contextSepNES.nextElementSibling;
      }
    }
  });
};

GM_BrowserUI.getUserScriptUrlUnderPointer = function (aCallback) {
  let culprit = gContextMenu.target || document.popupNode;
  if (!culprit) {
    aCallback(null);
    return undefined;
  }

  var mm = gBrowser.selectedBrowser.messageManager;
  var messageHandler;
  messageHandler = function (aMessage) {
    mm.removeMessageListener("greasemonkey:context-menu-end", messageHandler);

    let href = aMessage.data.href;
    if (href && FILE_SCRIPT_EXTENSION_2_REGEXP.test(href)) {
      aCallback(href);
    } else {
      aCallback(null);
    }
  };
  mm.addMessageListener("greasemonkey:context-menu-end", messageHandler);

  mm.sendAsyncMessage(
      "greasemonkey:context-menu-start", {}, {
        "culprit": culprit,
      });
};

GM_BrowserUI.refreshStatus = function () {
  let enabledElm = document.getElementById("gm_toggle_enabled");
  let checkedElm = document.getElementById("gm_toggle_checked");

  if (GM_util.getEnabled()) {
    checkedElm.setAttribute("checked", true);
    enabledElm.removeAttribute("disabled");
  } else {
    checkedElm.setAttribute("checked", false);
    enabledElm.setAttribute("disabled", "yes");
  }
};

// See #1507.
// Not used directly, kept for GreaseFire.
GM_BrowserUI.startInstallScript = function (aUri) {
  GM_util.showInstallDialog(aUri.spec, gBrowser);
};

GM_BrowserUI.viewContextItemClicked = function () {
  GM_BrowserUI.getUserScriptUrlUnderPointer(function (aUrl) {
    if (!aUrl) {
      return undefined;
    }

    let scope = {};
    Cu.import("chrome://greasemonkey-modules/content/remoteScript.js", scope);
    var rs = new scope.RemoteScript(aUrl);
    rs.downloadScript(function (aSuccess) {
      if (aSuccess) {
        rs.showSource(gBrowser);
      } else {
        alert(rs.errorMessage);
      }
    });
  });
};

GM_BrowserUI.showToolbarButton = function () {
  // See #1652.
  // During transition, this might be set, but not readable yet;
  // transition happens in an async callback to get addon version.
  // If existing version is "0.0" (the default), this hasn't happened yet,
  // so try later.
  if (GM_prefRoot.getValue("version") == GM_CONSTANTS.addonVersionFirst) {
    setTimeout(GM_BrowserUI.showToolbarButton, 50);
    return undefined;
  }

  // Once, enforce that the toolbar button is present.
  // For discoverability.
  if (!GM_prefRoot.getValue("haveInsertedToolbarbutton")) {
    GM_prefRoot.setValue("haveInsertedToolbarbutton", true);

    let navbar = document.getElementById("nav-bar");
    let newset = navbar.currentSet + ",greasemonkey-tbb";
    navbar.currentSet = newset;
    navbar.setAttribute("currentset", newset);
    document.persist("nav-bar", "currentset");
  }
};

GM_BrowserUI.openOptions = function () {
  openDialog(
      "chrome://greasemonkey/content/options.xul", null, "modal,resizable");
};

GM_BrowserUI.checkDisabledScriptNavigation = function (aContentType, aHref) {
  if (GM_util.getEnabled()) {
    return undefined;
  }
  if (!FILE_SCRIPT_EXTENSION_1_REGEXP.test(aHref)) {
    return undefined;
  }
  if (FILE_SCRIPT_CONTENT_TYPE_NO_REGEXP.test(aContentType)) {
    return undefined;
  }

  let buttons = [];
  buttons.push({
    "accessKey": GM_BrowserUI.bundle
        .GetStringFromName("disabledWarning.enable.accesskey"),
    "callback": function () {
      GM_util.setEnabled(true);
    },
    "label": GM_BrowserUI.bundle.GetStringFromName("disabledWarning.enable"),
    "popup": null,
  });
  buttons.push({
    "callback": function () {
      GM_util.setEnabled(true);
      GM_util.showInstallDialog(aHref, gBrowser);
    },
    "accessKey": GM_BrowserUI.bundle
        .GetStringFromName("disabledWarning.enableAndInstall.accesskey"),
    "label": GM_BrowserUI.bundle
        .GetStringFromName("disabledWarning.enableAndInstall"),
    "popup": null,
  });
  buttons.push({
    "accessKey": GM_BrowserUI.bundle
        .GetStringFromName("disabledWarning.install.accesskey"),
    "callback": function () {
      GM_util.showInstallDialog(aHref, gBrowser);
    },
    "label": GM_BrowserUI.bundle.GetStringFromName("disabledWarning.install"),
    "popup": null,
  });

  let notificationBox = gBrowser.getNotificationBox();
  let notification = notificationBox.appendNotification(
      GM_BrowserUI.bundle.GetStringFromName("greeting.msg"),
      "greasemonkey-install-userscript",
      "chrome://greasemonkey/skin/icon16.png",
      notificationBox.PRIORITY_WARNING_MEDIUM,
      buttons
    );
  notification.persistence = -1;
};

GM_BrowserUI.scriptPrefs = function (aScript) {
  window.openDialog(
      GM_CONSTANTS.scriptPrefsUrl + "#" + encodeURIComponent(aScript.id),
      null, "modal,resizable");
};

GM_BrowserUI.init();

/**
 * Handle clicking one of the items in the popup.
 */
function GM_popupClicked(aEvent) {
  let script = aEvent.target.script;
  if (!script) {
    return undefined;
  }

  if (aEvent.type == "command") {
    // Left-click.
    // Toggle enabled state.
    script.enabled =! script.enabled;
  } else if (aEvent.type == "click") {
    // Middle-click, Right-click.
    let _buttons = {
      "middle": 1,
      "left": 0,
      "right": 2,
    };
    let button = aEvent.button;
    let modifier = aEvent.ctrlKey || aEvent.metaKey;
    let shift = aEvent.shiftKey;
    if ((button == _buttons.right) && !modifier && !shift) {
      // Open in editor.
      GM_util.openInEditor(script);
    } else {
      if ((button == _buttons.middle)
          || ((button == _buttons.right) && modifier)) {
        // Open the script's folder.  Pre-cleanup, this round-tripped
        // through Services.cpmm.sendAsyncMessage("greasemonkey:script-
        // open-folder", { scriptId }).  UXP is single-process, so we
        // call the service directly.  Argument shape preserves the
        // method signature shared with the legacy ppmm message handler.
        GM_util.getService().scriptOpenFolder({
          "data": { "scriptId": script.id },
        });
      } else {
        if ((button == _buttons.right) && shift) {
          // Open preferences.
          GM_BrowserUI.scriptPrefs(script);
        }
      }
    }
  }

  closeMenus(aEvent.target);
}

/**
 * When a menu pops up, fill its contents with the list of scripts.
 */
function GM_showPopup(aEvent) {
  // Make sure this event was triggered by opening the actual monkey menu,
  // not one of its submenus.
  if (aEvent.currentTarget != aEvent.target) {
    return undefined;
  }

  // See #2276.
  var aEventTarget = aEvent.target;

  // See below.
  /*
  var mm = aEventTarget.ownerDocument.defaultView
      .gBrowser.mCurrentBrowser.frameLoader.messageManager;
  */
  var mm = getBrowser().mCurrentBrowser.frameLoader.messageManager;

  var callback = null;
  callback = function (aMessage) {
    mm.removeMessageListener("greasemonkey:frame-urls", callback);

    let urls = aMessage.data.urls;
    asyncShowPopup(aEventTarget, urls);
  };

  mm.addMessageListener("greasemonkey:frame-urls", callback);
  mm.sendAsyncMessage("greasemonkey:frame-urls", {});
}

function getScripts() {
  function uniq(a) {
    let seen = {}, list = [], item;
    for (let i = 0, iLen = a.length; i < iLen; i++) {
      item = a[i];
      if (!seen.hasOwnProperty(item)) {
        seen[item] = list.push(item);
      }
    }
    return list;
  }
  getScripts.uniq = uniq;

  function scriptsMatching(aUrls) {
    function testMatchURLs(aScript) {
      function testMatchURL(aUrl) {
        return aScript.matchesURL(aUrl);
      }
      return aUrls.some(testMatchURL);
    }
    return GM_util.getService().config.getMatchingScripts(testMatchURLs);
  }
  getScripts.scriptsMatching = scriptsMatching;

  function appendScriptAfter(aScript, aPoint, aNoInsert) {
    if (aScript.needsUninstall) {
      return undefined;
    }
    let mi = document.createElement("menuitem");
    mi.setAttribute("label", aScript.localized.name);
    if (aScript.noframes) {
      mi.setAttribute("tooltiptext", "noframes");
    }
    mi.script = aScript;
    mi.setAttribute("type", "checkbox");
    mi.setAttribute("checked", aScript.enabled.toString());
    if (!aNoInsert) {
      aPoint.parentNode.insertBefore(mi, aPoint.nextSibling);
    }
    return {
      "menuItem": mi,
      "noframes": aScript.noframes,
    };
  }
  getScripts.appendScriptAfter = appendScriptAfter;
}
getScripts();

function asyncShowPopup(aEventTarget, aUrls) {
  let popup = aEventTarget;
  let scriptsFramedElm = popup
      .getElementsByClassName("scripts-framed-point")[0];
  let scriptsTopElm = popup.getElementsByClassName("scripts-top-point")[0];
  let scriptsSepElm = popup.getElementsByClassName("scripts-sep")[0];
  let noScriptsElm = popup.getElementsByClassName("no-scripts")[0];

  // Remove existing menu items, between separators.
  function removeMenuitemsAfter(aEl) {
    while (true) {
      let sibling = aEl.nextSibling;
      if (!sibling || (sibling.tagName == "menuseparator")) {
        break;
      }
      sibling.parentNode.removeChild(sibling);
    }
  }
  removeMenuitemsAfter(scriptsFramedElm);
  removeMenuitemsAfter(scriptsTopElm);

  aUrls = getScripts.uniq(aUrls);
  // First url = top window.
  var runsOnTop = getScripts.scriptsMatching([aUrls.shift()]);
  // Remainder are all its subframes.
  var runsFramed = getScripts.scriptsMatching(aUrls);

  // Drop all runsFramed scripts already present in runsOnTop.
  for (let i = 0, iLen = runsOnTop.length; i < iLen; i++) {
    var j = 0, item = runsOnTop[i];
    while (j < runsFramed.length) {
      if (item === runsFramed[j]) {
        runsFramed.splice(j, 1);
      } else {
        j++;
      }
    }
  }

  scriptsSepElm.collapsed = !(runsOnTop.length && runsFramed.length);
  noScriptsElm.collapsed = !!(runsOnTop.length || runsFramed.length);

  let point;
  if (runsFramed.length) {
    point = scriptsFramedElm;
    runsFramed.forEach(
        function (aScript) {
          point = getScripts.appendScriptAfter(aScript, point).menuItem;
        });
  }
  point = scriptsTopElm;
  runsOnTop.forEach(
      function (aScript) {
        point = getScripts.appendScriptAfter(aScript, point).menuItem;
      });

  // Propagate to commands sub-menu.
  GM_MenuCommander.onPopupShowing(aEventTarget);
}

/**
 * Clean up the menu after it hides to prevent memory leaks
 */
function GM_hidePopup(aEvent) {
  // Only handle the actual monkey menu event.
  if (aEvent.currentTarget != aEvent.target) {
    return undefined;
  }
  // Propagate to commands sub-menu.
  GM_MenuCommander.onPopupHiding();
}

// Short-term workaround for #1406: Tab Mix Plus breaks opening links
// in new tabs because it depends on this function,
// and incorrectly checks for existance of GM_BrowserUI instead of it.
function GM_getEnabled() {
  return GM_util.getEnabled();
}

function GM_showTooltip(aEvent) {
  function setTooltip(aUrls) {
    let urls = getScripts.uniq(aUrls);
    // First url = top window.
    let runsOnTop = getScripts.scriptsMatching([urls.shift()]);
    // Remainder are all its subframes.
    let runsFramed = getScripts.scriptsMatching(urls);

    let versionElm = aEvent.target
        .getElementsByClassName("greasemonkey-tooltip-version")[0];
    versionElm.setAttribute("value",
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmBrowserProperties)
            .GetStringFromName("tooltip.greasemonkeyVersion")
            .replace("%1", gGreasemonkeyVersion)
    );

    let enabled = GM_util.getEnabled();
    let enabledElm = aEvent.target
        .getElementsByClassName("greasemonkey-tooltip-enabled")[0];
    enabledElm.setAttribute("value", enabled
        ? GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("tooltip.enabled")
        : GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("tooltip.disabled")
    );

    if (enabled) {
      aEvent.target.classList.add("greasemonkey-tooltip-isActive");

      var total = 0;
      var totalEnable = 0;
      GM_util.getService().config.scripts.forEach(function (aScript) {
        total++;
        totalEnable = totalEnable + (aScript.enabled ? 1 : 0);
      });

      total = totalEnable + "/" + total;
      let totalElm = aEvent.target
          .getElementsByClassName("greasemonkey-tooltip-total")[0];
      totalElm.setAttribute("value",
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("tooltip.total")
              .replace("%1", total)
      );

      var runsOnTopEnable = 0;
      var runsFramedEnable = 0;
      var runsFramedNoframesDisable = 0;

      var _runsFramed;
      var _runsFramedEnable;
      var point;
      if (runsFramed.length) {
        runsFramed.forEach(
            function (aScript) {
              _runsFramed = getScripts.appendScriptAfter(aScript, point, true);
              _runsFramedEnable = ((_runsFramed.menuItem
                  .getAttribute("checked") == "true") ? 1 : 0);
              runsFramedEnable = runsFramedEnable + _runsFramedEnable;
              if (_runsFramedEnable) {
                runsFramedNoframesDisable = runsFramedNoframesDisable
                    + ((!_runsFramed.noframes) ? 1 : 0);
              }
        });
      }
      runsOnTop.forEach(
          function (aScript) {
            runsOnTopEnable = runsOnTopEnable + ((getScripts
                .appendScriptAfter(aScript, point, true)
                .menuItem.getAttribute("checked") == "true") ? 1 : 0);
      });

      let activeFrames = runsFramedNoframesDisable + "/"
          + runsFramedEnable + "/" + runsFramed.length;
      let activeFramesElm = aEvent.target
          .getElementsByClassName("greasemonkey-tooltip-active")[1];
      activeFramesElm.setAttribute("value",
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("tooltip.activeFrames")
              .replace("%1", activeFrames)
      );
      let activeTop = runsOnTopEnable + "/" + runsOnTop.length;
      let activeTopElm = aEvent.target
          .getElementsByClassName("greasemonkey-tooltip-active")[0];
      activeTopElm.setAttribute("value",
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName("tooltip.activeTop")
              .replace("%1", activeTop)
      );
    } else {
      aEvent.target.classList.remove("greasemonkey-tooltip-isActive");
    }
  }

  // See above.
  /*
  var mm = getBrowser().mCurrentBrowser.frameLoader.messageManager;
  */
  var mm = aEvent.target.ownerDocument.defaultView
      .gBrowser.mCurrentBrowser.frameLoader.messageManager;

  var callback = null;
  callback = function (aMessage) {
    mm.removeMessageListener("greasemonkey:frame-urls", callback);

    let urls = aMessage.data.urls;
    setTooltip(urls);
  };

  mm.addMessageListener("greasemonkey:frame-urls", callback);
  mm.sendAsyncMessage("greasemonkey:frame-urls", {});
}
