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
 *     Builds the GM.* Promise-wrapper API surface (buildGMObject), loads all
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
 *     The GM4 GM.getValue wrapper is added later by buildGMObject().
 *
 * ── GM.* Promise surface (buildGMObject) ───────────────────────────────────
 *
 *   Called from runScriptInSandbox() when the "api.object.polyfill" pref is
 *   set (default: true).  Builds the GM object natively in chrome scope:
 *     1. Cu.createObjectIn(aSandbox, {defineAs: "GM"}) creates the holder.
 *     2. For each entry in the pre-computed module-level GM_API_MAPPING,
 *        Cu.exportFunction installs a Promise-returning wrapper as GM.<name>.
 *        Each wrapper runs in chrome scope and constructs the Promise via
 *        aSandbox.Promise so it integrates with the sandbox microtask queue.
 *     3. Copies GM_info directly (not a function — no Promise needed).
 *     4. aSandbox.Object.freeze(GM) prevents script tampering.
 *
 *   Pre-cleanup, this was a runtime string-build (evalAPI2Polyfill) that ran
 *   Cu.evalInSandbox on a freshly-built JS string per script.  The native
 *   build removes the per-sandbox string-construction cost, gives errors
 *   real chrome stack traces, and shrinks the eval-attack surface.
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
Cu.import("chrome://greasemonkey-modules/content/storageBack.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/GM_cookie.js");
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
 * Pre-computed [legacyName, modernName] pairs for every GM3 API that has a
 * GM4 (Promise-based) counterpart.  Built once at module load (not once per
 * sandbox) so buildGMObject() runs in linear time without any string-build.
 *
 * Pre-cleanup, this mapping was reconstructed inside the eval'd
 * evalAPI2Polyfill string for every script, every time.
 */
const GM_API_MAPPING = (function () {
  let pairs = [];
  let conv = GM_CONSTANTS.addonAPIConversion;
  GM_CONSTANTS.addonAPI.forEach(function (legacy) {
    if (legacy.indexOf(GM_CONSTANTS.addonAPIPrefix1) !== 0) {
      // Skip non-prefixed entries like "unsafeWindow".
      return;
    }
    let modern = (conv && conv[legacy])
        ? conv[legacy]
        : legacy.replace(API_PREFIX_REGEXP, "$2");
    pairs.push([legacy, modern]);
  });
  return Object.freeze(pairs);
})();

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

  if (aScript.grants.includes("none")) {
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
      && aScript.grants.includes(_API1))) {
    let unsafeWindowGetter = new sandbox.Function (
        "return window.wrappedJSObject || window;");
    Object.defineProperty(sandbox, _API1, {
      "get": unsafeWindowGetter,
    });
  } else {
    Cu.evalInSandbox(unsafeWindowDefault, sandbox);
  }

  _API1 = "GM_addElement";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = GM_addElement.bind(
        null, aContentWin, aScript.fileURL, aRunAt);
  }

  _API1 = "GM_addStyle";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = GM_addStyle.bind(
        null, aContentWin, aScript.fileURL, aRunAt);
  }

  if (GM_prefRoot.getValue("api.GM_cookie")) {
    _API1 = "GM_cookie";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (aScript.grants.includes(_API1)
        || aScript.grants.some(function (aItem) {
             return String(aItem).toLowerCase() === String(_API2).toLowerCase();
           })) {
      // Phase 7b: GM_cookie is now a methods-object (.list/.set/.delete)
      // built natively on top of Services.cookies, replacing the
      // third-party dispatch-function polyfill.  buildGMObject's
      // special-case picks up the object shape and mirrors it as
      // GM.cookie (Promise-wrapped methods).
      sandbox[_API1] = createGMCookieAPI(
          aContentWin, sandbox, aScript.fileURL, aUrl);
    }
  }

  // Pre-cleanup, the Front took aFrameScope as its first arg so it could
  // route scriptVal-* RPCs to the parent process via cpmm.  UXP single-
  // process collapsed the front/back IPC into a same-module direct call,
  // so the message-manager handle is no longer needed.
  let scriptStorage = new GM_ScriptStorageFront(
      aContentWin, sandbox, aScript);
  _API1 = "GM_deleteValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.deleteValue.bind(scriptStorage);
  }
  _API1 = "GM_deleteValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.deleteValues.bind(scriptStorage);
  }
  _API1 = "GM_getValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.getValue.bind(scriptStorage);
  }
  _API1 = "GM_getValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.getValues.bind(scriptStorage);
  }
  _API1 = "GM_setValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.setValue.bind(scriptStorage);
  }
  _API1 = "GM_setValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.setValues.bind(scriptStorage);
  }

  _API1 = "GM_listValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.listValues.bind(scriptStorage);
  }

  _API1 = "GM_addValueChangeListener";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.addValueChangeListener.bind(scriptStorage);
  }
  _API1 = "GM_removeValueChangeListener";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptStorage.removeValueChangeListener.bind(scriptStorage);
  }

  let scriptResources = new GM_Resources(aScript);
  _API1 = "GM_getResourceText";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptResources.getResourceText.bind(
        scriptResources,
        aContentWin, sandbox, aScript.fileURL);
  }
  _API1 = "GM_getResourceURL";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = scriptResources.getResourceURL.bind(
        scriptResources,
        aContentWin, sandbox, aScript);
  }

  _API1 = "GM_log";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    {
      let _logger = new GM_ScriptLogger(aScript);
      sandbox[_API1] = _logger.log.bind(_logger);
    }
  }

  _API1 = "GM_notification";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    {
      let _notifier = new GM_notificationer(
          getChromeWinForContentWin(aContentWin), aContentWin, sandbox,
          aScript.fileURL, aScript.localized.name);
      sandbox[_API1] = _notifier.contentStart.bind(_notifier);
    }
  }

  _API1 = "GM_openInTab";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    // Wrap GM_openInTab to clone the returned tab handle into the sandbox.
    // Without this, Xray wrappers block access to .close()/.onclose.
    // Phase 4f-2: pass aContentWin instead of the frame message manager.
    // GM_openInTab now finds the chrome window via getChromeWinForContentWin
    // and calls GM_BrowserUI.openInTab / .tabClose directly.
    let _openInTabFn = GM_openInTab.bind(null, aContentWin, aUrl);
    sandbox[_API1] = function (aTabUrl, aTabOptions) {
      let chromeHandle = _openInTabFn(aTabUrl, aTabOptions);
      // Create a sandbox-side tab handle that proxies to the chrome one.
      let sandboxHandle = Cu.createObjectIn(sandbox);
      sandboxHandle.closed = false;
      sandboxHandle.onclose = null;
      sandboxHandle.close = Cu.exportFunction(function () {
        chromeHandle.close();
      }, sandbox);
      // Wire up the chrome handle's onclose to update the sandbox handle.
      chromeHandle.onclose = function () {
        sandboxHandle.closed = true;
        if (typeof sandboxHandle.onclose == "function") {
          try {
            Cu.waiveXrays(sandboxHandle).onclose();
          } catch (e) {
            // Ignore callback errors.
          }
        }
      };
      return sandboxHandle;
    };
  }

  _API1 = "GM_registerMenuCommand";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  let _unreg1 = "GM_unregisterMenuCommand";
  let _unreg2 = _unreg1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })
      || aScript.grants.includes(_unreg1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_unreg2).toLowerCase();
         })) {
    // Inject MenuCommandSandbox into the sandbox by source.  The function's
    // body — including its two event listeners and its closure-scoped
    // { commands, commandFuncs } maps — ends up running in sandbox
    // compartment, so user callbacks never have to cross an XrayWrapper
    // boundary at click time (see #13; the previous chrome-context
    // listener hit "XrayWrapper denied access to property N (reason:
    // value is callable)" and menu clicks silently did nothing).
    //
    // Concatenating the function with "" coerces it via toString(), which
    // is the standard ES method and is NOT affected by the Pale Moon
    // Function.prototype.toSource() decompiler bug that caused the
    // original "MenuCommandSandbox.toSource() crash" we set out to fix
    // in the first place.  Best of both worlds.
    Cu.evalInSandbox(
        "this._MenuCommandSandbox = " + MenuCommandSandbox, sandbox);
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
    // MenuCommandSandbox's closure is what keeps commands/commandFuncs
    // alive; the global reference was just a transport vehicle.
    Cu.evalInSandbox(
        "delete this._MenuCommandSandbox;", sandbox);
  }

  _API1 = "GM_setClipboard";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    sandbox[_API1] = GM_setClipboard.bind(
        null, aContentWin, aScript.fileURL);
  }

  // See #2538 (an alternative).
  // See #2538 (an alternative).
  // Also accept @grant window.close / window.focus (Tampermonkey/VM compat).
  _API1 = "GM_windowClose";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })
      || aScript.grants.includes("window.close")) {
    sandbox[_API1] = GM_window.bind(
        null, aContentWin, aScript.fileURL, "close");
  }
  _API1 = "GM_windowFocus";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })
      || aScript.grants.includes("window.focus")) {
    sandbox[_API1] = GM_window.bind(
        null, aContentWin, aScript.fileURL, "focus");
  }

  _API1 = "GM_xmlhttpRequest";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    {
      let _xhr = new GM_xmlHttpRequester(
          aContentWin, sandbox, aScript.fileURL, aUrl, aScript.connects);
      sandbox[_API1] = _xhr.contentStartRequest.bind(_xhr);
    }
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
  if (aScript.grants.includes(_API1)
      || aScript.grants.some(function (aItem) {
           return String(aItem).toLowerCase() === String(_API2).toLowerCase();
         })) {
    if (typeof sandbox["GM_xmlhttpRequest"] == "undefined") {
      let _xhr = new GM_xmlHttpRequester(
          aContentWin, sandbox, aScript.fileURL, aUrl, aScript.connects);
      sandbox["GM_xmlhttpRequest"] = Cu.cloneInto(
          _xhr.contentStartRequest.bind(_xhr),
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
 *   1. buildGMObject     — builds the GM.* Promise object (if pref is set).
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
   * Builds the script-facing GM4 surface (the `GM` object exposing
   * GM.getValue / GM.setValue / GM.xmlHttpRequest / etc. as Promise-
   * returning methods) for the given sandbox.
   *
   * Replaces the historical evalAPI2Polyfill, which ran a runtime-built
   * JS string through Cu.evalInSandbox per script.  This implementation:
   *
   *   - Uses Cu.createObjectIn + Cu.exportFunction (native chrome →
   *     sandbox object construction; no eval).
   *   - Iterates the pre-computed module-level GM_API_MAPPING instead
   *     of rebuilding the legacy→modern map on every call.
   *   - Constructs each GM.X wrapper as a chrome-side closure that
   *     `new aSandbox.Promise(...)` — so the script's `await GM.X(...)`
   *     integrates with the sandbox microtask queue and stack traces
   *     point at this function rather than at an eval'd string.
   *   - Copies GM_info as a direct property (not Promise-wrapped, since
   *     it's the metadata snapshot).
   *   - Freezes the GM object using the sandbox's own Object.freeze so
   *     scripts can't reassign GM.X.
   *
   * @param {Cu.Sandbox} aSandbox - Target sandbox (created by createSandbox()).
   * @param {IPCScript}  aScript  - Script descriptor (for error attribution).
   * @returns {boolean} True on success; false if construction failed (the
   *                    caller aborts the script in that case, matching the
   *                    pre-cleanup polyfill contract).
   */
  function buildGMObject(aSandbox, aScript) {
    try {
      let gmObj = Cu.createObjectIn(aSandbox, { "defineAs": "GM" });

      for (let i = 0; i < GM_API_MAPPING.length; i++) {
        let pair = GM_API_MAPPING[i];
        let legacyName = pair[0];
        let modernName = pair[1];
        let legacyFn = aSandbox[legacyName];
        if (typeof legacyFn !== "function") {
          // Script didn't @grant this API; skip.
          continue;
        }

        // Closure-captures legacyFn so each wrapper invokes the right
        // chrome-side implementation.  The wrapper itself runs in chrome
        // scope; Cu.exportFunction handles the cross-compartment glue.
        let wrapper = (function (fn) {
          return function gmAsyncWrapper() {
            let args = arguments;
            return new aSandbox.Promise(function (resolve, reject) {
              try {
                resolve(fn.apply(null, args));
              } catch (e) {
                reject(e);
              }
            });
          };
        })(legacyFn);

        Cu.exportFunction(wrapper, gmObj, { "defineAs": modernName });
      }

      // GM_info is a frozen plain object already attached to the sandbox.
      // Mirror it as GM.info so scripts can read either name.
      if (typeof aSandbox.GM_info !== "undefined") {
        let infoProp = "GM_info".replace(API_PREFIX_REGEXP, "$2");
        gmObj[infoProp] = aSandbox.GM_info;
      }

      // GM_cookie special-case: sandbox.GM_cookie is a methods-object
      // (.list / .set / .delete) — the GM3 form scripts use as
      // GM_cookie.list(filter, callback).  buildGMObject's main loop
      // skips it because typeof !== "function"; mirror the methods
      // here as GM.cookie.X with Promise wrapping so GM4 scripts can
      // do `await GM.cookie.list({})` etc.
      if (aSandbox.GM_cookie
          && (typeof aSandbox.GM_cookie === "object")) {
        let cookieGmObj = Cu.createObjectIn(gmObj, { "defineAs": "cookie" });
        ["list", "set", "delete"].forEach(function (aMethod) {
          let method = aSandbox.GM_cookie[aMethod];
          if (typeof method !== "function") return;
          let wrapper = (function (fn) {
            return function gmCookieAsyncWrapper() {
              let args = arguments;
              return new aSandbox.Promise(function (resolve, reject) {
                try {
                  resolve(fn.apply(null, args));
                } catch (e) {
                  reject(e);
                }
              });
            };
          })(method);
          Cu.exportFunction(wrapper, cookieGmObj, { "defineAs": aMethod });
        });
      }

      // Freeze through the sandbox's own Object so the operation happens
      // in sandbox scope (consistent with the pre-cleanup polyfill).
      try {
        aSandbox.Object.freeze(gmObj);
      } catch (e) {
        // Fallback — extremely rare; would only happen if Object is
        // somehow shadowed in the sandbox prototype chain.
        Cu.evalInSandbox(
            "Object.freeze(this.GM);", aSandbox,
            JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1);
      }
    } catch (e) {
      GM_util.logError(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.api.object.polyfill"),
          false, e.fileName || aScript.fileURL, e.lineNumber || 0);
      return false;
    }
    return true;
  }

  // The pref name still says "polyfill" for backward-compatibility with
  // any user who set it explicitly; the implementation is now native.
  if (GM_prefRoot.getValue("api.object.polyfill")) {
    if (!buildGMObject(aSandbox, aScript)) {
      return undefined;
    }
  }

  for (let i = 0, iLen = aScript.requires.length; i < iLen; i++) {
    let require = aScript.requires[i];
    if (!evalWithCatch(require.fileURL)) {
      return undefined;
    }
  }

  if (aScript.topLevelAwait) {
    // @topLevelAwait: wrap the script in an async IIFE so top-level
    // await is valid.  This matches Violentmonkey's behavior.
    try {
      let code = GM_util.fileXhr(
          aScript.fileURL, "application/javascript");
      Cu.evalInSandbox(
          "(async () => {\n" + code + "\n})();",
          aSandbox, JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1);
    } catch (e) {
      GM_util.logError(e, false, e.fileName, e.lineNumber);
    }
  } else {
    evalWithCatch(aScript.fileURL);
  }
}
