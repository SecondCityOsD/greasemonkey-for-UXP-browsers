/**
 * @file documentObserver.js
 * @overview Observes the creation of new documents (page loads / frame loads)
 *   and notifies registered callbacks so that Greasemonkey can inject scripts
 *   at the right moment.
 *
 * Two observer topics are supported (see bug #1849):
 *   - "content-document-global-created"  — fires earlier, used when the
 *     "load.earlier" preference is set.
 *   - "document-element-inserted"        — the default, fires when the
 *     <html> element has been created but before the document is fully parsed.
 *
 * Usage:
 *   onNewDocument(aTopWindow, aCallback)
 *   // aCallback(win) is called for every sub-document under aTopWindow.
 */

"use strict";

const EXPORTED_SYMBOLS = ["onNewDocument"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


// See #1849.
const OBSERVER_TOPIC_1 = "content-document-global-created";
const OBSERVER_TOPIC_2 = "document-element-inserted";

/**
 * WeakMap from a top-level window to its registered callback.
 * Using a WeakMap means the entry is automatically collected when the
 * window is closed, preventing memory leaks.
 * @type {WeakMap<Window, function>}
 */
var callbacks = new WeakMap();

/**
 * Registers a callback to be invoked whenever a new document is created
 * inside the given top-level window (including iframes).
 *
 * @param {Window}   aTopWindow - The top-level content window to watch.
 * @param {function} aCallback  - Called with the new (sub-)window as its
 *                                sole argument each time a document is created.
 */
function onNewDocument(aTopWindow, aCallback) {
  callbacks.set(aTopWindow, aCallback);
}

/**
 * nsIObserver that receives document-creation notifications from the
 * Services.obs notification system.  Both supported topics are registered
 * at module load time; the active one is chosen at runtime based on the
 * "load.earlier" preference.
 */
let contentObserver = {
  /**
   * Called by the observer service for each document-creation notification.
   *
   * @param {nsISupports} aSubject - The new window (topic 1) or document (topic 2).
   * @param {string}      aTopic   - The observer topic string.
   * @param {string|null} aData    - Extra data; for topic 1, "null" string
   *                                 indicates an about:blank frame.
   */
  "observe": function (aSubject, aTopic, aData) {
    if (!GM_util.getEnabled()) {
      return undefined;
    }

    let observerTopic = OBSERVER_TOPIC_2;
    if (GM_prefRoot.getValue("load.earlier")) {
      observerTopic = OBSERVER_TOPIC_1;
    }

    switch (aTopic) {
      case observerTopic:
        let doc;
        let win;
        switch (aTopic) {
          case OBSERVER_TOPIC_1:
            // aData != "null" - because of the page "about:blank".
            doc = aData && (aData != "null");
            win = aSubject;

            break;
          case OBSERVER_TOPIC_2:
            doc = aSubject;
            win = doc && doc.defaultView;

            break;
        }

        if (!doc || !win) {
          return undefined;
        }

        let topWin = win.top;

        let frameCallback = callbacks.get(topWin);
        if (!frameCallback) {
          return undefined;
        }

        frameCallback(win);

        break;
      default:
        /*
        dump("contentObserver" + " - "
            + "Content frame observed unknown topic: " + aTopic + "\n");
        */

        break;
    }
  },
};

Services.obs.addObserver(contentObserver, OBSERVER_TOPIC_1, false);
Services.obs.addObserver(contentObserver, OBSERVER_TOPIC_2, false);
