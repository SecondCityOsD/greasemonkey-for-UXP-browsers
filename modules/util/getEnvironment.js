/**
 * @file getEnvironment.js
 * @overview Detects the current runtime environment including e10s status,
 * operating system, and content sandbox level.
 */

const EXPORTED_SYMBOLS = ["getEnvironment"];

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

Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Detects the current browser runtime environment.
 * @returns {{e10s: boolean, osLinux: boolean, osMac: boolean, osWindows: boolean, sandboxContentLevel: number|null}}
 *   An object with flags for multiprocess mode, OS type, and content sandbox level.
 */
function getEnvironment() {
  let e10s = false;

  let _os = {
    "linux": "Linux",
    "mac": "Darwin",
    "windows": "WINNT",
  };
  let os = {
    "linux": false,
    "mac": false,
    "windows": false,
  };

  let _sandboxContentLevel = "security.sandbox.content.level";
  let sandboxContentLevel = null;

  try {
    e10s = GM_CONSTANTS.xulRuntime.processType
        !== GM_CONSTANTS.xulRuntime.PROCESS_TYPE_DEFAULT;
  } catch (e) {
    // Ignore.
  }

  try {
    switch (GM_CONSTANTS.xulRuntime.OS) {
      case _os.linux:
        os.linux = true;
        break;
      case _os.mac:
        os.mac = true;
        break;
      case _os.windows:
        os.windows = true;
        break;
    }
  } catch (e) {
    // Ignore.
  }

  if (Services.prefs.getPrefType(_sandboxContentLevel) != 0) {
    sandboxContentLevel = Services.prefs.getIntPref(_sandboxContentLevel);
  }

  return {
    "e10s": e10s,
    "osLinux": os.linux,
    "osMac": os.mac,
    "osWindows": os.windows,
    "sandboxContentLevel": sandboxContentLevel,
  };
}
