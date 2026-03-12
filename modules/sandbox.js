/**
 * @file sandbox.js
 * @overview Creates the isolated JavaScript sandbox in which userscripts
 *   execute, and injects the GM_* / GM.* APIs into it.
 *
 * Two functions are exported:
 *
 *   createSandbox(aFrameScope, aContentWin, aUrl, aScript, aRunAt)
 *     Constructs a Cu.Sandbox for the given script, then injects whichever
 *     GM_* functions the script's @grant list requests.  Returns the sandbox.
 *
 *   runScriptInSandbox(aSandbox, aScript)
 *     Builds the GM.* Promise-wrapper polyfill (evalAPI2Polyfill), loads all
 *     @require files in order, then loads the script itself.
 *
 * ── Sandbox modes ──────────────────────────────────────────────────────────
 *
 *   @grant none   (or no @grant at all)
 *     A plain sandbox with sandboxPrototype = contentWin and wantXrays=false.
 *     The script runs almost as if it were a page script.
 *     Only GM_info and a compatibility unsafeWindow alias are injected.
 *
 *   @grant <anything else>
 *     A full Xray sandbox.  Only the explicitly listed GM_* functions are
 *     injected; everything else is absent.
 *
 * ── API injection pattern ──────────────────────────────────────────────────
 *
 *   For each API (e.g. GM_getValue):
 *     _API1 = "GM_getValue"
 *     _API2 = "GM.getValue"   (derived via API_PREFIX_REGEXP)
 *     If either is in script.grants → inject under the GM3 name (GM_getValue).
 *     The GM4 GM.getValue wrapper is added later by evalAPI2Polyfill().
 *
 * ── GM.* Promise polyfill (evalAPI2Polyfill) ───────────────────────────────
 *
 *   Called from runScriptInSandbox() when the "api.object.polyfill" pref is
 *   set (default: true).  Constructs and evals a code snippet that:
 *     1. Creates a `var GM = {}` object in the sandbox.
 *     2. For each entry in GM_CONSTANTS.addonAPI, wraps the corresponding
 *        GM_* sandbox function in a Promise-returning arrow function and
 *        assigns it to GM.<name>.
 *     3. Copies GM_info directly (it is not a function — no Promise needed).
 *     4. Object.freeze(GM) to prevent script tampering.
 *
 * ── GM_info injection (injectGMInfo) ──────────────────────────────────────
 *
 *   GM_info is always injected regardless of @grant.
 *   Uses Reflect.set({}, key, value, sandbox) instead of sandbox[key] = value
 *   to bypass any setter that a malicious page might have placed on the
 *   content window (which is in the sandbox's prototype chain).
 *
 *   Two heavyweight string properties (scriptSource, scriptMetaStr) are
 *   exposed as lazy getters so they are only read from disk when accessed.
 *
 * ── GM_download ─────────────────────────────────────────────────────────────
 *
 *   GM_download is implemented as a loadSubScript polyfill
 *   (modules/thirdParty/GM_download.js).  If @grant GM_download is present
 *   but @grant GM_xmlhttpRequest is not, GM_xmlhttpRequest is auto-injected
 *   first because the polyfill depends on it.
 */

const EXPORTED_SYMBOLS = ["createSandbox", "runScriptInSandbox"];

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

Cu.import("chrome://greasemonkey-modules/content/extractMeta.js");
Cu.import("chrome://greasemonkey-modules/content/GM_openInTab.js");
Cu.import("chrome://greasemonkey-modules/content/GM_setClipboard.js");
Cu.import("chrome://greasemonkey-modules/content/menuCommand.js");
Cu.import("chrome://greasemonkey-modules/content/miscApis.js");
Cu.import("chrome://greasemonkey-modules/content/notificationer.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/storageFront.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/GM_cookie.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("chrome://greasemonkey-modules/content/xmlHttpRequester.js");


// https://hg.mozilla.org/releases/mozilla-esr52/file/324cc1bccf3d/js/src/jsapi.cpp#l582
// Only a particular set of strings are allowed.
// const JAVASCRIPT_VERSION_MAX = "ECMAv5";
// http://bugzil.la/880917
/** JavaScript version string passed to Cu.evalInSandbox and jsSubScriptLoader. */
const JAVASCRIPT_VERSION_MAX = "latest";

/**
 * RegExp that matches a GM3-style API name and captures the suffix.
 * e.g. "GM_getValue" → ["GM_getValue", "GM_", "getValue"]
 * Used to derive the GM4 property name: "getValue".
 */
const API_PREFIX_REGEXP = new RegExp(
    "(^" + GM_CONSTANTS.addonAPIPrefix1 + ")(.+)", "");

/**
 * Creates and returns the JavaScript sandbox for a userscript.
 *
 * @param {nsIMessageSender} aFrameScope  - Frame message manager, passed to
 *   APIs that need to send IPC messages (storage, openInTab, etc.).
 * @param {Window}           aContentWin  - The content window the script runs
 *   in; used as the sandbox prototype and principal.
 * @param {string}           aUrl         - URL of the page being loaded;
 *   passed to APIs that need the page origin (xmlhttpRequest, cookie, etc.).
 * @param {IPCScript}        aScript      - The script descriptor object.
 * @param {string}           aRunAt       - The run-at phase ("document-start",
 *   "document-end", or "document-idle"); passed to GM_addStyle.
 * @returns {Cu.Sandbox} The populated sandbox ready for script execution.
 */
function createSandbox(aFrameScope, aContentWin, aUrl, aScript, aRunAt) {
  let _API1 = "";
  let _API2 = "";
  let unsafeWindowDefault = "const unsafeWindow = window;";

  if (GM_util.inArray(aScript.grants, "none")) {
    // If there is an explicit none grant, use a plain unwrapped sandbox
    // with no other content.
    var contentSandbox = new Cu.Sandbox(
        aContentWin, {
          "sameZoneAs": aContentWin,
          "sandboxName": aScript.id,
          "sandboxPrototype": aContentWin,
          "wantXrays": false,
        });

    // GM_info is always provided.
    injectGMInfo(contentSandbox, aContentWin, aScript);

    // Alias unsafeWindow for compatibility.
    Cu.evalInSandbox(unsafeWindowDefault, contentSandbox);

    return contentSandbox;
  }

  var sandbox = new Cu.Sandbox(
      [aContentWin], {
        "sameZoneAs": aContentWin,
        "sandboxName": aScript.id,
        "sandboxPrototype": aContentWin,
        "wantXrays": true,
        "wantExportHelpers": true,
      });

  // http://bugzil.la/1043958
  // Note that because waivers aren't propagated between origins,
  // we need the unsafeWindow getter to live in the sandbox.
  // See also:
  // toolkit/commonjs/sdk/content/sandbox.js
  let _unsafeWindowGrant = GM_prefRoot.getValue("api.unsafeWindow.grant");
  _API1 = "unsafeWindow";
  if (!_unsafeWindowGrant || (_unsafeWindowGrant
      && GM_util.inArray(aScript.grants, _API1))) {
    let unsafeWindowGetter = new sandbox.Function (
        "return window.wrappedJSObject || window;");
    Object.defineProperty(sandbox, _API1, {
      "get": unsafeWindowGetter,
    });
  } else {
    Cu.evalInSandbox(unsafeWindowDefault, sandbox);
  }

  _API1 = "GM_addStyle";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        null, GM_addStyle, aContentWin, aScript.fileURL, aRunAt);
  }

  if (GM_prefRoot.getValue("api.GM_cookie")) {
    _API1 = "GM_cookie";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (GM_util.inArray(aScript.grants, _API1)
        || GM_util.inArray(aScript.grants, _API2, true)) {
      sandbox[_API1] = GM_util.hitch(
          null, GM_cookie, aContentWin, sandbox,
          aScript.fileURL, aUrl);
    }
  }

  let scriptStorage = new GM_ScriptStorageFront(
      aFrameScope, aContentWin, sandbox, aScript);
  _API1 = "GM_deleteValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(scriptStorage, "deleteValue");
  }
  _API1 = "GM_getValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(scriptStorage, "getValue");
  }
  _API1 = "GM_setValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(scriptStorage, "setValue");
  }

  _API1 = "GM_listValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(scriptStorage, "listValues");
  }

  let scriptResources = new GM_Resources(aScript);
  _API1 = "GM_getResourceText";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        scriptResources, "getResourceText",
        aContentWin, sandbox, aScript.fileURL);
  }
  _API1 = "GM_getResourceURL";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        scriptResources, "getResourceURL",
        aContentWin, sandbox, aScript);
  }

  _API1 = "GM_log";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(new GM_ScriptLogger(aScript), "log");
  }

  _API1 = "GM_notification";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        new GM_notificationer(
            getChromeWinForContentWin(aContentWin), aContentWin, sandbox,
            aScript.fileURL, aScript.localized.name),
        "contentStart");
  }

  _API1 = "GM_openInTab";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(null, GM_openInTab, aFrameScope, aUrl);
  }

  _API1 = "GM_registerMenuCommand";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    Cu.evalInSandbox(
        "this._MenuCommandSandbox = " + MenuCommandSandbox.toSource(), sandbox);
    sandbox._MenuCommandSandbox(
        aFrameScope.content,
        aScript.uuid, aScript.localized.name, aScript.fileURL,
        MenuCommandRespond,
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.menu.callbackIsNotFunction"),
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.menu.couldNotRun"),
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.menu.invalidAccesskey"),
        MenuCommandEventNameSuffix);
    Cu.evalInSandbox(
        "delete this._MenuCommandSandbox;", sandbox);
  }

  _API1 = "GM_setClipboard";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        null, GM_setClipboard, aContentWin, aScript.fileURL);
  }

  // See #2538 (an alternative).
  _API1 = "GM_windowClose";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        null, GM_window, aFrameScope, aScript.fileURL, "close");
  }
  _API1 = "GM_windowFocus";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        null, GM_window, aFrameScope, aScript.fileURL, "focus");
  }

  _API1 = "GM_xmlhttpRequest";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    sandbox[_API1] = GM_util.hitch(
        new GM_xmlHttpRequester(aContentWin, sandbox, aScript.fileURL, aUrl),
        "contentStartRequest");
  }

  // See #2129.
  Object.getOwnPropertyNames(sandbox).forEach(function (aProp) {
    if (aProp.indexOf(GM_CONSTANTS.addonAPIPrefix1) == 0) {
      sandbox[aProp] = Cu.cloneInto(
          sandbox[aProp], sandbox, {
            "cloneFunctions": true,
            "wrapReflectors": true,
          });
    }
  });

  // [GM_download] — load polyfill into the sandbox when granted.
  // The polyfill uses GM_xmlhttpRequest internally; auto-inject it if the
  // script did not explicitly grant it (so @grant GM_download is sufficient).
  _API1 = "GM_download";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (GM_util.inArray(aScript.grants, _API1)
      || GM_util.inArray(aScript.grants, _API2, true)) {
    if (typeof sandbox["GM_xmlhttpRequest"] == "undefined") {
      sandbox["GM_xmlhttpRequest"] = Cu.cloneInto(
          GM_util.hitch(
              new GM_xmlHttpRequester(aContentWin, sandbox, aScript.fileURL, aUrl),
              "contentStartRequest"),
          sandbox, {
            "cloneFunctions": true,
            "wrapReflectors": true,
          });
    }
    GM_CONSTANTS.jsSubScriptLoader.loadSubScript(
        "chrome://greasemonkey-modules/content/thirdParty/GM_download.js",
        sandbox, GM_CONSTANTS.fileScriptCharset);
  }

  // GM_info is always provided.
  injectGMInfo(sandbox, aContentWin, aScript);

  return sandbox;
}

/**
 * Injects the GM_info object into the sandbox.
 * GM_info is always provided regardless of @grant list.
 *
 * Security: uses Reflect.set({}, key, value, sandbox) rather than
 * sandbox[key] = value to create an own property directly on the sandbox,
 * bypassing any inherited setter from the content window prototype chain.
 *
 * Adds two lazy string getters on the GM_info object:
 *   scriptSource  — full source text of the script file (read on demand).
 *   scriptMetaStr — the ==UserScript== metadata block text (read on demand).
 *
 * Skips injection in environments where the sandbox content level is too
 * high for safe property definition (e10s / multiprocess safety check).
 *
 * @param {Cu.Sandbox} aSandbox    - The sandbox to inject GM_info into.
 * @param {Window}     aContentWin - Content window (used for privacy check).
 * @param {IPCScript}  aScript     - Script descriptor; info() provides the data.
 */
function injectGMInfo(aSandbox, aContentWin, aScript) {
  let _gEnvironment = GM_util.getEnvironment();
  if ((_gEnvironment.e10s
        && ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 1)))
        || ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 2))) {
    return undefined;
  }

  let _API1 = "GM_info";

  var scriptInfoRaw = aScript.info();
  var scriptFileURL = aScript.fileURL;

  scriptInfoRaw.isIncognito = GM_util.windowIsPrivate(aContentWin);
  scriptInfoRaw.isPrivate = scriptInfoRaw.isIncognito;

  // TODO:
  // Also delay top level clone via lazy getter (XPCOMUtils.defineLazyGetter)?
  Reflect.set({}, _API1, Cu.cloneInto(scriptInfoRaw, aSandbox), aSandbox);

  var waivedInfo = Cu.waiveXrays(aSandbox[_API1]);
  var fileCache = new Map();

  function getScriptSource() {
    let content = fileCache.get("scriptSource");
    if (typeof content == "undefined") {
      // The alternative MIME type:
      // "text/plain;charset=" + GM_CONSTANTS.fileScriptCharset.toLowerCase()
      content = GM_util.fileXhr(scriptFileURL, "application/javascript");
      fileCache.set("scriptSource", content);
    }

    return content;
  }

  function getMeta() {
    let meta = fileCache.get("meta");
    if (typeof meta == "undefined") {
      meta = extractMeta(getScriptSource());
      fileCache.set("meta", meta);
    }

    return meta;
  }

  // Lazy getters for heavyweight strings that aren't sent down through IPC.
  Object.defineProperty(waivedInfo, "scriptSource", {
    "get": Cu.exportFunction(getScriptSource, aSandbox),
  });

  // Meta depends on content, so we need a lazy one here too.
  Object.defineProperty(waivedInfo, "scriptMetaStr", {
    "get": Cu.exportFunction(getMeta, aSandbox),
  });
}

/**
 * Executes a userscript (and all its @require files) inside the given sandbox.
 *
 * Execution order:
 *   1. evalAPI2Polyfill  — builds the GM.* Promise object (if pref is set).
 *   2. @require files    — loaded in declaration order via loadSubScript.
 *   3. The script itself — loaded last via loadSubScript.
 *
 * If any step throws an error, execution stops (returns undefined) so that
 * later requires and the script itself don't run with a broken environment.
 *
 * "return not in function" errors from top-level return statements are handled
 * gracefully: the code is re-evaluated wrapped in an IIFE (see bug #1592).
 *
 * @param {Cu.Sandbox} aSandbox - The sandbox created by createSandbox().
 * @param {IPCScript}  aScript  - The script to execute; provides fileURL and
 *   the list of requires.
 */
function runScriptInSandbox(aSandbox, aScript) {
  let _gEnvironment = GM_util.getEnvironment();
  if ((_gEnvironment.e10s
        && ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 1)))
        || ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 2))) {
    GM_util.logError(
        GM_CONSTANTS.info.scriptHandler + " - "
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.environment.unsupported")
            .replace("%1", JSON.stringify(_gEnvironment)),
        false, aScript.fileURL, null);
    return undefined;
  }

  /**
   * Loads aUrl into the sandbox via jsSubScriptLoader.
   * If the script uses a top-level `return` statement (which is not valid
   * outside a function), catches the resulting "return not in function" error,
   * emits a deprecation warning, and re-evaluates the code wrapped in an IIFE.
   *
   * @param {string} aUrl - chrome:// or file:// URL of the script/require.
   */
  function evalWithWrapper(aUrl) {
    try {
      GM_CONSTANTS.jsSubScriptLoader.loadSubScript(
          aUrl, aSandbox, GM_CONSTANTS.fileScriptCharset);
    } catch (e) {
      // js/src/js.msg: JSMSG_BAD_RETURN_OR_YIELD
      if (e.message == "return not in function") {
        // See #1592.
        // We never anon wrap anymore,
        // unless forced to by a return not in a function.
        GM_util.logError(
            GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("warning.returnNotInFuncDeprecated"),
            true, // Is a warning.
            e.fileName,
            e.lineNumber);

        // The alternative MIME type:
        // "text/plain;charset=" + GM_CONSTANTS.fileScriptCharset.toLowerCase()
        let code = GM_util.fileXhr(aUrl, "application/javascript");
        Cu.evalInSandbox(
            "(function () { " + code + "\n})()",
            aSandbox, JAVASCRIPT_VERSION_MAX, aUrl, 1);
      } else {
        // Otherwise raise.
        throw e;
      }
    }
  }

  /**
   * Wrapper around evalWithWrapper that catches all errors, logs them cleanly,
   * and returns false so the caller can abort execution.
   *
   * @param {string} aUrl - URL to load.
   * @returns {boolean} True on success, false if an error was thrown.
   */
  function evalWithCatch(aUrl) {
    try {
      evalWithWrapper(aUrl);
    } catch (e) {
      // Log it properly.
      GM_util.logError(e, false, e.fileName, e.lineNumber);
      // Stop the script, in the case of requires, as if it was one big script.
      return false;
    }
    return true;
  }

  /**
   * Builds and evals the GM.* Promise polyfill inside the sandbox.
   *
   * Constructs a JS code snippet at runtime that:
   *   - Creates `var GM = {}` in the sandbox global.
   *   - For each API name in GM_CONSTANTS.addonAPI, checks if the corresponding
   *     GM_* function is defined on `this` (the sandbox global).
   *   - If it is, assigns `GM.<name> = (...args) => new Promise(...)` wrapping
   *     the synchronous GM_* function.
   *   - Copies GM_info reference directly (not wrapped in Promise).
   *   - Calls Object.freeze(GM) to make the object read-only.
   *
   * Name mapping uses GM_CONSTANTS.addonAPIConversion for non-obvious renames
   * (e.g. GM_xmlhttpRequest → GM.xmlHttpRequest) and strips the "GM_" prefix
   * for everything else (e.g. GM_getValue → GM.getValue).
   *
   * @param {Cu.Sandbox} aSandbox - The sandbox to eval the polyfill in.
   * @param {IPCScript}  aScript  - The script (used for the fileURL in errors).
   * @returns {boolean} True on success, false if the eval failed.
   */
  function evalAPI2Polyfill(aSandbox, aScript) {
    let _API1 = "GM_info";
    let API2Polyfill = "";
    // Alternatives (see below "async"):
    //  (async () => {`;
    // instead of
    //  (() => {`;
    API2Polyfill += `
      var GM = {};
      (() => {`;
    let _APIConversion = {};
    GM_CONSTANTS.addonAPI.forEach(function (aValue) {
      let prop = "";
      let isAPIConversion = false;
      Object.entries(GM_CONSTANTS.addonAPIConversion).forEach(
          ([aAPI1, aAPI2]) => {
            if (aValue == aAPI1) {
              prop = aAPI2;
              isAPIConversion = true;
              return true;
            }
          });
      if (!isAPIConversion) {
        prop = aValue.replace(API_PREFIX_REGEXP, "$2");
      }
      _APIConversion[aValue] = prop;
    });
    API2Polyfill += `
        Object.entries({`;
    Object.entries(_APIConversion).forEach(([aAPI1, aAPI2]) => {
      if (aAPI1.indexOf(GM_CONSTANTS.addonAPIPrefix1) == 0) {
        API2Polyfill += `
          "` + aAPI1 + `": "` + aAPI2 + `",`;
      }
    });
    API2Polyfill += `
        }).forEach(([aAPI1, aAPI2]) => {
          let API1 = this[aAPI1];
          if (API1) {
            GM[aAPI2] = (...args) => {
              return new Promise((resolve, reject) => {
                try {
                  resolve(API1(...args));
                } catch (e) {
                  reject(e);
                }
              });
            };
          }
        });`;
    let prop = _API1.replace(API_PREFIX_REGEXP, "$2");
    API2Polyfill += `
        GM["` + prop + `"] = ` + _API1 + `;

        Object.freeze(GM);
      })();
    `;
    // dump(evalAPI2Polyfill.name + ":" + "\n" + API2Polyfill + "\n");

    try {
      Cu.evalInSandbox(
          API2Polyfill,
          aSandbox, JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1);
    } catch (e) {
      // "async" functions:
      // Firefox 52.0+
      // http://bugzil.la/1185106
      // js/src/js.msg: JSMSG_BAD_ARROW_ARGS
      if (e.message.indexOf("invalid arrow-function arguments") != 1) {
        GM_util.logError(
            GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName("error.api.object.polyfill"),
            false, e.fileName, null);
      } else {
        // Log it properly.
        GM_util.logError(e, false, e.fileName, null);
      }
      // Stop the script, in the case of requires, as if it was one big script.
      return false;
    }
    return true;
  }

  if (GM_prefRoot.getValue("api.object.polyfill")) {
    if (!evalAPI2Polyfill(aSandbox, aScript)) {
      return undefined;
    }
  }

  for (let i = 0, iLen = aScript.requires.length; i < iLen; i++) {
    let require = aScript.requires[i];
    if (!evalWithCatch(require.fileURL)) {
      return undefined;
    }
  }
  evalWithCatch(aScript.fileURL);
}
