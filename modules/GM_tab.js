/**
 * @file GM_tab.js
 * @overview Native GM_getTab / GM_saveTab / GM_getTabs: a small per-tab,
 * per-script value store (Tampermonkey / ScriptCat compatible).
 *
 * The data lives only in memory for the browser session, keyed by
 * (script, tab).  "Tab" is the top-level outer window id, so every frame
 * of a tab shares one store and a same-tab navigation / reload keeps it
 * (the outer window survives).  Values are stored as JSON strings, so the
 * chrome side never retains a live reference into a script sandbox.
 *
 * NOTE: entries for closed tabs are not pruned (no tab-close hook yet), so
 * GM_getTabs can include stale tab ids.  The data is small, script-owned,
 * and session-scoped; pruning can be added later via a window-close
 * observer.
 */

const EXPORTED_SYMBOLS = ["createGMTabAPI"];

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
Cu.import("chrome://greasemonkey-modules/content/util.js");


// scriptKey (uuid) -> Map(tabId -> JSON string).
var gTabData = new Map();

/**
 * Returns (creating if needed) the per-tab map for a script.
 *
 * @param {string} aScriptKey
 * @returns {Map}
 */
function storeForScript(aScriptKey) {
  let m = gTabData.get(aScriptKey);
  if (!m) {
    m = new Map();
    gTabData.set(aScriptKey, m);
  }
  return m;
}

/**
 * Builds the GM_getTab / GM_saveTab / GM_getTabs functions for one sandbox.
 *
 * @param {Window}  aWrappedContentWin - X-ray wrapped content window.
 * @param {Sandbox} aSandbox    - Script's sandbox; results are cloned in.
 * @param {string}  aFileURL    - Script file URL (for error attribution).
 * @param {string}  aScriptKey  - Stable per-script key (the script uuid).
 * @param {*}       aTabId      - Top outer-window id identifying the tab.
 * @returns {{getTab: function, saveTab: function, getTabs: function}}
 */
function createGMTabAPI(
    aWrappedContentWin, aSandbox, aFileURL, aScriptKey, aTabId) {
  function safeCall(aCallback, aResult) {
    if (typeof aCallback !== "function") {
      return undefined;
    }
    try {
      aCallback(aResult);
    } catch (e) {
      GM_util.logError(e, false, aFileURL, e.lineNumber || 0);
    }
    return undefined;
  }

  // Serialize a script-supplied value to a JSON string without keeping a
  // live sandbox reference.  Plain data survives the chrome X-ray view; a
  // waived retry covers any enumeration quirk; "{}" is the last resort.
  function serialize(aValue) {
    try {
      let s = JSON.stringify(aValue);
      return (typeof s === "undefined") ? "{}" : s;
    } catch (e) {
      try {
        let s = JSON.stringify(Cu.waiveXrays(aValue));
        return (typeof s === "undefined") ? "{}" : s;
      } catch (e2) {
        return "{}";
      }
    }
  }

  function parseToSandbox(aJson) {
    let obj = {};
    if (aJson) {
      try {
        obj = JSON.parse(aJson);
      } catch (e) {
        obj = {};
      }
    }
    return Cu.cloneInto(obj, aSandbox);
  }

  function getTabImpl(aCallback) {
    let result = parseToSandbox(storeForScript(aScriptKey).get(aTabId));
    safeCall(aCallback, result);
    return result;
  }

  function saveTabImpl(aValue, aCallback) {
    storeForScript(aScriptKey).set(aTabId, serialize(aValue));
    safeCall(aCallback, true);
    return true;
  }

  function getTabsImpl(aCallback) {
    let out = {};
    storeForScript(aScriptKey).forEach(function (aJson, aOtherTabId) {
      try {
        out[aOtherTabId] = JSON.parse(aJson);
      } catch (e) {
        out[aOtherTabId] = {};
      }
    });
    let result = Cu.cloneInto(out, aSandbox);
    safeCall(aCallback, result);
    return result;
  }

  return {
    "getTab": getTabImpl,
    "saveTab": saveTabImpl,
    "getTabs": getTabsImpl,
  };
}
