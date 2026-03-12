/**
 * @file timeout.js
 * @overview Schedules a one-shot callback after a delay using nsITimer,
 * keeping a reference to prevent the timer from being garbage-collected early.
 */

const EXPORTED_SYMBOLS = ["timeout"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}


/**
 * Calls aCallback once after aDelay milliseconds, using nsITimer to avoid garbage-collection issues.
 * @param {Function} aCallback - The function to invoke after the delay.
 * @param {number} aDelay - Delay in milliseconds before invoking the callback.
 * @returns {void}
 */
function timeout(aCallback, aDelay) {
  // Create the timer object.
  var timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);

  // https://bugzil.la/647998
  // The timer object may be garbage collected before it fires,
  // so we need to keep a reference to it alive.
  // However, simply creating a closure over the timer object
  // without using it may not be enough, as the timer might
  // get optimized out of the closure scope (https://bugzil.la/640629#c9).
  // To work around this, the timer object
  // is explicitly stored as a property of the observer.
  let observer = {
    "observe": function () {
      delete observer.timer;
      aCallback();
    },
    "timer": timer,
  };

  timer.init(observer, aDelay, Ci.nsITimer.TYPE_ONE_SHOT);
}
