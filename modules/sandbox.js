/**
 * @file sandbox.js
 * @overview Creates the isolated JavaScript sandbox in which userscripts
 *   execute, and injects the GM_* / GM.* APIs into it.
 *
 * Exports:
 *
 *   createSandbox(aContentWin, aUrl, aScript, aRunAt)
 *     Constructs a Cu.Sandbox for the given script, then injects whichever
 *     GM_* functions the script's @grant list requests.  Returns the sandbox.
 *
 *   runScriptInSandbox(aSandbox, aScript)
 *     Builds the GM.* Promise-wrapper API surface (buildGMObject), loads all
 *     @require files in order, then loads the script itself.
 *
 *   scriptRealm(aScript)
 *     "page" or "content": where a script with GM APIs runs (see below).
 *
 * ── Sandbox modes ──────────────────────────────────────────────────────────
 *
 *   @grant none   (or no @grant at all)
 *     A plain sandbox with sandboxPrototype = contentWin and wantXrays=false.
 *     The script runs almost as if it were a page script.
 *     Only GM_info and a compatibility unsafeWindow alias are injected.
 *
 *   @grant <anything else>, injected into "content" (the classic way)
 *     A full Xray sandbox.  Only the explicitly listed GM_* functions are
 *     injected; everything else is absent.
 *
 *   @grant <anything else>, injected into "page" (Violentmonkey's way)
 *     A sandbox with the page's own principal, as for @grant none, so the
 *     objects and functions the script makes belong to the page and the
 *     page can use them.  The page can reach that sandbox's global (from
 *     any function the script hands it, through its constructor), so the
 *     GM APIs are never put there: they are local variables of a function
 *     wrapped around the script and its @requires (runInPageWorld), and
 *     `window` is a wrapper of the real window that keeps the script's own
 *     window.x private (PageWindowSandbox), as in Violentmonkey.
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
 *        The exceptions: SYNC_RETURN_GM_APIS return their value directly,
 *        and GM.xmlHttpRequest / GM.download get GMRequestPromiseSandbox,
 *        a fixed function evaluated in the sandbox, whose Promise settles
 *        with the response.
 *     3. Copies GM_info directly (not a function — no Promise needed).
 *     4. aSandbox.Object.freeze(GM) prevents script tampering.
 *
 *   Errors carry real chrome stack traces.  Nothing is built from a
 *   runtime-constructed string: the one evaluated source is a fixed
 *   function in this module.
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
 *   GM_download is a native chrome-side callable built on
 *   nsIWebBrowserPersist + nsIFilePicker (modules/GM_download.js).
 *   It has no dependency on GM_xmlhttpRequest; scripts that need XHR
 *   must @grant it explicitly.
 */

const EXPORTED_SYMBOLS = ["createSandbox", "runScriptInSandbox", "scriptRealm"];

if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

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
Cu.import("chrome://greasemonkey-modules/content/GM_download.js");
Cu.import("chrome://greasemonkey-modules/content/GM_tab.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("chrome://greasemonkey-modules/content/xmlHttpRequester.js");


// https://hg.mozilla.org/releases/mozilla-esr52/file/324cc1bccf3d/js/src/jsapi.cpp#l582
// Only a particular set of strings are allowed.
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
 * GM.xmlHttpRequest / GM.download: a Promise for the response, as in
 * Violentmonkey and Tampermonkey.  It resolves with the onload response and
 * rejects with the onerror / ontimeout / onabort one; the script's own
 * callbacks still run, and the Promise carries .abort().
 *
 * Injected into the sandbox by source, never run in chrome: the callbacks
 * it hands the request then belong to the script, so the request's
 * same-principal check accepts them, and the Promise is the script's own.
 * It must not use anything outside its own body.
 *
 * IMPORTANT: held as a template-literal string, NOT a function, like
 * MenuCommandSandbox (menuCommand.js; issue #13).  UXP compiles a module as
 * Latin-1 but reads its source back as UTF-8 for Function.prototype.
 * toString(), so a function's text comes out shifted by the extra bytes of
 * any non-ASCII character above it.  As a function, this came out starting
 * mid-body, didn't compile, and every script granting GM.xmlHttpRequest or
 * GM.download stopped (found on device, 3.10).  Keep the text ASCII, with
 * no backslash, backtick or "${": it is a template literal.
 *
 * Arguments of the function it defines:
 *   aGM      - The sandbox's GM object.
 *   aName    - The GM.* name to define ("xmlHttpRequest").
 *   aRequest - The sandbox's GM_* function.
 */
var GMRequestPromiseSandbox = `
function GMRequestPromiseSandbox(aGM, aName, aRequest) {
  let assign = Object.assign;
  let SandboxPromise = Promise;
  let settlers = [
    ["onload", 0], ["onerror", 1], ["ontimeout", 1], ["onabort", 1],
  ];
  aGM[aName] = function (aDetails, aExtra) {
    let control = null;
    let promise = new SandboxPromise(function (aResolve, aReject) {
      // GM.download(url, name) takes a bare address.
      let own = (typeof aDetails == "string") ? { "url": aDetails } : aDetails;
      let details = own;
      if (own && (typeof own == "object")) {
        details = assign({}, own);
        settlers.forEach(function (aSettler) {
          let callback = own[aSettler[0]];
          if ((callback != null) && (typeof callback != "function")) {
            // Left for the request to report.
            return;
          }
          let settle = aSettler[1] ? aReject : aResolve;
          details[aSettler[0]] = function (aResponse) {
            settle(aResponse);
            if (callback) {
              return callback.call(own, aResponse);
            }
            return undefined;
          };
        });
      }
      control = aRequest(details, aExtra);
    });
    promise.abort = function () {
      if (control && (typeof control.abort == "function")) {
        control.abort();
      }
    };
    return promise;
  };
}
`;

/**
 * The `window` of a script that runs in the page's world with GM APIs: a
 * Proxy of the sandbox's global (aLocal) that reads through to the real
 * window (aPage), as Violentmonkey's window is for such scripts.
 *
 *   - Reads: the script's own window.x if it set one, else the page's.
 *     A window method (addEventListener, setTimeout, fetch) comes bound to
 *     the real window, which it needs as `this`; also when the page has
 *     replaced it with a function of its own (hooking addEventListener,
 *     say), which would otherwise get this wrapper as `this`.  A method is
 *     one of the platform's (aMethodNames), or any function without a
 *     prototype; a page's constructor or library (jQuery, with its .fn)
 *     comes as it is.  The real window itself (window.self, window.top in
 *     a top window...) reads as this wrapper, so `window.top === window`.
 *   - Writes stay the script's own (an @require'd jQuery doesn't replace
 *     the page's), except the real window's accessors (window.onload,
 *     window.location), which act on the page.
 *   - Its target is the sandbox's global, so window.x and a bare x agree.
 *   - Its own properties are the script's and the real window's, as a
 *     window's are: Object.getOwnPropertyDescriptor(window, "frameElement")
 *     finds the platform's (AdGuard Popup Blocker stopped at once without
 *     it), and Object.keys(window) lists both.  The real window's come as
 *     configurable, as a Proxy must report a property its target lacks.
 *
 * Everything it uses is taken from the sandbox's own built-ins when it is
 * made, never from the page, which can replace its own at will.
 *
 * Held as a string and kept ASCII, with no backslash, backtick or "${",
 * for the reason given at GMRequestPromiseSandbox.
 *
 * Arguments of the function it defines:
 *   aLocal       - The sandbox's global.
 *   aPage        - The real window.
 *   aMethodNames - The platform's window methods, comma-separated (see
 *                  windowMethodNames).
 */
var PageWindowSandbox = `
function PageWindowSandbox(aLocal, aPage, aMethodNames) {
  var apply = Reflect.apply;
  var bind = Function.prototype.bind;
  var defineProperty = Reflect.defineProperty;
  var getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  var getPrototypeOf = Object.getPrototypeOf;
  var hasOwnProperty = Object.prototype.hasOwnProperty;
  var isExtensible = Reflect.isExtensible;
  var ownKeys = Reflect.ownKeys;
  var push = Array.prototype.push;
  var reflectGet = Reflect.get;
  var reflectSet = Reflect.set;
  var setAdd = Set.prototype.add;
  var setHas = Set.prototype.has;
  var SandboxSet = Set;
  var weakGet = WeakMap.prototype.get;
  var weakSet = WeakMap.prototype.set;
  var bound = new WeakMap();
  var methods = Object.create(null);
  var wrapper = null;

  var names = aMethodNames ? aMethodNames.split(",") : [];
  for (var i = 0; i < names.length; i++) {
    methods[names[i]] = true;
  }

  function own(aObject, aName) {
    return apply(hasOwnProperty, aObject, [aName]);
  }

  function pageAccessor(aName) {
    for (var object = aPage; object; object = getPrototypeOf(object)) {
      var desc = getOwnPropertyDescriptor(object, aName);
      if (desc) {
        return (desc.get || desc.set) ? desc : null;
      }
    }
    return null;
  }

  wrapper = new Proxy(aLocal, {
    "get": function (aTarget, aName) {
      var value;
      if (own(aLocal, aName)) {
        value = aLocal[aName];
        return (value === aLocal) ? wrapper : value;
      }
      value = reflectGet(aPage, aName);
      if (value === aPage) {
        return wrapper;
      }
      if ((typeof value == "function")
          && ((methods[aName] === true) || !own(value, "prototype"))) {
        var method = apply(weakGet, bound, [value]);
        if (!method) {
          method = apply(bind, value, [aPage]);
          apply(weakSet, bound, [value, method]);
        }
        return method;
      }
      return value;
    },
    "set": function (aTarget, aName, aValue) {
      if (own(aLocal, aName)) {
        return reflectSet(aLocal, aName, aValue);
      }
      var desc = pageAccessor(aName);
      if (desc) {
        return desc.set ? reflectSet(aPage, aName, aValue) : false;
      }
      return defineProperty(aLocal, aName, {
        "configurable": true, "enumerable": true,
        "value": aValue, "writable": true,
      });
    },
    "getOwnPropertyDescriptor": function (aTarget, aName) {
      var desc = getOwnPropertyDescriptor(aLocal, aName);
      if (!desc) {
        if (!isExtensible(aLocal)) {
          return undefined;
        }
        desc = getOwnPropertyDescriptor(aPage, aName);
        if (!desc) {
          return undefined;
        }
        desc.configurable = true;
      }
      if ((desc.value === aLocal) || (desc.value === aPage)) {
        desc.value = wrapper;
      }
      return desc;
    },
    "ownKeys": function () {
      var keys = ownKeys(aLocal);
      if (!isExtensible(aLocal)) {
        return keys;
      }
      var seen = new SandboxSet();
      var i;
      for (i = 0; i < keys.length; i++) {
        apply(setAdd, seen, [keys[i]]);
      }
      var pageKeys = ownKeys(aPage);
      for (i = 0; i < pageKeys.length; i++) {
        if (!apply(setHas, seen, [pageKeys[i]])) {
          apply(push, keys, [pageKeys[i]]);
        }
      }
      return keys;
    },
  });
  return wrapper;
}`;

/**
 * `instanceof` across the two realms of the page's world, for a sandbox
 * there (@grant none, or injected into the page).  Its script has the
 * sandbox's own Array, Promise, Error... (the page can't tamper with
 * them), so the page's objects weren't instances of them:
 * `pageArray instanceof Array` was false, where it is true in
 * Violentmonkey.  Each of those constructors gets a Symbol.hasInstance
 * that also accepts the page's instances, checked against the page's own
 * constructor (the platform's, read through X-rays, not one the page put
 * in its place).  Defined on the sandbox's constructors only: the page
 * sees nothing.
 *
 * Held as a string and kept ASCII, with no backslash, backtick or "${",
 * for the reason given at GMRequestPromiseSandbox.
 *
 * Arguments of the function it defines:
 *   aLocal - The sandbox's global.
 *   aNames - The constructors' names, comma-separated.
 *   ...    - The page's constructors, in that order.
 */
var CrossRealmInstanceofSandbox = `
function CrossRealmInstanceofSandbox(aLocal, aNames) {
  var apply = Reflect.apply;
  var defineProperty = Reflect.defineProperty;
  var hasInstance = Function.prototype[Symbol.hasInstance];
  var names = aNames.split(",");
  var share = function (aOwn, aPage) {
    if ((typeof aOwn != "function") || (typeof aPage != "function")
        || (aOwn === aPage)) {
      return;
    }
    defineProperty(aOwn, Symbol.hasInstance, {
      "configurable": true,
      "value": function (aValue) {
        return apply(hasInstance, aOwn, [aValue])
            || apply(hasInstance, aPage, [aValue]);
      },
    });
  };
  for (var i = 0; i < names.length; i++) {
    share(aLocal[names[i]], arguments[i + 2]);
  }
}`;

/** The constructors CrossRealmInstanceofSandbox shares. */
const CROSS_REALM_CONSTRUCTORS = [
  "Array", "ArrayBuffer", "Boolean", "DataView", "Date", "Error",
  "EvalError", "Float32Array", "Float64Array", "Function", "Int16Array",
  "Int32Array", "Int8Array", "Map", "Number", "Object", "Promise",
  "RangeError", "ReferenceError", "RegExp", "Set", "String", "SyntaxError",
  "TypeError", "URIError", "Uint16Array", "Uint32Array", "Uint8Array",
  "Uint8ClampedArray", "WeakMap", "WeakSet",
];

/**
 * Lets a page-world sandbox's `instanceof` accept the page's objects: see
 * CrossRealmInstanceofSandbox.  Whatever fails, the script still runs.
 *
 * @param {Sandbox} aSandbox
 * @param {Window}  aContentWin - Its page (X-ray: its own constructors).
 */
function shareInstanceof(aSandbox, aContentWin) {
  try {
    let pageConstructors = CROSS_REALM_CONSTRUCTORS.map(function (aName) {
      return aContentWin[aName];
    });
    Cu.evalInSandbox("(" + CrossRealmInstanceofSandbox + ")", aSandbox)(
        aSandbox, CROSS_REALM_CONSTRUCTORS.join(","), ...pageConstructors);
  } catch (e) {
    // The page is gone, or isn't an ordinary one: plain instanceof.
  }
}

/** Where a script with GM APIs runs when nothing chooses for it. */
const DEFAULT_REALM = "page";

/**
 * Where a script runs: "page", the page's own world (as in Violentmonkey),
 * or "content", the classic sandbox apart from the page.  A @grant none
 * script always runs in the page's world.  For one with GM APIs, its
 * "Inject into" setting decides, else its @inject-into, else the
 * injectInto.default preference ("auto" leaves it to the next one); a
 * value that is none of these is the default, page.
 *
 * @param {IPCScript} aScript
 * @returns {string} "page" or "content".
 */
function scriptRealm(aScript) {
  if ((aScript.grants || []).includes("none")) {
    return "page";
  }
  let realm = aScript.injectInto;
  if ((realm != "page") && (realm != "content")) {
    realm = GM_prefRoot.getValue("injectInto.default", DEFAULT_REALM);
  }
  return ((realm == "page") || (realm == "content")) ? realm : DEFAULT_REALM;
}

/**
 * The GM APIs of each page-world sandbox, from createSandbox to
 * runScriptInSandbox: an object of name -> value, every value already the
 * sandbox's own (an exported function, a GM_info clone...).  Never on the
 * sandbox's global, which the page can reach.
 *
 * @type {WeakMap<Sandbox, Object>}
 */
var gPageWorldApis = new WeakMap();

/**
 * Creates and returns the JavaScript sandbox for a userscript.
 *
 * @param {Window}    aContentWin - The content window the script runs in;
 *   used as the sandbox prototype and principal.
 * @param {string}    aUrl        - URL of the page being loaded; passed
 *   to APIs that need the page origin (xmlhttpRequest, cookie, etc.).
 * @param {IPCScript} aScript     - The script descriptor object.
 * @param {string}    aRunAt      - The run-at phase ("document-start",
 *   "document-end", or "document-idle"); passed to GM_addStyle.
 * @returns {Cu.Sandbox} The populated sandbox ready for script execution.
 */
function createSandbox(aContentWin, aUrl, aScript, aRunAt) {
  let _API1 = "";
  let _API2 = "";
  // A plain property, not a `const`: a script that declares its own
  // `var unsafeWindow` (the old Chrome-compat idiom) would otherwise fail
  // to compile ("redeclaration of const").
  let unsafeWindowDefault = "Object.defineProperty(this, \"unsafeWindow\", "
      + "{\"configurable\": true, \"value\": window, \"writable\": true});";

  // Pre-compute a lowercased Set of @grant entries once per sandbox
  // construction.  Pre-fix, every API-grant check did:
  //   aScript.grants.some(i => String(i).toLowerCase() ===
  //                            String(_API2).toLowerCase())
  // — `.toLowerCase()` was called per @grant per API per sandbox, so
  // an 18-API loop on a 10-grant script burned ~200 µs of pure
  // string-allocation per sandbox creation.  Multi-iframe pages
  // create dozens of sandboxes per navigation, so this added up.
  // The Set is consulted via `grantsLC.has(_API2.toLowerCase())`
  // alongside the original `.includes(_API1)` check; semantically
  // identical, O(1) per lookup.
  let grantsLC = new Set();
  for (let i = 0, iLen = aScript.grants.length; i < iLen; i++) {
    grantsLC.add(String(aScript.grants[i]).toLowerCase());
  }
  function hasGrant(legacyName, modernName) {
    return aScript.grants.includes(legacyName)
        || grantsLC.has(String(modernName).toLowerCase());
  }

  if (aScript.grants.includes("none")) {
    // If there is an explicit none grant, use a plain unwrapped sandbox
    // with no other content.
    var contentSandbox = new Cu.Sandbox(
        pageWorldPrincipal(aContentWin), {
          "sameZoneAs": aContentWin,
          "sandboxName": aScript.id,
          "sandboxPrototype": aContentWin,
          "wantXrays": false,
        });

    // GM_info is always provided.
    injectGMInfo(contentSandbox, aContentWin, aScript, "page");

    // The page's objects are instances of its Array, Promise... too.
    shareInstanceof(contentSandbox, aContentWin);

    // Alias unsafeWindow for compatibility.
    Cu.evalInSandbox(unsafeWindowDefault, contentSandbox);

    return contentSandbox;
  }

  // The page's own world (its principal, no X-rays), or the classic
  // sandbox apart from it (an expanded principal seeing the page through
  // X-rays): see scriptRealm and this file's header.
  let pageWorld = (scriptRealm(aScript) == "page");
  var sandbox = new Cu.Sandbox(
      pageWorld ? pageWorldPrincipal(aContentWin) : [aContentWin], {
        "sameZoneAs": aContentWin,
        "sandboxName": aScript.id,
        "sandboxPrototype": aContentWin,
        "wantXrays": !pageWorld,
        "wantExportHelpers": true,
      });
  // Where the GM APIs go: the classic sandbox's global, or, in the page's
  // world, an object of our own that runInPageWorld hands to the script
  // privately (the page can reach that sandbox's global).
  let api = pageWorld ? Object.create(null) : sandbox;

  // http://bugzil.la/1043958
  // Note that because waivers aren't propagated between origins,
  // we need the unsafeWindow getter to live in the sandbox.
  // See also:
  // toolkit/commonjs/sdk/content/sandbox.js
  // (The page's world needs no getter: the real window is its own.  Its
  // unsafeWindow is set with its window, in preparePageWorld.)
  _API1 = "unsafeWindow";
  let realUnsafeWindow = !GM_prefRoot.getValue("api.unsafeWindow.grant")
      || aScript.grants.includes(_API1);
  if (pageWorld) {
    // See preparePageWorld.
  } else if (realUnsafeWindow) {
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
  if (hasGrant(_API1, _API2)) {
    api[_API1] = GM_addElement.bind(
        null, aContentWin, aScript.fileURL, aRunAt);
  }

  _API1 = "GM_addStyle";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = GM_addStyle.bind(
        null, aContentWin, aScript.fileURL, aRunAt);
  }

  if (GM_prefRoot.getValue("api.GM_cookie")) {
    _API1 = "GM_cookie";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (hasGrant(_API1, _API2)) {
      // GM_cookie is a methods-object (.list/.set/.delete) built natively
      // on top of Services.cookies.  buildGMObject's special-case picks
      // up the object shape and mirrors it as GM.cookie (Promise-wrapped
      // methods).
      api[_API1] = createGMCookieAPI(
          aContentWin, sandbox, aScript.fileURL, aUrl, aScript.connects,
          aScript.httpOnlyCookies);
    }
  }

  // GM_ScriptStorageFront proxies scriptVal-* operations directly to the
  // back-end in the same JS runtime; UXP is single-process so no message
  // manager handle is needed.
  let scriptStorage = new GM_ScriptStorageFront(
      aContentWin, sandbox, aScript);
  _API1 = "GM_deleteValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.deleteValue.bind(scriptStorage);
  }
  _API1 = "GM_deleteValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.deleteValues.bind(scriptStorage);
  }
  _API1 = "GM_getValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.getValue.bind(scriptStorage);
  }
  _API1 = "GM_getValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.getValues.bind(scriptStorage);
  }
  _API1 = "GM_setValue";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.setValue.bind(scriptStorage);
  }
  _API1 = "GM_setValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.setValues.bind(scriptStorage);
  }

  _API1 = "GM_listValues";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.listValues.bind(scriptStorage);
  }

  _API1 = "GM_addValueChangeListener";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.addValueChangeListener.bind(scriptStorage);
  }
  _API1 = "GM_removeValueChangeListener";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptStorage.removeValueChangeListener.bind(scriptStorage);
  }

  let scriptResources = new GM_Resources(aScript);
  _API1 = "GM_getResourceText";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptResources.getResourceText.bind(
        scriptResources,
        aContentWin, sandbox, aScript.fileURL);
  }
  _API1 = "GM_getResourceURL";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = scriptResources.getResourceURL.bind(
        scriptResources,
        aContentWin, sandbox, aScript);
  }

  _API1 = "GM_log";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    {
      let _logger = new GM_ScriptLogger(aScript);
      api[_API1] = _logger.log.bind(_logger);
    }
  }

  _API1 = "GM_notification";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    {
      let _notifier = new GM_notificationer(
          getChromeWinForContentWin(aContentWin), aContentWin, sandbox,
          aScript.fileURL, aScript.localized.name);
      api[_API1] = _notifier.contentStart.bind(_notifier);
    }
  }

  // GM_getTab / GM_saveTab / GM_getTabs: per-tab, per-script in-memory
  // store (Tampermonkey / ScriptCat).  Plain callables listed in
  // GM_CONSTANTS.addonAPI, so buildGMObject wraps them as GM.getTab /
  // GM.saveTab / GM.getTabs.
  if (GM_prefRoot.getValue("api.GM_getTab", true)) {
    let gmTabId;
    try {
      gmTabId = GM_util.windowId(aContentWin.top, "outer");
    } catch (e) {
      try {
        gmTabId = GM_util.windowId(aContentWin, "outer");
      } catch (e2) {
        gmTabId = 0;
      }
    }
    let gmTabApi = createGMTabAPI(
        aContentWin, sandbox, aScript.fileURL, aScript.uuid, gmTabId);
    _API1 = "GM_getTab";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (hasGrant(_API1, _API2)) {
      api[_API1] = gmTabApi.getTab;
    }
    _API1 = "GM_saveTab";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (hasGrant(_API1, _API2)) {
      api[_API1] = gmTabApi.saveTab;
    }
    _API1 = "GM_getTabs";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (hasGrant(_API1, _API2)) {
      api[_API1] = gmTabApi.getTabs;
    }
  }

  _API1 = "GM_openInTab";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    // Wrap GM_openInTab to clone the returned tab handle into the sandbox.
    // Without this, Xray wrappers block access to .close()/.onclose.
    // GM_openInTab finds the chrome window via getChromeWinForContentWin
    // and calls GM_BrowserUI.openInTab / .tabClose directly.
    let _openInTabFn = GM_openInTab.bind(null, aContentWin, aUrl);
    api[_API1] = function (aTabUrl, aTabOptions) {
      let chromeHandle = _openInTabFn(aTabUrl, aTabOptions);
      if (!chromeHandle) {
        // No browser window to open it in.
        return null;
      }
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
        // Read the script's callback through the waiver: the Xray view
        // hides function-valued properties, so a plain read is always
        // undefined.
        let onclose = Cu.waiveXrays(sandboxHandle).onclose;
        if (typeof onclose == "function") {
          try {
            onclose.call(Cu.waiveXrays(sandboxHandle));
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
  if (hasGrant(_API1, _API2) || hasGrant(_unreg1, _unreg2)) {
    // Inject MenuCommandSandbox into the sandbox by source.  The function's
    // body — including its two event listeners and its closure-scoped
    // { commands, commandFuncs } maps — ends up running in sandbox
    // compartment, so user callbacks never have to cross an XrayWrapper
    // boundary at click time (see #13; the previous chrome-context
    // listener hit "XrayWrapper denied access to property N (reason:
    // value is callable)" and menu clicks silently did nothing).
    //
    // MenuCommandSandbox is the function's source held as a string (see
    // menuCommand.js): a module function's own toString() can't be trusted
    // in UXP, as GMRequestPromiseSandbox above explains.
    let strings = GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties);
    let menuArgs = [
      aContentWin,
      aScript.uuid, aScript.localized.name, aScript.fileURL,
      MenuCommandRespond,
      strings.GetStringFromName("error.menu.callbackIsNotFunction"),
      strings.GetStringFromName("error.menu.couldNotRun"),
      strings.GetStringFromName("error.menu.invalidAccesskey"),
      MenuCommandEventNameSuffix,
    ];
    if (pageWorld) {
      registerPageWorldMenu(sandbox, api, aContentWin, menuArgs);
    } else {
      Cu.evalInSandbox(
          "this._MenuCommandSandbox = " + MenuCommandSandbox, sandbox);
      sandbox._MenuCommandSandbox(...menuArgs);
      // MenuCommandSandbox's closure is what keeps commands/commandFuncs
      // alive; the global reference was just a transport vehicle.
      Cu.evalInSandbox(
          "delete this._MenuCommandSandbox;", sandbox);
    }
  }

  _API1 = "GM_setClipboard";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    api[_API1] = GM_setClipboard.bind(
        null, aContentWin, aScript.fileURL);
  }

  // See #2538 (an alternative).
  // Also accept @grant window.close / window.focus (Tampermonkey/VM compat).
  _API1 = "GM_windowClose";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)
      || aScript.grants.includes("window.close")) {
    api[_API1] = GM_window.bind(
        null, aContentWin, aScript.fileURL, "close");
  }
  _API1 = "GM_windowFocus";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)
      || aScript.grants.includes("window.focus")) {
    api[_API1] = GM_window.bind(
        null, aContentWin, aScript.fileURL, "focus");
  }

  _API1 = "GM_xmlhttpRequest";
  _API2 = _API1.replace(
      API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
  if (hasGrant(_API1, _API2)) {
    {
      let _xhr = new GM_xmlHttpRequester(
          aContentWin, sandbox, aScript.fileURL, aUrl, aScript.connects);
      api[_API1] = _xhr.contentStartRequest.bind(_xhr);
    }
  }

  // See #2129.
  Object.getOwnPropertyNames(api).forEach(function (aProp) {
    if (aProp.indexOf(GM_CONSTANTS.addonAPIPrefix1) == 0) {
      // Only re-clone CALLABLE GM_* APIs.  The GM_cookie methods-object is
      // not a function: cloning it through the chrome Xray view strips its
      // callable .list/.set/.delete expandos (XrayWrapper denies callable
      // properties), which broke GM_cookie.* at runtime.  It is already a
      // proper sandbox object (createObjectIn + exportFunction), so leave
      // it untouched.
      if (typeof api[aProp] !== "function") {
        return undefined;
      }
      api[aProp] = Cu.cloneInto(
          api[aProp], sandbox, {
            "cloneFunctions": true,
            "wrapReflectors": true,
          });
    }
  });

  // GM_download is a native chrome-side callable built on
  // nsIWebBrowserPersist + nsIFilePicker (modules/GM_download.js) and has
  // no dependency on GM_xmlhttpRequest; scripts that need XHR must @grant
  // it explicitly.
  //
  // No special-case is needed in buildGMObject — GM_download is a callable
  // (typeof === "function"), so the main loop's Promise wrapping picks it
  // up automatically as GM.download.
  if (GM_prefRoot.getValue("api.GM_download")) {
    _API1 = "GM_download";
    _API2 = _API1.replace(
        API_PREFIX_REGEXP, GM_CONSTANTS.addonAPIPrefix2 + "$2");
    if (hasGrant(_API1, _API2)) {
      api[_API1] = createGMDownloadAPI(
          aContentWin, sandbox, aScript.fileURL, aUrl);
    }
  }

  if (pageWorld) {
    preparePageWorld(sandbox, api, aContentWin, aScript, realUnsafeWindow);
    return sandbox;
  }

  // GM_info is always provided.
  injectGMInfo(sandbox, aContentWin, aScript, "content");

  installUrlChangeSupport(sandbox);

  return sandbox;
}

/**
 * The principal of a sandbox in the page's world (@grant none, or injected
 * into the page): the page's own, except on a page whose Content Security
 * Policy forbids eval.  There, a principal of the same origin but without
 * that policy, so the script's own eval and new Function work, as they do
 * in the classic sandbox (the policy belongs to a principal, and its eval
 * check goes by the running code's).  The page can still use what the
 * script makes (same origin), and what the script puts into the page
 * (<script> elements...) still follows the page's policy.
 *
 * Not where the page has set document.domain (seen as a document.domain
 * other than its host): a principal without it would no longer count as
 * the page's origin.  Not for a page whose own principal isn't an ordinary
 * one (a sandboxed frame's null principal).  Whatever goes wrong, the
 * page's own.
 *
 * @param {Window} aContentWin
 * @returns {nsIPrincipal|Window} What Cu.Sandbox takes.
 */
function pageWorldPrincipal(aContentWin) {
  try {
    let doc = aContentWin.document;
    let principal = doc.nodePrincipal;
    if (!principal.isCodebasePrincipal || !principal.URI
        || (doc.domain != principal.URI.host)
        || !pageForbidsEval(aContentWin)) {
      return aContentWin;
    }
    return Services.scriptSecurityManager.createCodebasePrincipal(
        principal.URI, principal.originAttributes);
  } catch (e) {
    return aContentWin;
  }
}

/**
 * Whether the page's Content Security Policy forbids eval: a policy whose
 * script-src (else default-src) lacks 'unsafe-eval', from its response
 * header or a <meta http-equiv>.  Read there because UXP gives chrome code
 * no way to ask a principal for its policy.  (A report-only policy forbids
 * nothing; a <meta> the page hasn't reached yet, at document-start, isn't
 * seen, nor in force yet.)
 *
 * @param {Window} aContentWin
 * @returns {boolean}
 */
function pageForbidsEval(aContentWin) {
  let policies = [];
  try {
    let channel = aContentWin.QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebNavigation)
        .QueryInterface(Ci.nsIDocShell)
        .currentDocumentChannel.QueryInterface(Ci.nsIHttpChannel);
    policies = channel.getResponseHeader("Content-Security-Policy")
        .split(",");
  } catch (e) {
    // No such header, or not loaded over HTTP.
  }
  try {
    let metas = aContentWin.document.querySelectorAll("meta[http-equiv]");
    for (let i = 0; i < metas.length; i++) {
      if (/^\s*content-security-policy\s*$/i.test(
          metas[i].getAttribute("http-equiv"))) {
        policies.push(metas[i].getAttribute("content") || "");
      }
    }
  } catch (e) {
    // No document yet.
  }
  return policies.some(function (aPolicy) {
    let directives = {};
    aPolicy.split(";").forEach(function (aDirective) {
      let parts = aDirective.trim().split(/\s+/);
      let name = parts.shift().toLowerCase();
      // The first of a name counts, as in a browser.
      if (name && !directives.hasOwnProperty(name)) {
        directives[name] = parts;
      }
    });
    let sources = directives["script-src"] || directives["default-src"];
    return !!sources && !sources.some(function (aSource) {
      return aSource.toLowerCase() == "'unsafe-eval'";
    });
  });
}

/** See windowMethodNames. */
var gWindowMethodNames = null;

/**
 * The platform's window methods (alert, addEventListener, setTimeout...),
 * comma-separated, for PageWindowSandbox.  Read once, through the X-ray
 * view, which shows the platform's own members even where the page has
 * replaced them, and none of the page's.
 *
 * @param {Window} aContentWin - Any content window (X-ray).
 * @returns {string}
 */
function windowMethodNames(aContentWin) {
  if (gWindowMethodNames === null) {
    let names = new Set();
    for (let object = aContentWin; object;
        object = Object.getPrototypeOf(object)) {
      Object.getOwnPropertyNames(object).forEach(function (aName) {
        let desc = Object.getOwnPropertyDescriptor(object, aName);
        if (desc && (typeof desc.value == "function")
            && /^[a-z]/.test(aName)) {
          names.add(aName);
        }
      });
    }
    gWindowMethodNames = Array.from(names).join(",");
  }
  return gWindowMethodNames;
}

/**
 * Completes a page-world sandbox's APIs (see this file's header) and keeps
 * them for runScriptInSandbox: GM_info; `window`, the wrapper of the real
 * window (PageWindowSandbox), with its other names (self, frames,
 * globalThis, and top / parent when they are this window), which the
 * script gets as local variables; and unsafeWindow, the real window.
 *
 * @param {Sandbox}   aSandbox
 * @param {Object}    aApis       - The script's GM APIs, name -> value.
 * @param {Window}    aContentWin
 * @param {IPCScript} aScript
 * @param {boolean}   aRealUnsafeWindow - Whether unsafeWindow is the real
 *   window (else, under api.unsafeWindow.grant without the grant, it is
 *   the script's window, as in the classic sandbox).
 */
function preparePageWorld(
    aSandbox, aApis, aContentWin, aScript, aRealUnsafeWindow) {
  let pageWindow = Cu.evalInSandbox("(" + PageWindowSandbox + ")", aSandbox)(
      aSandbox, aContentWin, windowMethodNames(aContentWin));
  aApis.window = pageWindow;
  aApis.self = pageWindow;
  aApis.frames = pageWindow;
  aApis.globalThis = pageWindow;
  if (aContentWin.top == aContentWin) {
    aApis.top = pageWindow;
  }
  if (aContentWin.parent == aContentWin) {
    aApis.parent = pageWindow;
  }
  aApis.unsafeWindow = aRealUnsafeWindow ? aContentWin : pageWindow;

  // GM_info is always provided.
  aApis.GM_info = makeGMInfo(aSandbox, aContentWin, aScript, "page");

  installPageWorldUrlChangeSupport(aSandbox, aContentWin, pageWindow);

  // The page's objects are instances of its Array, Promise... too.
  shareInstanceof(aSandbox, aContentWin);

  gPageWorldApis.set(aSandbox, aApis);
}

/**
 * GM_registerMenuCommand / GM_unregisterMenuCommand in the page's world.
 * MenuCommandSandbox listens for the menu's events itself, which in the
 * page's world would go through the page's addEventListener, stopPropagation
 * and detail, all of which the page can replace: it would learn the
 * events' secret names and get the listeners.  So the listening happens
 * here, through the X-ray view, and the sandbox side gets an object with
 * only the event's detail and its two stop methods.
 *
 * @param {Sandbox} aSandbox
 * @param {Object}  aApis     - Gets the two functions.
 * @param {Window}  aContentWin
 * @param {Array}   aMenuArgs - MenuCommandSandbox's arguments.
 */
function registerPageWorldMenu(aSandbox, aApis, aContentWin, aMenuArgs) {
  let listen = function (aType, aListener, aCapture) {
    aContentWin.addEventListener(aType, function (aEvent) {
      aListener(Cu.cloneInto({
        "detail": aEvent.detail,
        "stopImmediatePropagation": function () {
          aEvent.stopImmediatePropagation();
        },
        "stopPropagation": function () {
          aEvent.stopPropagation();
        },
      }, aSandbox, {"cloneFunctions": true}));
    }, aCapture);
  };
  let args = aMenuArgs.slice();
  args[0] = Cu.cloneInto(
      {"addEventListener": listen}, aSandbox, {"cloneFunctions": true});
  args[4] = Cu.exportFunction(args[4], aSandbox);
  let holder = Cu.createObjectIn(aSandbox);
  // Called with the holder as `this`, where it defines the two functions.
  Cu.evalInSandbox(
      "(function (aHolder) {"
      + " var define = " + MenuCommandSandbox + ";"
      + " return function () { return define.apply(aHolder, arguments); };"
      + "})", aSandbox)(holder)(...args);
  let waived = Cu.waiveXrays(holder);
  aApis.GM_registerMenuCommand = waived.GM_registerMenuCommand;
  aApis.GM_unregisterMenuCommand = waived.GM_unregisterMenuCommand;
}

/**
 * window.onurlchange in the page's world.  The script's `window` keeps its
 * own onurlchange (set on the sandbox's global, null until it sets one, as
 * Tampermonkey's support check expects); this listener, added through the
 * X-ray view so the page can't take it, calls it on each "urlchange" event
 * with the event's `url` set.  The classic sandbox's way is
 * installUrlChangeSupport.
 *
 * @param {Sandbox} aSandbox
 * @param {Window}  aContentWin
 * @param {Proxy}   aPageWindow - The script's window, the handler's `this`.
 */
function installPageWorldUrlChangeSupport(aSandbox, aContentWin, aPageWindow) {
  if (!GM_prefRoot.getValue("api.window.onurlchange", true)) {
    return undefined;
  }
  try {
    Object.defineProperty(aSandbox, "onurlchange", {
      "configurable": true, "enumerable": true,
      "value": null, "writable": true,
    });
    aContentWin.addEventListener("urlchange", function (aEvent) {
      // Its own only: once deleted, a read would find the page's.
      let handler = Object.prototype.hasOwnProperty.call(
          aSandbox, "onurlchange") ? aSandbox.onurlchange : null;
      if (typeof handler != "function") {
        return undefined;
      }
      try {
        Cu.waiveXrays(aEvent).url = aEvent.detail.url;
      } catch (e) {
        // No detail: the handler still runs.
      }
      Reflect.apply(handler, aPageWindow, [aEvent]);
      return undefined;
    }, true);
  } catch (e) {
    // The page is gone: no support.
  }
  return undefined;
}

/**
 * window.onurlchange for a sandbox with GM APIs.  Its `window` is an X-ray
 * view of the page, which shows neither the page's onurlchange sentinel
 * (scriptInjector.js setupUrlChangeMonitor) nor a handler this script
 * assigns, so `window.onurlchange === null` was false and the handler
 * never ran.  This gives the sandbox its own property (an X-ray expando,
 * seen by this sandbox only) and calls it on each "urlchange" event; it
 * also sets the event's `url`, which Tampermonkey scripts read.  Added
 * before the script runs, so this listener comes first.
 *
 * @param {Sandbox} aSandbox
 * @returns {void}
 */
function installUrlChangeSupport(aSandbox) {
  if (!GM_prefRoot.getValue("api.window.onurlchange", true)) {
    return undefined;
  }
  try {
    Cu.evalInSandbox(
        "(function () {"
        + "  Object.defineProperty(window, \"onurlchange\", {"
        + "    \"configurable\": true, \"enumerable\": true,"
        + "    \"value\": null, \"writable\": true});"
        + "  window.addEventListener(\"urlchange\", function (aEvent) {"
        + "    try { aEvent.url = aEvent.detail.url; } catch (e) {}"
        + "    var handler = window.onurlchange;"
        + "    if (typeof handler == \"function\") {"
        + "      handler.call(window, aEvent);"
        + "    }"
        + "  }, true);"
        + "})();", aSandbox);
  } catch (e) {
    // The page is gone, or its window refuses the property: no support.
  }
  return undefined;
}

/**
 * Injects the GM_info object into the sandbox's global.
 * GM_info is always provided regardless of @grant list.
 *
 * Security: uses Reflect.set({}, key, value, sandbox) rather than
 * sandbox[key] = value to create an own property directly on the sandbox,
 * bypassing any inherited setter from the content window prototype chain.
 *
 * @param {Cu.Sandbox} aSandbox    - The sandbox to inject GM_info into.
 * @param {Window}     aContentWin - Content window (used for privacy check).
 * @param {IPCScript}  aScript     - Script descriptor; info() provides the data.
 * @param {string}     aRealm      - Where the script runs, for
 *   GM_info.injectInto: "page" or "content".
 */
function injectGMInfo(aSandbox, aContentWin, aScript, aRealm) {
  let info = makeGMInfo(aSandbox, aContentWin, aScript, aRealm);
  if (info) {
    Reflect.set({}, "GM_info", info, aSandbox);
  }
}

/**
 * The GM_info object, made in the sandbox.
 *
 * GM_info.injectInto is where the script actually runs, "page" or
 * "content", as in Violentmonkey (never "auto").
 *
 * Adds two lazy string getters on the GM_info object:
 *   scriptSource  — full source text of the script file (read on demand).
 *   scriptMetaStr — the ==UserScript== metadata block text (read on demand).
 *
 * Makes none in environments where the sandbox content level is too
 * high for safe property definition (e10s / multiprocess safety check).
 *
 * @param {Cu.Sandbox} aSandbox
 * @param {Window}     aContentWin
 * @param {IPCScript}  aScript
 * @param {string}     aRealm - "page" or "content".
 * @returns {Object|undefined} The sandbox's GM_info.
 */
function makeGMInfo(aSandbox, aContentWin, aScript, aRealm) {
  let _gEnvironment = GM_util.getEnvironment();
  if ((_gEnvironment.e10s
        && ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 1)))
        || ((_gEnvironment.sandboxContentLevel != null)
            && (_gEnvironment.sandboxContentLevel > 2))) {
    return undefined;
  }

  var scriptInfoRaw = aScript.info();
  var scriptFileURL = aScript.fileURL;

  scriptInfoRaw.injectInto = aRealm;
  scriptInfoRaw.isIncognito = GM_util.windowIsPrivate(aContentWin);
  scriptInfoRaw.isPrivate = scriptInfoRaw.isIncognito;

  // userAgent: the navigator.userAgent of the page the script is
  // running in.  Matches Tampermonkey / Violentmonkey's GM_info.userAgent
  // field.  Reads from the content window so any per-domain UA spoof
  // the user has configured is reflected accurately.  Falls back to an
  // empty string if the page navigator isn't accessible (rare; happens
  // on torn-down windows or before navigator is ready).
  try {
    scriptInfoRaw.userAgent = String(aContentWin.navigator.userAgent || "");
  } catch (e) {
    scriptInfoRaw.userAgent = "";
  }

  // TODO:
  // Also delay top level clone via lazy getter (XPCOMUtils.defineLazyGetter)?
  var info = Cu.cloneInto(scriptInfoRaw, aSandbox);
  var waivedInfo = Cu.waiveXrays(info);
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

  return info;
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
   * Wrapper around evalWithWrapper that catches all errors and logs them
   * cleanly.  Returns a boolean for callers who want to know whether the
   * eval succeeded, but the script-body path at the end ignores it,
   * and the @require loop now treats each failure as isolated — matching
   * Violentmonkey's gm-api-wrapper semantics where one @require throwing
   * does not abort the rest of the chain.
   *
   * @param {string} aUrl - URL to load.
   * @returns {boolean} True on success, false if an error was thrown.
   */
  function evalWithCatch(aUrl) {
    try {
      evalWithWrapper(aUrl);
    } catch (e) {
      GM_util.logError(e, false, e.fileName, e.lineNumber);
      return false;
    }
    return true;
  }

  // GM.* methods that return their value directly, as in Violentmonkey,
  // because scripts use it at once:
  //   - addElement / addStyle: the Element, which scripts chain calls on
  //     (.appendChild, .style.X = Y); TM, VM and upstream Greasemonkey
  //     4.11+ all return it synchronously.
  //   - openInTab: the tab handle (GM.openInTab(u).close()).
  //   - registerMenuCommand / addValueChangeListener: the id that
  //     GM.unregisterMenuCommand / GM.removeValueChangeListener take.
  // `await GM.x(...)` still works: awaiting a non-Promise gives the value.
  // `GM.x(...).then(...)` does not, as in VM.  No one-shot `.then` is
  // attached (VM's gm-api.js trick): an expando set from chrome is not
  // visible to the script through the Xray view.
  const SYNC_RETURN_GM_APIS = new Set([
    "GM_addElement", "GM_addStyle", "GM_addValueChangeListener",
    "GM_openInTab", "GM_registerMenuCommand",
  ]);
  // GM.* methods that return a Promise for the response: see
  // GMRequestPromiseSandbox.
  const REQUEST_PROMISE_GM_APIS = new Set(["GM_download", "GM_xmlhttpRequest"]);

  /**
   * Builds the script-facing GM4 surface (the `GM` object exposing
   * GM.getValue / GM.setValue / GM.xmlHttpRequest / etc.) for the given
   * sandbox.
   *
   *   - Uses Cu.createObjectIn + Cu.exportFunction (native chrome →
   *     sandbox object construction).
   *   - Iterates the pre-computed module-level GM_API_MAPPING instead
   *     of rebuilding the legacy→modern map on every call.
   *   - SYNC_RETURN_GM_APIS pass through unchanged.
   *     REQUEST_PROMISE_GM_APIS get the sandbox-side
   *     GMRequestPromiseSandbox wrapper.
   *   - Every other GM.X is a chrome-side closure that returns
   *     `new aSandbox.Promise(...)`, so the script's `await GM.X(...)`
   *     integrates with the sandbox microtask queue.
   *   - Copies GM_info as a direct property (not Promise-wrapped, since
   *     it's the metadata snapshot).
   *   - Freezes the GM object using the sandbox's own Object.freeze so
   *     scripts can't reassign GM.X.
   *
   * @param {Cu.Sandbox} aSandbox - Target sandbox (created by createSandbox()).
   * @param {Object}     aApis    - Where the GM_* APIs are and GM goes: the
   *   sandbox's global, or a page-world script's own object.
   * @param {IPCScript}  aScript  - Script descriptor (for error attribution).
   * @returns {boolean} True on success; false if construction failed (the
   *                    caller aborts the script in that case).
   */
  function buildGMObject(aSandbox, aApis, aScript) {
    try {
      let gmObj = (aApis === aSandbox)
          ? Cu.createObjectIn(aSandbox, { "defineAs": "GM" })
          : Cu.createObjectIn(aSandbox);
      let defineRequestPromise = null;
      // Only the APIs given to this script, its own properties: a @grant
      // none sandbox's global has the page's own window as its prototype,
      // so a plain read ran the page's getters for every GM_* name, and a
      // function the page put there (window.GM_xmlhttpRequest) became the
      // script's GM.xmlHttpRequest.
      let api = function (aName) {
        return Object.prototype.hasOwnProperty.call(aApis, aName)
            ? aApis[aName] : undefined;
      };

      for (let i = 0; i < GM_API_MAPPING.length; i++) {
        let pair = GM_API_MAPPING[i];
        let legacyName = pair[0];
        let modernName = pair[1];
        let legacyFn = api(legacyName);
        if (typeof legacyFn !== "function") {
          // Script didn't @grant this API; skip.
          continue;
        }

        if (SYNC_RETURN_GM_APIS.has(legacyName)) {
          // Pass the function through unchanged: see SYNC_RETURN_GM_APIS.
          Cu.exportFunction(legacyFn, gmObj, { "defineAs": modernName });
          continue;
        }

        if (REQUEST_PROMISE_GM_APIS.has(legacyName)) {
          if (!defineRequestPromise) {
            // The source is a string: see GMRequestPromiseSandbox.
            defineRequestPromise = Cu.evalInSandbox(
                "(" + GMRequestPromiseSandbox + ")", aSandbox);
          }
          defineRequestPromise(gmObj, modernName, legacyFn);
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
      let info = api("GM_info");
      if (typeof info !== "undefined") {
        let infoProp = "GM_info".replace(API_PREFIX_REGEXP, "$2");
        gmObj[infoProp] = info;
      }

      // GM_cookie special-case: sandbox.GM_cookie is a methods-object
      // (.list / .set / .delete) — the GM3 form scripts use as
      // GM_cookie.list(filter, callback).  buildGMObject's main loop
      // skips it because typeof !== "function"; mirror the methods
      // here as GM.cookie.X with Promise wrapping so GM4 scripts can
      // do `await GM.cookie.list({})` etc.
      let cookie = api("GM_cookie");
      if (cookie && (typeof cookie === "object")) {
        let cookieGmObj = Cu.createObjectIn(gmObj, { "defineAs": "cookie" });
        ["list", "set", "delete"].forEach(function (aMethod) {
          // Read the methods through a waived Xray: the cookie object's
          // .list/.set/.delete are callable expandos that the chrome Xray
          // view denies ("value is callable"), so a direct read would see
          // undefined and GM.cookie.* would never be built.
          let method = Cu.waiveXrays(cookie)[aMethod];
          if (typeof method !== "function") return;
          let wrapper = (function (fn) {
            return function gmCookieAsyncWrapper() {
              // Build the argument list as a sandbox-side array.  Passing the
              // chrome `arguments` object straight to the sandbox method made
              // it read `.length` off a privileged object (the security-
              // wrapper warning).  slice.call runs in chrome (chrome reading
              // chrome); the result is then cloned into the sandbox.
              // Only the details: a callback would take the method's errors
              // (GM_cookie.js fail()), and the promise must see them.
              let args = Cu.cloneInto(
                  Array.prototype.slice.call(arguments, 0, 1), aSandbox,
                  { "cloneFunctions": true });
              return new aSandbox.Promise(function (resolve, reject) {
                try {
                  // Clone the result into the sandbox before resolving: it
                  // arrives here as a chrome-side (privileged) object, and
                  // resolving with it directly makes the script's property
                  // access ("value.length" etc.) hit the security wrapper.
                  // Primitives (set -> true, delete -> count) pass through.
                  let result = fn.apply(null, args);
                  resolve(((result !== null) && (typeof result === "object"))
                      ? Cu.cloneInto(result, aSandbox)
                      : result);
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
      // in sandbox scope (the GM object lives in the sandbox compartment).
      try {
        aSandbox.Object.freeze(gmObj);
      } catch (e) {
        // Fallback — extremely rare; would only happen if Object is
        // somehow shadowed in the sandbox prototype chain.
        Cu.evalInSandbox(
            "(function (aGM) { Object.freeze(aGM); })", aSandbox,
            JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1)(gmObj);
      }
      if (aApis !== aSandbox) {
        aApis.GM = gmObj;
      }
    } catch (e) {
      // The error itself goes along: the message alone ("async functions
      // are probably not available") hid what actually went wrong.
      GM_util.logError(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.api.object.polyfill") + "\n" + e,
          false, e.fileName || aScript.fileURL, e.lineNumber || 0);
      return false;
    }
    return true;
  }

  let pageWorldApis = gPageWorldApis.get(aSandbox);
  gPageWorldApis.delete(aSandbox);

  // The pref name still says "polyfill" for backward-compatibility with
  // any user who set it explicitly; the implementation is now native.
  if (GM_prefRoot.getValue("api.object.polyfill")) {
    if (!buildGMObject(aSandbox, pageWorldApis || aSandbox, aScript)) {
      return undefined;
    }
  }

  if (pageWorldApis) {
    runInPageWorld(aSandbox, pageWorldApis, aScript);
    return undefined;
  }

  // @require evaluation: each library is independent.  A failure (404,
  // parse error, uncaught throw) is logged but does NOT abort subsequent
  // @requires or the script body.  This matches Violentmonkey's
  // behaviour and avoids the surprise where a single broken or
  // unreachable dependency would silently kill an otherwise-working
  // userscript.  Shared sandbox state from earlier @requires that did
  // succeed is preserved, so the script body still sees their globals.
  for (let i = 0, iLen = aScript.requires.length; i < iLen; i++) {
    evalWithCatch(aScript.requires[i].fileURL);
  }

  if (aScript.topLevelAwait) {
    // @topLevelAwait: wrap the script in an async IIFE so top-level
    // await is valid.  This matches Violentmonkey's behavior.  The code
    // starts on the wrapper's line, so its errors give its own line
    // numbers (they were one too high).
    try {
      let code = GM_util.fileXhr(
          aScript.fileURL, "application/javascript");
      Cu.evalInSandbox(
          "(async () => {" + code + "\n})();",
          aSandbox, JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1);
    } catch (e) {
      GM_util.logError(e, false, e.fileName, e.lineNumber);
    }
  } else {
    evalWithCatch(aScript.fileURL);
  }
}

/** The page-world script's own function, among its @requires' names. */
const PAGE_WORLD_SCRIPT_NAME = "__greasemonkeyUserScript__";

/** JavaScript's line terminators, for line numbers. */
const LINE_TERMINATORS = /\r\n|[\n\r\u2028\u2029]/;

/** A name the generated source can declare. */
const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

/**
 * Runs a page-world script (see this file's header), as Violentmonkey
 * does: its @requires and itself in one function whose local variables
 * are its GM APIs, its window and that window's other names; define,
 * module and exports are undefined there, so an @require'd library puts
 * itself on that window instead of the page's AMD loader.
 *
 * The APIs reach that function through a property of the sandbox's global
 * with a random name, which its first statement reads and deletes, before
 * the page can run anything; it is deleted here too if the code never ran
 * (a syntax error).  Passing them as arguments would leave them in the
 * function's `arguments`, which page code it calls can read through
 * `caller`.
 *
 * The script comes first in the source, so the line numbers of its errors
 * are its own; it runs last (its function is called after the @requires).
 * The @requires' come after it: an error in one at load time is reported
 * with its own file and line.  As in Violentmonkey, an @require that
 * throws stops the script.
 *
 * @param {Sandbox}   aSandbox
 * @param {Object}    aApis   - name -> value: see gPageWorldApis.
 * @param {IPCScript} aScript
 */
function runInPageWorld(aSandbox, aApis, aScript) {
  let read = function (aUrl) {
    return GM_util.fileXhr(aUrl, "application/javascript");
  };
  let lineCount = function (aCode) {
    return aCode.split(LINE_TERMINATORS).length;
  };

  let code;
  try {
    code = read(aScript.fileURL);
  } catch (e) {
    GM_util.logError(
        "Error loading script " + aScript.fileURL + ":\n" + e,
        false, aScript.fileURL, null);
    return undefined;
  }

  // Where each part starts in the source: [url, first line, lines].
  let parts = [[aScript.fileURL, 1, lineCount(code)]];
  // The script's last line, then "};".
  let line = parts[0][2] + 1;
  let requires = [];
  for (let i = 0, iLen = aScript.requires.length; i < iLen; i++) {
    let url = aScript.requires[i].fileURL;
    let requireCode;
    try {
      requireCode = read(url);
    } catch (e) {
      // As in the classic sandbox, a missing @require is reported and the
      // rest go on.
      GM_util.logError(
          "Error loading @require " + url + ":\n" + e, false, url, null);
      continue;
    }
    parts.push([url, line + 1, lineCount(requireCode)]);
    line += lineCount(requireCode) + 1;
    requires.push(requireCode);
  }

  let names = Object.keys(aApis).filter(function (aName) {
    return IDENTIFIER.test(aName);
  });
  let key = "__gm" + GM_util.uuid().replace(/[^0-9a-z]/gi, "");
  let bag = Cu.createObjectIn(aSandbox);
  let waivedBag = Cu.waiveXrays(bag);
  names.forEach(function (aName) {
    waivedBag[aName] = aApis[aName];
  });

  let source = "(function () {"
      + "var {" + names.join(", ") + "} = " + key + "; delete " + key + ";"
      + " return (function (define, module, exports) {"
      + " var " + PAGE_WORLD_SCRIPT_NAME + " = "
      + (aScript.topLevelAwait ? "async " : "") + "function () {"
      + code
      + "\n};"
      + requires.map(function (aCode) {
        return "\n" + aCode + "\n;";
      }).join("")
      + "\nreturn " + PAGE_WORLD_SCRIPT_NAME + ".call(this);"
      + "\n}).call(window);"
      + "\n})();";

  Object.defineProperty(aSandbox, key, {
    "configurable": true,
    "value": bag,
  });
  try {
    Cu.evalInSandbox(
        source, aSandbox, JAVASCRIPT_VERSION_MAX, aScript.fileURL, 1);
  } catch (e) {
    // Its own file and line, for an error in an @require.  (One raised
    // elsewhere, in a page function the script called, say, has its own.)
    let fileName = (e && e.fileName) || aScript.fileURL;
    let lineNumber = e && e.lineNumber;
    for (let i = parts.length - 1;
        (fileName == aScript.fileURL) && (i > 0); i--) {
      if ((lineNumber >= parts[i][1])
          && (lineNumber < parts[i][1] + parts[i][2])) {
        fileName = parts[i][0];
        lineNumber = lineNumber - parts[i][1] + 1;
        break;
      }
    }
    GM_util.logError(e, false, fileName, lineNumber);
  } finally {
    delete aSandbox[key];
  }
  return undefined;
}
