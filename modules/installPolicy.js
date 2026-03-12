/**
 * @file installPolicy.js
 * @overview nsIContentPolicy implementation that intercepts local file://
 *   navigations to .user.js files and redirects them into the Greasemonkey
 *   script install flow.
 *
 * This module handles the case that requestObserver.js cannot: when the user
 * opens a local .user.js file directly (e.g. by double-clicking it or typing
 * a file:// URL), there is no HTTP channel — so the http-on-modify-request
 * observer never fires.  This content policy fills that gap.
 *
 * Flow:
 *   1. shouldLoad() is called by the browser for every load attempt.
 *   2. Non-file://, non-document, and non-.user.js requests are accepted
 *      (passed through) immediately.
 *   3. Temporary files (e.g. from "View Script Source") are also accepted.
 *   4. Otherwise an async "greasemonkey:script-install" IPC message is sent
 *      to the parent process and REJECT is returned to cancel the navigation.
 *
 * The InstallPolicy factory is registered with the XPCOM component manager
 * and the "content-policy" category once at module load time.  A guard flag
 * (gHaveDoneInit) prevents double-registration when the module is imported
 * in multiple processes.
 */

// This module is responsible for detecting user scripts
// that are loaded by some means OTHER than HTTP
// (which the http-on-modify-request observer handles), i.e. local files.
const EXPORTED_SYMBOLS = [];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}
if (typeof Cr === "undefined") {
  var Cr = Components.results;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


const ACCEPT = Ci.nsIContentPolicy.ACCEPT;
const REJECT = Ci.nsIContentPolicy.REJECT_REQUEST;

const FILE_SCRIPT_EXTENSION_REGEXP = new RegExp(
    GM_CONSTANTS.fileScriptExtensionRegexp + "$", ""); 

var gHaveDoneInit = false;

////////////////////////////////////////////////////////////////////////////////

/**
 * XPCOM component that implements nsIContentPolicy and nsIFactory.
 * Registered under the "content-policy" category so the browser calls
 * shouldLoad() for every resource load.
 */
var InstallPolicy = {
  "_classDescription": GM_CONSTANTS.addonInstallPolicyClassDescription,
  "_classID": GM_CONSTANTS.addonInstallPolicyClassID,
  "_contractID": GM_CONSTANTS.addonInstallPolicyContractID,

  /**
   * Registers this object as an XPCOM factory and content-policy component.
   * Safe to call multiple times — NS_ERROR_FACTORY_EXISTS is silently ignored.
   */
  "init": function () {
    try {
      let registrar = Components.manager.QueryInterface(
          Ci.nsIComponentRegistrar);
      registrar.registerFactory(
          this._classID, this._classDescription, this._contractID, this);
    } catch (e) {
      if (e.name == "NS_ERROR_FACTORY_EXISTS") {
        // No-op, ignore these.
        // But why do they happen?!
      } else {
        GM_util.logError(
            GM_CONSTANTS.info.scriptHandler + " - "
            + "Install Policy factory - Error registering:"
            + "\n" + e, false,
            e.fileName, e.lineNumber);
      }
      return undefined;
    }

    let catMan = Cc["@mozilla.org/categorymanager;1"]
        .getService(Ci.nsICategoryManager);
    catMan.addCategoryEntry(
        "content-policy", this._contractID, this._contractID, false, true);
  },

  "QueryInterface": XPCOMUtils.generateQI([
    Ci.nsIContentPolicy,
    Ci.nsIFactory,
    Ci.nsISupportsWeakReference
  ]),

/////////////////////////////// nsIContentPolicy ///////////////////////////////

  /**
   * Decides whether a resource load should be allowed or blocked.
   * Blocks (REJECT) only file:// top-level navigations to .user.js files
   * that are not Greasemonkey's own temporary files.
   *
   * @param {number}     aContentType - nsIContentPolicy TYPE_* constant.
   * @param {nsIURI}     aContentURI  - The URI being loaded.
   * @param {nsIURI}     aOriginURI   - The URI of the loading document.
   * @param {nsISupports} aContext    - The DOM node or window requesting the load.
   * @returns {number} ACCEPT or REJECT (nsIContentPolicy constants).
   */
  "shouldLoad": function (aContentType, aContentURI, aOriginURI, aContext) {
    // Ignore everything that isn't a file:// .
    if (aContentURI.scheme != "file") {
      return ACCEPT;
    }
    // Ignore everything that isn't a top-level document navigation.
    if (aContentType != Ci.nsIContentPolicy.TYPE_DOCUMENT) {
      return ACCEPT;
    }
    // Ignore everything when GM is not enabled.
    if (!GM_util.getEnabled()) {
      return ACCEPT;
    }
    // Ignore everything that isn't a user script.
    if (!FILE_SCRIPT_EXTENSION_REGEXP.test(aContentURI.spec)) {
      return ACCEPT;
    }
    // Ignore temporary files, e.g. "Show script source".
    let tmpResult = Services.cpmm.sendSyncMessage(
        "greasemonkey:url-is-temp-file", {
          "url": aContentURI.spec,
        });
    if (tmpResult.length && tmpResult[0]) {
      return ACCEPT;
    }

    Services.cpmm.sendAsyncMessage(
        "greasemonkey:script-install", {
          "url": aContentURI.spec,
        });

    return REJECT;
  },

  /**
   * Always accepts — Greasemonkey does not need to inspect processed requests.
   * @returns {number} ACCEPT
   */
  "shouldProcess": function () {
    return ACCEPT;
  },

////////////////////////////////// nsIFactory //////////////////////////////////

  /**
   * nsIFactory.createInstance — returns this singleton as the sole instance.
   * @param {nsISupports} aOuter - Must be null (no aggregation supported).
   * @param {nsIIDRef}    aIid   - Requested interface.
   * @throws {NS_ERROR_NO_AGGREGATION} If aOuter is non-null.
   */
  "createInstance": function (aOuter, aIid) {
    if (aOuter) {
      throw Cr.NS_ERROR_NO_AGGREGATION;
    }
    return this.QueryInterface(aIid);
  },
};

////////////////////////////////////////////////////////////////////////////////

if (!gHaveDoneInit) {
  gHaveDoneInit = true;
  InstallPolicy.init();
}
