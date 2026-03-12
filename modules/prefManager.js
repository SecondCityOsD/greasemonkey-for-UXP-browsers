/**
 * @file prefManager.js
 * @overview Thin wrapper around the Firefox/UXP preferences service
 *   (nsIPrefService) for Greasemonkey.
 *
 * All preferences live under the "extensions.greasemonkey." branch.
 * GM_PrefManager instances can be scoped to a sub-branch by passing a
 * start-point string to the constructor.
 *
 * A shared root instance (GM_prefRoot) is exported for modules that need
 * to read top-level Greasemonkey preferences without constructing their own.
 *
 * Supported value types: boolean, integer (32-bit signed), string.
 */

const EXPORTED_SYMBOLS = ["GM_PrefManager", "GM_prefRoot"];

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
 * Simple API on top of preferences for Greasemonkey.
 * Construct an instance by passing the start-point of a preferences subtree.
 * The "extensions.greasemonkey." prefix is prepended automatically.
 *
 * @constructor
 * @param {string} [aStartPoint=""] - Sub-branch suffix, e.g. "scriptvals."
 *   to scope this manager to extensions.greasemonkey.scriptvals.
 */
function GM_PrefManager(aStartPoint) {
  aStartPoint = "extensions.greasemonkey." + (aStartPoint || "");

  this.pref = Cc["@mozilla.org/preferences-service;1"]
      .getService(Ci.nsIPrefService)
      .getBranch(aStartPoint);

  this.observers = new Map();
};

/** Minimum value accepted for integer preferences (−2 147 483 648). */
GM_PrefManager.prototype.MIN_INT_32 = -0x80000000;
/** Maximum value accepted for integer preferences (2 147 483 647). */
GM_PrefManager.prototype.MAX_INT_32 = 0x7FFFFFFF;
/** Cached reference to nsISupportsString interface, used for string prefs. */
GM_PrefManager.prototype.nsISupportsString = Ci.nsISupportsString;

/**
 * Whether a preference exists in this branch.
 *
 * @param {string} aPrefName - Preference name relative to this branch.
 * @returns {boolean}
 */
GM_PrefManager.prototype.exists = function (aPrefName) {
  return this.pref.getPrefType(aPrefName) != 0;
};

/**
 * Returns the names of all preferences in this branch.
 *
 * @returns {string[]} Array of preference name strings.
 */
GM_PrefManager.prototype.listValues = function () {
  return this.pref.getChildList("", {});
};

/**
 * Returns the value of a preference, or aDefaultValue if it does not exist.
 *
 * @param {string} aPrefName      - Preference name relative to this branch.
 * @param {*}      [aDefaultValue] - Value to return when the pref is missing.
 * @returns {boolean|number|string|null}
 */
GM_PrefManager.prototype.getValue = function (aPrefName, aDefaultValue) {
  let prefType = this.pref.getPrefType(aPrefName);

  // underlying preferences object throws an exception if pref doesn't exist
  if (prefType == this.pref.PREF_INVALID) {
    return aDefaultValue;
  }

  try {
    switch (prefType) {
      case this.pref.PREF_STRING:
        return this.pref.getComplexValue(
            aPrefName, this.nsISupportsString).data;
      case this.pref.PREF_BOOL:
        return this.pref.getBoolPref(aPrefName);
      case this.pref.PREF_INT:
        return this.pref.getIntPref(aPrefName);
    }
  } catch (e) {
    return (typeof aDefaultValue != "undefined") ? aDefaultValue : null;
  }

  return null;
};

/**
 * Sets a preference to the given value.
 * Accepted types: boolean, string, integer (32-bit signed only).
 * If the existing pref has a different type it is deleted first to avoid
 * a type-mismatch exception from the underlying preferences service.
 *
 * @param {string}              aPrefName - Preference name relative to this branch.
 * @param {boolean|number|string} aValue  - New value.
 * @throws {Error} If aValue is not a supported type or is an out-of-range number.
 */
GM_PrefManager.prototype.setValue = function (aPrefName, aValue) {
  let prefType = typeof aValue;
  let goodType = false;

  switch (prefType) {
    case "boolean":
    case "string":
      goodType = true;
      break;
    case "number":
      if (((aValue % 1) == 0)
          && (aValue >= this.MIN_INT_32)
          && (aValue <= this.MAX_INT_32)) {
        goodType = true;
      }
      break;
  }

  if (!goodType) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.setValue.unsupportedType"));
  }

  // Underlying preferences object throws an exception if new pref has
  // a different type than old one. i think we should not do this,
  // so delete old pref first if this is the case.
  if (this.exists(aPrefName) && (typeof this.getValue(aPrefName) != prefType)) {
    this.remove(aPrefName);
  }

  // Set new value using correct method.
  switch (prefType) {
    case "boolean":
      this.pref.setBoolPref(aPrefName, aValue);
      break;
    case "number":
      this.pref.setIntPref(aPrefName, Math.floor(aValue));
      break;
    case "string":
      let str = Cc["@mozilla.org/supports-string;1"]
          .createInstance(this.nsISupportsString);
      str.data = aValue;
      this.pref.setComplexValue(aPrefName, this.nsISupportsString, str);
      break;
  }
};

/**
 * Deletes a preference or an entire sub-branch.
 *
 * @param {string} aPrefName - Preference name or branch suffix to delete.
 */
GM_PrefManager.prototype.remove = function (aPrefName) {
  this.pref.deleteBranch(aPrefName);
};

/**
 * Registers a callback to be invoked whenever a preference in the named
 * subtree changes.  The callback receives the changed preference name.
 *
 * @param {string}   aPrefName - Preference name or branch prefix to observe.
 * @param {function} aWatcher  - Called with (aPrefName) whenever the pref changes.
 */
GM_PrefManager.prototype.watch = function (aPrefName, aWatcher) {
  // Construct an observer.
  let observer = {
    "observe": function (aSubject, aTopic, aPrefName) {
      aWatcher(aPrefName);
    },
  };

  // Store the observer in case we need to remove it later.
  this.observers.set(aWatcher, observer);

  this.pref.QueryInterface(Ci.nsIPrefBranchInternal)
      .addObserver(aPrefName, observer, false);
};

/**
 * Unregisters a previously registered preference observer.
 *
 * @param {string}   aPrefName - Same prefix passed to watch().
 * @param {function} aWatcher  - The exact function reference passed to watch().
 */
GM_PrefManager.prototype.unwatch = function (aPrefName, aWatcher) {
  let observer = this.observers.get(aWatcher);
  if (observer) {
    this.observers.delete(aWatcher);
    this.pref.QueryInterface(Ci.nsIPrefBranchInternal)
        .removeObserver(aPrefName, observer);
  }
};

/**
 * Shared root-level preferences manager for the "extensions.greasemonkey."
 * branch.  Imported by other modules that need global Greasemonkey prefs.
 *
 * @type {GM_PrefManager}
 */
var GM_prefRoot = new GM_PrefManager();
