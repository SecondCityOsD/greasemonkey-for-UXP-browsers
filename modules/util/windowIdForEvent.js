/**
 * @file windowIdForEvent.js
 * @overview Extracts the window ID from a DOM event whose originalTarget is an
 * HTML document, returning null for non-document targets.
 */

const EXPORTED_SYMBOLS = ["windowIdForEvent"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Returns the window ID for the content window associated with a DOM event.
 * @param {Event} aEvent - The DOM event whose originalTarget must be an nsIDOMHTMLDocument.
 * @returns {number|null} The window ID for the event's document view, or null if the target is not an HTML document.
 */
function windowIdForEvent(aEvent) {
  let doc = aEvent.originalTarget;
  try {
    doc.QueryInterface(Ci.nsIDOMHTMLDocument);
  } catch (e) {
    return null;
  }

  return GM_util.windowId(doc.defaultView);
}
