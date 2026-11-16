/**
 * @file GM_setClipboard.js
 * @overview Implements the GM_setClipboard() API for userscripts.
 *   Based on the Scriptish extension's implementation.
 *
 * Writes text or HTML content to the system clipboard using XPCOM
 * nsIClipboard / nsITransferable.
 *
 * Supported types (via aOptions.type or legacy string argument):
 *   "text" (default) — copies plain text via nsIClipboardHelper.copyString().
 *   "html"           — copies both a text/html flavour AND a text/unicode
 *                      (plain-text fallback) flavour, so paste targets that
 *                      only understand plain text still work.
 *
 * MIME type negotiation:
 *   "text/plain" is normalised to the internal "text/unicode" flavour because
 *   that is what nsITransferable expects on this platform.
 *
 * Option forms (mirrors GM4 spec):
 *   GM_setClipboard(data)                    — text type
 *   GM_setClipboard(data, "text")            — text type (explicit)
 *   GM_setClipboard(data, "html")            — html type
 *   GM_setClipboard(data, { type: "html" })  — html type (object form)
 *   GM_setClipboard(data, { mimetype: "text/html" }) — override MIME directly
 */

// Based on Scriptish:
// https://github.com/scriptish/scriptish/blob/master/extension/modules/api/GM_setClipboard.js

const EXPORTED_SYMBOLS = ["GM_setClipboard"];

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


/**
 * Internal flavour descriptors used with nsITransferable.
 * "text/unicode" is the internal name for plain-text on this platform.
 */
const FLAVOR = {
  "html": {
    "type": "html",
    "mimetype": "text/html",
  },
  "text": {
    "type": "text",
    "mimetype": "text/unicode",
  },
};

/**
 * What a script's second argument asks for: "html", "text", or null for a
 * type the clipboard can't take.  Greasemonkey's "text" / "html", the MIME
 * types Violentmonkey passes ("text/plain", "text/html"; other text/*
 * types copy as text), and the {type, mimetype} object, where mimetype
 * wins.  "text/plain", "text/html" and {mimetype} used to throw.
 *
 * @param {string|object|undefined} aOptions
 * @returns {?string}
 */
function clipboardKind(aOptions) {
  let wanted = "text";
  if ((aOptions !== undefined) && (aOptions !== null)) {
    if (typeof aOptions == "object") {
      if (aOptions.mimetype != null) {
        wanted = aOptions.mimetype;
      } else if (aOptions.type != null) {
        wanted = aOptions.type;
      }
    } else {
      wanted = aOptions;
    }
  }
  wanted = String(wanted).split(";")[0].trim().toLowerCase();
  if ((wanted == "html") || (wanted == "text/html")
      || (wanted == "application/xhtml+xml")) {
    return "html";
  }
  if ((wanted == "text") || (wanted == "") || (wanted.indexOf("text/") == 0)) {
    return "text";
  }
  return null;
}

/**
 * Writes data to the system clipboard.
 *
 * @param {Window}      aWrappedContentWin - The script's content window;
 *   used to throw Error objects with the correct source location.
 * @param {string}      aFileURL           - The script's file URL; included in
 *   thrown Error objects for debuggability.
 * @param {string}      aData              - The text or HTML content to copy.
 * @param {string|object|undefined} aOptions - "text" (the default), "html",
 *   a MIME type, or {type, mimetype}; see clipboardKind().
 * @throws {Error} If the type is not one the clipboard can take.
 */
function GM_setClipboard(aWrappedContentWin, aFileURL, aData, aOptions) {
  let clipboardHelperService = Cc["@mozilla.org/widget/clipboardhelper;1"]
      .getService(Ci.nsIClipboardHelper);
  let clipboardService = Cc["@mozilla.org/widget/clipboard;1"]
      .getService(Ci.nsIClipboard);
  let supportString = Cc["@mozilla.org/supports-string;1"]
      .createInstance(Ci.nsISupportsString);
  let trans = Cc["@mozilla.org/widget/transferable;1"]
      .createInstance(Ci.nsITransferable);
  // The page's load context: what's copied from a private window is
  // treated as private (cleared when the private session ends).
  let loadContext = null;
  try {
    loadContext = aWrappedContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebNavigation)
        .QueryInterface(Ci.nsILoadContext);
  } catch (e) {
    loadContext = null;
  }
  trans.init(loadContext);

  let kind = clipboardKind(aOptions);
  let data = ((typeof aData == "undefined") || (aData === null))
      ? "" : String(aData);

  switch (kind) {
    case "html":
      // Each flavour gets its own string: the transferable keeps the
      // object, so one shared between the two made the HTML flavour plain
      // text as well (pasting into a rich-text editor gave plain text).
      let html = Cc["@mozilla.org/supports-string;1"]
          .createInstance(Ci.nsISupportsString);
      html.data = data;
      trans.addDataFlavor(FLAVOR.html.mimetype);
      trans.setTransferData(FLAVOR.html.mimetype, html, (data.length * 2));

      // Add a text/unicode flavor (html converted to plain text).
      let plain = supportString;
      let converter = Cc["@mozilla.org/feed-textconstruct;1"]
          .createInstance(Ci.nsIFeedTextConstruct);
      converter.type = FLAVOR.html.type;
      converter.text = data;
      plain.data = converter.plainText();
      trans.addDataFlavor(FLAVOR.text.mimetype);
      trans.setTransferData(
          FLAVOR.text.mimetype, plain, (plain.data.length * 2));

      clipboardService.setData(trans, null, clipboardService.kGlobalClipboard);
      break;
    case "text":
      clipboardHelperService.copyString(data);
      break;
    default:
      let unsupportedType = aOptions;
      try {
        unsupportedType = JSON.stringify(aOptions);
      } catch (e) {
        // Ignore.
      }
      throw new aWrappedContentWin.Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.setClipboard.unsupportedType")
              .replace("%1", unsupportedType),
          aFileURL, null);
  }
}
