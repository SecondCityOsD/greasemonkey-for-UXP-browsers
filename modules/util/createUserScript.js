/**
 * @file createUserScript.js
 * @overview "New User Script" entry point shared by the toolbar menu and the
 * about:addons New… menu: auto-names a fresh script and jumps straight into
 * the editor, instead of opening the metadata dialog that demanded a name +
 * namespace up front.
 */

const EXPORTED_SYMBOLS = ["createUserScript"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/parseScript.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Creates a new user script and opens it in the configured editor.
 *
 * The script gets a unique placeholder name ("New User Script N", N from a
 * persisted counter) and a constant "Greasemonkey" namespace, pre-scoped to
 * the active tab's URL; then installScriptFromSource() installs it and opens
 * it in the configured editor (or Scratchpad).  The user renames it by
 * editing @name in the editor — safe, because the on-disk folder + uuid are
 * the stable identity and GM_setValue data is keyed by folder (not name), so
 * a later rename keeps stored values.
 *
 * The classic name/namespace dialog is used instead when the
 * manager.newScript.classicDialog.enabled pref is set (about:config escape
 * hatch), and as the fallback whenever the auto-create path can't work.
 *
 * @param {nsIDOMWindow} aWin - The invoking chrome window: parent for the
 *   classic dialog fallback, and — when it is a browser window — the source
 *   of the active tab the new script is scoped to.
 * @returns {void}
 */
function createUserScript(aWin) {
  if (GM_prefRoot.getValue("manager.newScript.classicDialog.enabled", false)) {
    GM_util.newUserScript(aWin);
    return undefined;
  }

  // A customised template with no %name% placeholder can't be auto-named
  // uniquely; fall back to the classic dialog rather than churn the counter
  // and risk a duplicate (name, namespace).
  if (GM_prefRoot.getValue("newScript.template").indexOf("%name%") === -1) {
    GM_util.newUserScript(aWin);
    return undefined;
  }

  let config = GM_util.getService().config;

  // Default @include to a clearly-inert placeholder so a freshly-created
  // script never silently runs on every site.  If the active tab is a real
  // web page, scope the new script to that site (scheme://host/*) instead.
  // The invoking window is preferred (the toolbar case) so the right tab
  // wins with several browser windows open; about:addons falls back to the
  // most recent browser window.
  let include = "https://example.com/*";
  try {
    let browserWin = (aWin && aWin.gBrowser)
        ? aWin
        : GM_util.getBrowserWindow();
    let uri = browserWin.gBrowser.selectedBrowser.currentURI;
    if (uri && /^https?$/.test(uri.scheme) && uri.host) {
      include = uri.scheme + "://" + uri.host + "/*";
    }
  } catch (e) {
    // Leave the inert placeholder.
  }

  // Bump N (persisted across sessions) until the (name, namespace) pair is
  // unique, so creating several scripts in a row never collides.  The guard
  // caps the search in the pathological all-match case.  If anything throws
  // (e.g. a customised template that no longer parses), fall back to the
  // classic dialog so the menu item still does something useful.
  try {
    let n = GM_prefRoot.getValue("newScript.counter", 0);
    let source;
    let guard = 0;
    do {
      n++;
      guard++;
      source = buildSource("New User Script " + n, "Greasemonkey", include);
    } while (config.installIsUpdate(parse(source)) && (guard < 1000));
    GM_prefRoot.setValue("newScript.counter", n);

    // installScriptFromSource writes the file, runs the install pipeline,
    // and opens the new script in the editor as its final step.
    GM_util.installScriptFromSource(source);
  } catch (e) {
    Cu.reportError(
        "Greasemonkey: auto-create failed, falling back to dialog: " + e);
    GM_util.newUserScript(aWin);
  }
}

/**
 * Assembles a userscript from the user's newScript.template pref: fills the
 * @name / @namespace / @include placeholders and drops the optional
 * @description / @exclude lines (honouring newScript.removeUnused, exactly
 * as the classic New Script dialog does).  split()/join() is used instead of
 * String.replace so a '$' in a substituted value can't be misread as a
 * replacement pattern.
 *
 * @param {string} aName      - Value for the %name% placeholder.
 * @param {string} aNamespace - Value for the %namespace% placeholder.
 * @param {string} aInclude   - Value for the %include% placeholder.
 * @returns {string} The assembled script source.
 */
function buildSource(aName, aNamespace, aInclude) {
  let source = GM_prefRoot.getValue("newScript.template");
  let removeUnused = GM_prefRoot.getValue("newScript.removeUnused");

  source = source.split("%name%").join(aName);
  source = source.split("%namespace%").join(aNamespace);
  source = source.split("%include%").join(aInclude);

  if (removeUnused) {
    source = source.replace(/^\/\/[ \t]*@description.*\n?/im, "");
    source = source.replace(/^\/\/[ \t]*@exclude.*\n?/im, "");
  } else {
    source = source.split("%description%").join("");
    source = source.split("%exclude%").join("");
  }

  if (GM_util.getEnvironment().osWindows) {
    source = source.replace(/\n/g, "\r\n");
  }
  return source;
}
