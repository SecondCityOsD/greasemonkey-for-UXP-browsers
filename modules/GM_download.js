/**
 * @file GM_download.js
 * @overview Native chrome-side GM_download / GM.download implementation.
 *
 * Replaces the historical script-side polyfill
 * (modules/thirdParty/GM_download.js) which fetched the URL with
 * GM_xmlhttpRequest, wrapped the response in a Blob, and triggered
 * the browser's save dialog by clicking a synthetic <a download>
 * anchor in the page DOM.  That implementation had several issues:
 *
 *   - It mutated the page DOM (transient <a>, runtime blob: URL).
 *   - It made the whole download flow go through XHR, double-buffering
 *     the file in memory before disk write.
 *   - It depended on GM_xmlhttpRequest implicitly; sandbox.js auto-
 *     injected GM_xmlhttpRequest whenever GM_download was granted,
 *     which leaked an extra API surface to scripts that did not
 *     explicitly @grant it.
 *   - It could not honour `details.saveAs` (no file picker).
 *
 * The native version uses nsIWebBrowserPersist for the actual fetch +
 * save (streamed to disk, no in-memory buffering, respects the page's
 * cookies and privacy context) and nsIFilePicker for the saveAs UI.
 * Each download is also registered with nsIDownloadManager so it
 * appears in Pale Moon's Downloads window with source / target /
 * progress and a Cancel button that talks back to persist.cancelSave.
 *
 * API shape (matches Tampermonkey / Violentmonkey / GM4):
 *
 *   handle = GM_download(details)
 *   handle = GM_download(url, name)
 *
 *   details = {
 *     url:      string (required),
 *     name:     string (filename to save as),
 *     saveAs:   bool   (force file picker; default: silent download),
 *     onload:      fn,
 *     onerror:     fn,
 *     onabort:     fn,
 *     onprogress:  fn,   // { done, total, loaded, totalSize, lengthComputable }
 *     ontimeout:   fn,
 *   }
 *
 *   handle.abort()   // cancels an in-flight download
 *
 *   await GM.download(details)   // Promise wrapper added by buildGMObject
 *
 * Safety: the address may be http(s), ftp, data or blob (resolved against
 * the page); the name may name subfolders of Downloads but never leave
 * it (fileNameParts); executable types are refused
 * (NAME_EXTENSION_BLACKLIST); and a silent download never replaces an
 * existing file (uniqueTargetFile).
 *
 * Each call gets its own nsIWebBrowserPersist instance; concurrent
 * downloads do not share state.  The returned handle's abort()
 * captures `aborted = true` synchronously and calls
 * persist.cancelSave() on the live persist if one has already been
 * constructed; if abort fires before the file-picker resolves, the
 * picker callback short-circuits to onabort.
 *
 * Two modes, as in Violentmonkey (Preferences > "Use browser download
 * API", pref api.GM_download.browserApi):
 *   - Off (the default): the file is fetched first, with the page's
 *     cookies and the script's headers and timeout, then saved like any
 *     other download: into the browser's download folder, or wherever the
 *     user picks when the browser is set to ask.  The name can't make
 *     subfolders ("Gallery/001.jpg" saves as "Gallery_001.jpg").  It joins
 *     the Downloads window once saved.
 *   - On: the browser downloads it straight into its download folder
 *     (nsIWebBrowserPersist), subfolders allowed, with live progress in the
 *     Downloads window; it asks only for saveAs: true, and conflictAction
 *     ("uniquify", "overwrite", "prompt") decides what an existing file of
 *     that name does.
 */

const EXPORTED_SYMBOLS = ["createGMDownloadAPI"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cr === "undefined") {
  var Cr = Components.results;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("resource://gre/modules/osfile.jsm");
Cu.import("resource://gre/modules/Services.jsm");

Cu.importGlobalProperties(["URL", "XMLHttpRequest"]);

// "name(1).ext" for a name that's taken, as the browser's own downloads
// do.  createUnique() ("name-1.ext") when the module is missing.
try {
  Cu.import("resource://gre/modules/DownloadPaths.jsm");
} catch (e) {
  // DownloadPaths stays undefined; see uniqueTargetFile().
}


/**
 * Filename-extension policy.  GM_download uses a DENY-list only: known
 * dangerous, trivially-executable extensions are refused; everything else
 * is allowed.  Violentmonkey and Tampermonkey impose no allow-list, and the
 * former narrow whitelist here rejected common, safe types (.json, .pdf,
 * .csv, .js, .html, ...), so the allow-list was removed.  The file goes
 * straight to disk, past the browser's own download checks, so Windows
 * types that run or change the system on a double-click are included.
 */
const NAME_EXTENSION_BLACKLIST = [
  "bat", "cmd", "com", "cpl", "crx", "exe", "hta", "lnk", "msi", "msp",
  "pif", "ps1", "reg", "scr", "sh", "vbe", "vbs", "wsf",
];

/**
 * The address schemes GM_download fetches, as for GM_xmlhttpRequest.
 * nsIWebBrowserPersist runs with chrome privileges, so a file:, chrome:
 * or resource: address let a script copy any local file (the profile's
 * logins.json, say) into Downloads.
 */
const DOWNLOAD_SCHEMES = ["blob", "data", "ftp", "http", "https"];

/** Names Windows reserves for devices: such a file can't be created. */
const RESERVED_NAME_REGEXP = /^(?:con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i;

const NAME_EXTENSION_BLACKLIST_REGEXP = [
];

const DEFAULT_FILENAME = "filename.bin";

const ERROR = {
  "BLACKLISTED":    "blacklisted",
  "NOT_SUCCEEDED":  "not_succeeded",
  "NOT_WHITELISTED": "not_whitelisted",
};

/**
 * Tests details.name against the blacklist (if enforced) and whitelist.
 * Returns null if the filename is acceptable, or an ERROR code otherwise.
 *
 * @param {string} aName
 * @returns {string|null}
 */
function checkExtension(aName) {
  let lower = String(aName).toLowerCase();

  // Deny-list only: refuse known-dangerous executable extensions; allow
  // anything else (matching Violentmonkey / Tampermonkey).
  let hitBlack = NAME_EXTENSION_BLACKLIST.some(function (aExt) {
    return lower.endsWith("." + aExt.toLowerCase());
  });
  let hitBlackRe = NAME_EXTENSION_BLACKLIST_REGEXP.some(function (aRe) {
    return (new RegExp("\\." + aRe + "$", "i")).test(aName);
  });
  if (hitBlack || hitBlackRe) {
    return ERROR.BLACKLISTED;
  }
  return null;
}

/**
 * The folder the browser saves downloads to, chosen as its own downloads
 * choose it (DownloadIntegration.getPreferredDownloadsDirectory):
 * browser.download.folderList 0 is the desktop, 2 the folder in
 * browser.download.dir (created if missing), anything else the system's
 * Downloads folder.  Scripts' files used to go to the system's Downloads
 * folder whatever the user had chosen.  Falls back to the home, then the
 * temp folder, which never fails.
 *
 * @returns {nsIFile}
 */
function getDownloadsDir() {
  let dirsvc = Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties);
  let folderList = 1;
  try {
    folderList = Services.prefs.getIntPref("browser.download.folderList");
  } catch (e) {
    // Unset: the system's Downloads folder.
  }
  if (folderList == 0) {
    try {
      return dirsvc.get("Desk", Ci.nsIFile);
    } catch (e) {
      // No desktop: the Downloads folder.
    }
  } else if (folderList == 2) {
    try {
      let dir = Services.prefs.getComplexValue(
          "browser.download.dir", Ci.nsIFile);
      if (!dir.exists()) {
        dir.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("755", 8));
      }
      if (dir.isDirectory()) {
        return dir;
      }
    } catch (e) {
      // Unset or can't be created: the Downloads folder, as the browser.
    }
  }
  try {
    return dirsvc.get("DfltDwnld", Ci.nsIFile);
  } catch (e) {
    try {
      return dirsvc.get("Home", Ci.nsIFile);
    } catch (e2) {
      return dirsvc.get("TmpD", Ci.nsIFile);
    }
  }
}

/**
 * Whether the browser saves downloads without asking where
 * (browser.download.useDownloadDir, "Always ask me where to save files"
 * unticked).
 *
 * @returns {boolean}
 */
function browserSavesWithoutAsking() {
  try {
    return Services.prefs.getBoolPref("browser.download.useDownloadDir");
  } catch (e) {
    return true;
  }
}

/**
 * Whether "Use browser download API" is on (see the file overview).
 *
 * @returns {boolean}
 */
function useBrowserDownloadApi() {
  return !!GM_prefRoot.getValue("api.GM_download.browserApi", false);
}

/**
 * A script's details.headers as [name, value] pairs.  The headers object
 * is the script's X-ray-waived one: some UXP builds don't enumerate
 * waived expandos, so Object.keys is tried, then for-in, and values are
 * read by bracket access (which does work).  null / undefined values are
 * left out.
 *
 * @param {object} aHeaders
 * @returns {Array<Array<string>>}
 */
function headerPairs(aHeaders) {
  if (!aHeaders || (typeof aHeaders !== "object")) {
    return [];
  }
  let names = [];
  try {
    names = Object.keys(aHeaders);
  } catch (e) {
    // Fall through to for-in.
  }
  if (!names.length) {
    try {
      for (let n in aHeaders) {
        names.push(n);
      }
    } catch (e) {
      // None, then.
    }
  }
  let pairs = [];
  for (let i = 0; i < names.length; i++) {
    let value = aHeaders[names[i]];
    if ((value !== undefined) && (value !== null)) {
      pairs.push([String(names[i]), String(value)]);
    }
  }
  return pairs;
}

/**
 * The onprogress payload, as Tampermonkey / Violentmonkey give it.
 *
 * @param {number} aLoaded
 * @param {number} aTotal - -1 (or 0) when not known.
 * @returns {object}
 */
function progressPayload(aLoaded, aTotal) {
  return {
    "done":             aLoaded,
    "total":            aTotal,
    "loaded":           aLoaded,
    "totalSize":        aTotal,
    "lengthComputable": aTotal > 0,
  };
}

/**
 * Splits a script's file name into safe path parts.  "Gallery/001.jpg"
 * saves into a Gallery folder, as in Violentmonkey and Tampermonkey (it
 * used to throw, so onerror never ran).
 *   - Empty, "." and ".." parts are dropped: nothing leaves the folder.
 *   - Characters Windows doesn't allow in names (and control characters)
 *     become "_".
 *   - Trailing dots and spaces are removed: Windows drops them when it
 *     creates the file, which let "setup.exe." past the extension check.
 *   - A device name (CON, NUL, COM1...) gets a "_" in front.
 *
 * @param {string} aName - details.name.
 * @returns {string[]} The parts, at least one.
 */
function fileNameParts(aName) {
  let parts = String(aName || "").split(/[\\/]+/).map(function (aPart) {
    let clean = aPart.split("").map(function (aChar) {
      return ((aChar.charCodeAt(0) < 32) || ("<>:\"|?*".indexOf(aChar) > -1))
          ? "_" : aChar;
    }).join("").trim().replace(/[. ]+$/, "");
    return RESERVED_NAME_REGEXP.test(clean) ? "_" + clean : clean;
  }).filter(function (aPart) {
    return aPart !== "";
  });

  return parts.length ? parts : [DEFAULT_FILENAME];
}

/**
 * Builds the destination nsIFile in aDir from fileNameParts(), creating
 * the subfolders it names.
 *
 * @param {nsIFile}  aDir
 * @param {string[]} aParts
 * @returns {nsIFile} Not created yet; see uniqueTargetFile().
 * @throws When a subfolder can't be created (or is a file).
 */
function buildTargetFile(aDir, aParts) {
  let file = aDir.clone();
  for (let i = 0; i < aParts.length - 1; i++) {
    file.append(aParts[i]);
    if (!file.exists()) {
      file.create(Ci.nsIFile.DIRECTORY_TYPE, parseInt("755", 8));
    } else if (!file.isDirectory()) {
      throw new Error(file.path + " is not a folder");
    }
  }
  file.append(aParts[aParts.length - 1]);
  return file;
}

/**
 * Creates the file a silent download writes to, under a name nothing
 * else has: "report(1).pdf" when report.pdf exists.  A download used to
 * replace a file of the same name in the user's Downloads folder, and
 * two downloads of one name replaced each other.
 *
 * @param {nsIFile} aFile - The wanted file.
 * @returns {nsIFile} The (empty) file created for the download.
 */
function uniqueTargetFile(aFile) {
  if (typeof DownloadPaths != "undefined") {
    return DownloadPaths.createNiceUniqueFile(aFile);
  }
  let file = aFile.clone();
  file.createUnique(Ci.nsIFile.NORMAL_FILE_TYPE, parseInt("644", 8));
  return file;
}

/**
 * Shows a synchronous nsIFilePicker save dialog parented to aChromeWin.
 * Returns the selected nsIFile, or null if the user cancelled.
 *
 * Synchronous (modal) `.show()` is used — every UXP build supports it,
 * and the surrounding API is synchronous from the script's perspective.
 * An async `.open(callback)` upgrade can be done later without changing
 * the public contract: it would just delay the persist construction.
 *
 * @param {ChromeWindow} aChromeWin
 * @param {string}       aDefaultName
 * @param {nsIFile}      [aDirectory] - The folder it opens in.
 * @returns {nsIFile|null}
 */
function showFilePicker(aChromeWin, aDefaultName, aDirectory) {
  let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(aChromeWin, "GM_download", Ci.nsIFilePicker.modeSave);
  fp.defaultString = aDefaultName;
  if (aDirectory) {
    try {
      fp.displayDirectory = aDirectory;
    } catch (e) {
      // The picker's own choice of folder, then.
    }
  }
  let result = fp.show();
  if (result == Ci.nsIFilePicker.returnOK
      || result == Ci.nsIFilePicker.returnReplace) {
    return fp.file;
  }
  return null;
}

/**
 * Pulls the page's nsILoadContext off its docShell.  nsIWebBrowserPersist
 * uses this to inherit the private-browsing / container state so cookies
 * and cache behave as the user expects for that page.
 *
 * @param {Window} aContentWin
 * @returns {nsILoadContext|null}
 */
function getLoadContext(aContentWin) {
  try {
    return aContentWin
        .QueryInterface(Ci.nsIInterfaceRequestor)
        .getInterface(Ci.nsIWebNavigation)
        .QueryInterface(Ci.nsILoadContext);
  } catch (e) {
    return null;
  }
}

/**
 * Registers an in-flight download with the platform's transfer system
 * (nsITransfer @mozilla.org/transfer;1) so it appears in Pale Moon's
 * Downloads window with source / target / progress and a working
 * Cancel button.  The transfer object itself implements
 * nsIWebProgressListener; callers forward every progress / state event
 * from their own listener to it so the UI stays in sync.
 *
 * Why nsITransfer and not nsIDownloadManager.addDownload?  Pale Moon
 * (and post-Bug-825588 Firefox forks) stub out addDownload to throw
 * NS_ERROR_UNEXPECTED — the underlying storage was migrated to the
 * Downloads.jsm pipeline, which wraps nsITransfer internally.  The
 * transfer service is what BOTH the legacy XPCOM-style callers and
 * Downloads.jsm now go through, so this works on every UXP build.
 *
 * The returned listener is null if the transfer service is unavailable
 * or init() throws (the download still runs to disk, just without a
 * Downloads-window entry; Cu.reportError surfaces the cause).
 *
 * Private-browsing is derived from the page's nsILoadContext so that
 * downloads from a private window do not leak into the regular history.
 *
 * @param {nsIURI}                 aSourceUri
 * @param {nsIFile}                aTargetFile
 * @param {string}                 aDisplayName
 * @param {nsIWebBrowserPersist}   aPersist  - Used as the transfer's cancelable.
 * @param {nsILoadContext|null}    aLoadContext
 * @returns {nsIWebProgressListener|null}
 */
function registerWithDownloadManager(
    aSourceUri, aTargetFile, aDisplayName, aPersist, aLoadContext) {
  try {
    let transfer = Cc["@mozilla.org/transfer;1"]
        .createInstance(Ci.nsITransfer);
    let targetUri = Services.io.newFileURI(aTargetFile);
    let isPrivate = false;
    try {
      isPrivate = !!(aLoadContext && aLoadContext.usePrivateBrowsing);
    } catch (e) {
      // Some load contexts don't expose usePrivateBrowsing; default
      // to non-private rather than abort the registration.
    }
    // nsITransfer.init signature (UXP):
    //   void init(in nsIURI aSource,
    //             in nsIURI aTarget,
    //             in AString aDisplayName,
    //             in nsIMIMEInfo aMIMEInfo,
    //             in PRTime aStartTime,
    //             in nsIFile aTempFile,
    //             in nsICancelable aCancelable,
    //             in boolean aIsPrivate);
    transfer.init(
        aSourceUri,
        targetUri,
        aDisplayName,
        /* mimeInfo  */ null,
        /* startTime */ Date.now() * 1000,
        /* tempFile  */ null,
        /* cancelable */ aPersist,
        isPrivate);
    return transfer.QueryInterface(Ci.nsIWebProgressListener);
  } catch (e) {
    // Transfer service unavailable or init signature mismatch on this
    // build — surface for diagnosis but don't block the download.
    Cu.reportError(
        "GM_download: nsITransfer.init failed: " + e);
    return null;
  }
}

/**
 * Forwards one nsIWebProgressListener event to the Download Manager's
 * listener, swallowing exceptions so a DM-side failure can't take down
 * our own progress dispatch.  Falls through silently when aDmListener
 * is null (DM wasn't registered) or when the listener doesn't
 * implement the named method (e.g. onContentBlockingEvent on older
 * UXP builds).
 *
 * @param {nsIWebProgressListener|null} aDmListener
 * @param {string} aMethod  - Name of the listener method to call.
 * @param {IArguments} aArgs - Arguments object from the caller.
 */
function forwardToDm(aDmListener, aMethod, aArgs) {
  if (!aDmListener) {
    return;
  }
  let fn = aDmListener[aMethod];
  if (typeof fn !== "function") {
    return;
  }
  try {
    fn.apply(aDmListener, aArgs);
  } catch (e) {
    // The DM should never reject events under normal operation; surface
    // any unexpected failures via Cu.reportError but keep going.
    Cu.reportError(
        "GM_download: DM listener " + aMethod + " failed: " + e);
  }
}

/** The cancelable of a download that is already on disk. */
const NOTHING_TO_CANCEL = {
  "cancel": function () {},
  "QueryInterface": function (aIID) {
    if (aIID.equals(Ci.nsICancelable) || aIID.equals(Ci.nsISupports)) {
      return this;
    }
    throw Cr.NS_ERROR_NO_INTERFACE;
  },
};

/**
 * Lists a file that was fetched and written already in the Downloads
 * window, under the address it came from, as a finished download: the
 * transfer is told it started, how big it is, and that it stopped.
 *
 * @param {nsIURI}              aSourceUri
 * @param {nsIFile}             aTargetFile
 * @param {number}              aSize - Bytes.
 * @param {nsILoadContext|null} aLoadContext
 */
function listFinishedDownload(aSourceUri, aTargetFile, aSize, aLoadContext) {
  let dmListener = registerWithDownloadManager(aSourceUri, aTargetFile,
      aTargetFile.leafName, NOTHING_TO_CANCEL, aLoadContext);
  if (!dmListener) {
    return undefined;
  }
  let state = Ci.nsIWebProgressListener;
  let flags = state.STATE_IS_REQUEST | state.STATE_IS_NETWORK;
  forwardToDm(dmListener, "onStateChange",
      [null, null, state.STATE_START | flags, Cr.NS_OK]);
  forwardToDm(dmListener, "onProgressChange64",
      [null, null, aSize, aSize, aSize, aSize]);
  forwardToDm(dmListener, "onStateChange",
      [null, null, state.STATE_STOP | flags, Cr.NS_OK]);
}


/**
 * Builds the script-facing GM_download API function.  Called once per
 * sandbox from sandbox.js.  The returned callable is the GM_download
 * function itself (so buildGMObject's main loop wraps it into a Promise
 * for GM.download automatically — no special-case needed in sandbox.js,
 * unlike GM_cookie which is a methods-object).
 *
 * @param {Window}  aWrappedContentWin - X-ray wrapped content window
 *   (used for Error construction in sandbox scope and load-context).
 * @param {Sandbox} aSandbox    - The script's sandbox; result objects
 *                                 are cloned into it before delivery.
 * @param {string}  aFileURL    - Script file URL (for Error attribution).
 * @param {string}  aPageUrl    - Page URL (used as the HTTP referrer).
 * @returns {function} Sandbox-side GM_download function (exported).
 */
function createGMDownloadAPI(
    aWrappedContentWin, aSandbox, aFileURL, aPageUrl) {

  /**
   * Invokes a script-supplied callback safely; never lets a sandbox
   * exception escape into the chrome implementation.  All callback
   * payloads are cloned into the sandbox first.
   */
  function safeCall(aCallback, aPayload) {
    if (typeof aCallback !== "function") {
      return undefined;
    }
    try {
      aCallback(Cu.cloneInto(aPayload || {}, aSandbox));
    } catch (e) {
      GM_util.logError(e, false, aFileURL, e.lineNumber || 0);
    }
  }

  /**
   * Coerces the {url|details, name} call form into a single details
   * object with all the script-supplied fields plus the default
   * callbacks.  Unknown extra fields are preserved for forward-compat.
   */
  function normalizeDetails(aDetailsOrUrl, aNameArg) {
    let noop = function () {};
    let details = {
      "url":        null,
      "name":       DEFAULT_FILENAME,
      "saveAs":     undefined,
      "onload":     noop,
      "onerror":    noop,
      "onabort":    noop,
      "onprogress": noop,
      "ontimeout":  noop,
    };

    if (aDetailsOrUrl) {
      if (typeof aDetailsOrUrl === "object") {
        // Cu.exportFunction wraps the chrome-side downloadImpl in an
        // X-ray for cross-compartment calls.  Without waiving, the
        // chrome view of the script's details object filters out
        // function-valued expandos (onload / onerror / etc.) and may
        // also filter non-function expandos depending on UXP build.
        //
        // We waive the X-ray and then use bracket-access by explicit
        // name rather than for-in.  Some UXP builds do not enumerate
        // expandos through a waived view even though direct bracket
        // access still works (mirrors xmlHttpRequester.js:569 +
        // aDetails["on" + aEvent] pattern).
        let waived = Cu.waiveXrays(aDetailsOrUrl);
        let known = [
          "url", "name", "saveAs", "conflictAction", "headers", "timeout",
          "onload", "onerror", "onabort", "onprogress", "ontimeout",
        ];
        for (let i = 0; i < known.length; i++) {
          let k = known[i];
          let v = waived[k];
          if (v !== undefined) {
            details[k] = v;
          }
        }
      } else if (typeof aDetailsOrUrl === "string") {
        details.url = aDetailsOrUrl;
      }
    }
    if (typeof aNameArg === "string" && aNameArg) {
      details.name = aNameArg;
    }
    // A URL object as its text.
    if (details.url && (typeof details.url === "object")) {
      try {
        details.url = String(details.url);
      } catch (e) {
        details.url = null;
      }
    }
    return details;
  }

  /**
   * Resolves details.url against the page (a relative address, such as an
   * <a>'s href attribute, used to fail as malformed) and checks its scheme.
   *
   * @param {string} aUrl
   * @returns {{uri: ?nsIURI, error: ?string}}
   */
  function resolveDownloadUri(aUrl) {
    let base = null;
    try {
      base = aPageUrl ? Services.io.newURI(aPageUrl, null, null) : null;
    } catch (e) {
      // No base: only absolute addresses.
    }
    let uri;
    try {
      uri = Services.io.newURI(aUrl, null, base);
    } catch (e) {
      return {"uri": null, "error": "GM_download: malformed URL: " + aUrl};
    }
    if (DOWNLOAD_SCHEMES.indexOf(uri.scheme) == -1) {
      return {
        "uri": null,
        "error": "GM_download: " + uri.scheme
            + ": addresses can't be downloaded.",
      };
    }
    return {"uri": uri, "error": null};
  }

  /**
   * The exported GM_download implementation.  Synchronous from the
   * sandbox side; control returns immediately with a handle whose
   * .abort() can be called any time before the download finishes.
   *
   * Return values:
   *   handle (object with .abort())  — download started or queued.
   *   false                           — pre-flight validation failed
   *                                     (no url, bad extension, etc.).
   */
  function downloadImpl(aDetailsOrUrl, aNameArg) {
    let details = normalizeDetails(aDetailsOrUrl, aNameArg);

    if (!details.url || typeof details.url !== "string") {
      safeCall(details.onerror, {
        "error":   ERROR.NOT_SUCCEEDED,
        "details": "GM_download: url is required.",
      });
      return false;
    }

    let resolved = resolveDownloadUri(details.url);
    if (!resolved.uri) {
      safeCall(details.onerror, {
        "error":   ERROR.NOT_SUCCEEDED,
        "details": resolved.error,
      });
      return false;
    }
    let sourceUri = resolved.uri;

    let nameParts = fileNameParts(details.name);
    let leafName = nameParts[nameParts.length - 1];
    let extError = checkExtension(leafName);
    if (extError) {
      safeCall(details.onerror, { "error": extError });
      return false;
    }

    // Build the sandbox-side handle first so it can be returned
    // synchronously.  The persist instance is filled in below; if abort
    // fires before then, `aborted` short-circuits the picker callback.
    let handle = Cu.createObjectIn(aSandbox);
    let persist = null;
    // The fetch, when "Use browser download API" is off.
    let request = null;
    let aborted = false;
    Cu.exportFunction(function abort() {
      aborted = true;
      if (persist) {
        try {
          persist.cancelSave();
        } catch (e) {
          // Already finished / not started — nothing to cancel.
        }
      }
      if (request) {
        try {
          request.abort();
        } catch (e) {
          // Already finished.
        }
      }
    }, handle, { "defineAs": "abort" });

    let chromeWin = null;
    try {
      chromeWin = getChromeWinForContentWin(aWrappedContentWin);
    } catch (e) {
      // The frame may be detached; we'll fall back to a parent-less
      // file picker which most platforms still accept.
    }

    /**
     * Configures and kicks off the actual nsIWebBrowserPersist save.
     * Separated from downloadImpl so it can run either inline (when
     * not prompting) or after the file picker resolves.
     *
     * @param {nsIFile} aTargetFile
     * @param {boolean} aOwnFile - aTargetFile was created empty for this
     *   download (uniqueTargetFile): it is removed again if the download
     *   doesn't finish, rather than left as an empty or partial file.
     */
    function startPersist(aTargetFile, aOwnFile) {
      let ownFile = aOwnFile ? aTargetFile : null;
      let dropOwnFile = function () {
        if (!ownFile) {
          return;
        }
        try {
          if (ownFile.exists()) {
            ownFile.remove(false);
          }
        } catch (e) {
          // Locked, say; an empty or partial file is left.
        }
        ownFile = null;
      };

      if (aborted) {
        dropOwnFile();
        safeCall(details.onabort, {});
        return;
      }

      let uri = sourceUri;

      let referrer = null;
      try {
        if (aPageUrl) {
          referrer = Services.io.newURI(aPageUrl, null, null);
        }
      } catch (e) {
        // Page URL not a valid nsIURI (e.g. about:blank quirks); we'll
        // just omit the Referer header rather than abort the download.
      }

      persist = Cc["@mozilla.org/embedding/browser/nsWebBrowserPersist;1"]
          .createInstance(Ci.nsIWebBrowserPersist);
      // Replacing is safe: the target is either the file the user picked
      // (and agreed to replace) or the empty one made for this download.
      persist.persistFlags =
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES
          | Ci.nsIWebBrowserPersist.PERSIST_FLAGS_BYPASS_CACHE
          | Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;

      let loadContext = getLoadContext(aWrappedContentWin);

      // Register the download with the platform transfer service
      // (nsITransfer) so it appears in Pale Moon's Downloads window
      // with source URL, target path, live progress, and a Cancel
      // button that wires back to persist.cancelSave() via the
      // cancelable arg.
      //
      // The transfer object itself implements nsIWebProgressListener;
      // we forward every progress / state event from our own listener
      // below so the UI stays in sync.  Failure here is non-fatal:
      // the download still runs, just without a Downloads-window entry.
      let dmListener = registerWithDownloadManager(
          uri, aTargetFile, aTargetFile.leafName, persist, loadContext);

      // STATE_STOP fires once per layer that stops — for nsIWebBrowser-
      // Persist that can be both the request and the network (and on
      // some UXP builds, the document too).  Without a guard we'd
      // invoke onload / onabort / onerror two or three times.  A
      // single-shot flag mirrors the contract scripts expect: exactly
      // one terminal callback per GM_download invocation.
      let terminalFired = false;
      let progressListener = {
        "QueryInterface": function (aIID) {
          if (aIID.equals(Ci.nsIWebProgressListener)
              || aIID.equals(Ci.nsISupportsWeakReference)
              || aIID.equals(Ci.nsISupports)) {
            return this;
          }
          throw Cr.NS_ERROR_NO_INTERFACE;
        },
        "onProgressChange": function (aWebProgress, aRequest,
            aCurSelfProgress, aMaxSelfProgress,
            aCurTotalProgress, aMaxTotalProgress) {
          // Forward to the DM first so the UI updates even if our
          // script callback throws.
          forwardToDm(dmListener, "onProgressChange", arguments);
          if (aborted || terminalFired) {
            return;
          }
          safeCall(details.onprogress,
              progressPayload(aCurTotalProgress, aMaxTotalProgress));
        },
        "onProgressChange64": function (aWebProgress, aRequest,
            aCurSelfProgress, aMaxSelfProgress,
            aCurTotalProgress, aMaxTotalProgress) {
          // Numeric arguments are 64-bit signed integers here.  The
          // payload shape is identical to onProgressChange so the
          // sandbox sees consistent fields regardless of which path
          // the platform took.  The DM listener gets the 64-bit
          // variant directly (preserves precision on files > 2 GB).
          forwardToDm(dmListener, "onProgressChange64", arguments);
          if (aborted || terminalFired) {
            return;
          }
          safeCall(details.onprogress,
              progressPayload(aCurTotalProgress, aMaxTotalProgress));
        },
        "onStateChange": function (aWebProgress, aRequest,
            aStateFlags, aStatus) {
          // Always forward to DM — it needs every state transition,
          // not just terminal STOP, to keep its UI accurate.
          forwardToDm(dmListener, "onStateChange", arguments);
          let stop = Ci.nsIWebProgressListener.STATE_STOP;
          if (!(aStateFlags & stop)) {
            return;
          }
          if (terminalFired) {
            return;
          }
          terminalFired = true;
          if (aborted) {
            dropOwnFile();
            safeCall(details.onabort, {});
            return;
          }
          if (Components.isSuccessCode(aStatus)) {
            ownFile = null;
            safeCall(details.onload, {
              "finalUrl": uri.spec,
            });
          } else {
            dropOwnFile();
            safeCall(details.onerror, {
              "error":   ERROR.NOT_SUCCEEDED,
              "details": "GM_download: nsresult=0x" + aStatus.toString(16),
            });
          }
        },
        "onLocationChange": function () {
          forwardToDm(dmListener, "onLocationChange", arguments);
        },
        "onStatusChange": function () {
          forwardToDm(dmListener, "onStatusChange", arguments);
        },
        "onSecurityChange": function () {
          forwardToDm(dmListener, "onSecurityChange", arguments);
        },
        "onContentBlockingEvent": function () {
          forwardToDm(dmListener, "onContentBlockingEvent", arguments);
        },
      };
      persist.progressListener = progressListener;

      let principal = null;
      try {
        principal = aWrappedContentWin.document.nodePrincipal;
      } catch (e) {
        // Detached frame; principal will be null and we'll let UXP
        // fall back to a system principal for the persist.
      }

      // nsIWebBrowserPersist.saveURI has two shapes across UXP builds:
      //
      //   8-arg (the canonical shape on Pale Moon / Basilisk):
      //     saveURI(aURI, aCacheKey, aReferrer, aReferrerPolicy,
      //             aPostData, aExtraHeaders, aFile, aPrivacyContext)
      //
      //   9-arg (some mainline Firefox forks; adds triggering principal
      //   as arg 2):
      //     saveURI(aURI, aPrincipal, aCacheKey, aReferrer,
      //             aReferrerPolicy, aPostData, aExtraHeaders, aFile,
      //             aPrivacyContext)
      //
      // Try the 8-arg shape first since every observed UXP build
      // accepts it.  Fall back to 9-arg only if 8-arg fails — covers
      // any future principal-required build without paying a noisy
      // throw on every download.
      // Custom request headers (details.headers) -> the CRLF "Name: Value"
      // string shape saveURI's aExtraHeaders slot expects.  NOTE: the
      // aExtraHeaders "in string" form wants on-device confirmation on
      // Pale Moon 34 / Basilisk 52; a shape mismatch is caught by the
      // try/fallback below and simply means a header-bearing download
      // fails (normal downloads pass null and are unaffected).
      let extraHeaders = headerPairs(details.headers).map(function (aPair) {
        return aPair[0] + ": " + aPair[1] + "\r\n";
      }).join("") || null;

      let savedOk = false;
      let lastErr = null;
      try {
        persist.saveURI(
            uri, null, referrer, 0, null, extraHeaders,
            aTargetFile, loadContext);
        savedOk = true;
      } catch (e) {
        lastErr = e;
      }
      if (!savedOk) {
        try {
          persist.saveURI(
              uri, principal, null, referrer, 0, null, extraHeaders,
              aTargetFile, loadContext);
          savedOk = true;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!savedOk) {
        // Surface to the browser console too, so a future regression
        // is visible even when the script supplies no onerror.
        Cu.reportError("GM_download.saveURI failed: " + lastErr);
        dropOwnFile();
        safeCall(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download.saveURI: " + lastErr.toString(),
        });
        persist = null;
      }
    }

    /**
     * Sets up the fetch as GM_xmlhttpRequest does for the page: its
     * private-browsing and container identity, the user's cookies (also
     * for another site, by the same pref), the page as the referrer, and
     * the script's headers.
     *
     * @param {XMLHttpRequest} aReq - Opened, not sent.
     */
    function applyPageContext(aReq) {
      let privateMode = GM_util.windowIsPrivate(aWrappedContentWin);
      let userContextId = null;
      try {
        userContextId = aWrappedContentWin.document.nodePrincipal
            .originAttributes.userContextId || null;
      } catch (e) {
        // No principal: no container.
      }
      if (userContextId === null) {
        if (privateMode
            && (aReq.channel instanceof Ci.nsIPrivateBrowsingChannel)) {
          aReq.channel.QueryInterface(Ci.nsIPrivateBrowsingChannel)
              .setPrivate(true);
        }
      } else {
        aReq.setOriginAttributes({
          "privateBrowsingId": privateMode ? 1 : 0,
          "userContextId": userContextId,
        });
      }
      try {
        aReq.channel.QueryInterface(Ci.nsIHttpChannelInternal)
            .forceAllowThirdPartyCookie = GM_prefRoot.getValue(
                "xmlhttprequest.forceThirdPartyCookies", true);
      } catch (e) {
        // Not http(s).
      }
      let headers = headerPairs(details.headers);
      let hasReferrer = headers.some(function (aPair) {
        return aPair[0].toLowerCase() == "referer";
      });
      if (aPageUrl && !hasReferrer) {
        headers.unshift(["Referer", aPageUrl]);
      }
      headers.forEach(function (aPair) {
        try {
          aReq.setRequestHeader(aPair[0], aPair[1]);
        } catch (e) {
          GM_util.logError("GM_download: header " + aPair[0] + " left out: "
              + e, false, aFileURL, null);
        }
      });
    }

    /**
     * "Use browser download API" off, Violentmonkey's default: fetches the
     * file, then saves it like any other download (see the file overview).
     * Exactly one of onload / onerror / onabort / ontimeout is called.
     */
    function fetchThenSave() {
      let finished = false;
      let finish = function (aCallback, aPayload) {
        if (finished) {
          return undefined;
        }
        finished = true;
        request = null;
        safeCall(aCallback, aPayload);
      };
      let fail = function (aMessage) {
        finish(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download: " + aMessage,
        });
      };

      let save = function (aBuffer, aFinalUrl) {
        // No subfolders: a name's folders become part of it, as the
        // browser makes "Gallery/001.jpg" into "Gallery_001.jpg".
        let name = nameParts.join("_");
        let target;
        let ownFile = false;
        try {
          if ((details.saveAs === true) || !browserSavesWithoutAsking()) {
            target = showFilePicker(chromeWin, name, getDownloadsDir());
            if (!target) {
              finish(details.onabort, {});
              return undefined;
            }
          } else {
            target = uniqueTargetFile(
                buildTargetFile(getDownloadsDir(), [name]));
            ownFile = true;
          }
        } catch (e) {
          fail("can't save as " + name + ": " + e);
          return undefined;
        }
        let size = aBuffer ? aBuffer.byteLength : 0;
        OS.File.writeAtomic(target.path,
            new Uint8Array(aBuffer || new ArrayBuffer(0)),
            { "tmpPath": target.path + ".part" })
        .then(function () {
          listFinishedDownload(sourceUri, target, size,
              getLoadContext(aWrappedContentWin));
          finish(details.onload, { "finalUrl": aFinalUrl });
        }, function (aError) {
          if (ownFile) {
            try {
              target.remove(false);
            } catch (e) {
              // Locked, say: the empty file stays.
            }
          }
          fail("can't write " + target.path + ": " + aError);
        });
      };

      let req = new XMLHttpRequest();
      request = req;
      try {
        req.open("GET", sourceUri.spec, true);
        applyPageContext(req);
        req.responseType = "arraybuffer";
        let timeout = parseInt(details.timeout, 10);
        if (timeout > 0) {
          req.timeout = timeout;
        }
      } catch (e) {
        fail(String(e));
        return undefined;
      }
      req.addEventListener("progress", function (aEvent) {
        if (!finished && !aborted) {
          safeCall(details.onprogress, progressPayload(
              aEvent.loaded, aEvent.lengthComputable ? aEvent.total : -1));
        }
      });
      req.addEventListener("abort", function () {
        finish(details.onabort, {});
      });
      req.addEventListener("error", function () {
        fail("the download of " + sourceUri.spec + " failed.");
      });
      req.addEventListener("timeout", function () {
        finish(details.ontimeout, {});
      });
      req.addEventListener("load", function () {
        if (finished) {
          return undefined;
        }
        if (aborted) {
          finish(details.onabort, {});
          return undefined;
        }
        // An error page isn't the file: it isn't saved under its name.
        if (((sourceUri.scheme == "http") || (sourceUri.scheme == "https"))
            && ((req.status < 200) || (req.status >= 400))) {
          fail("HTTP " + req.status + " " + req.statusText
              + " (" + (req.responseURL || sourceUri.spec) + ")");
          return undefined;
        }
        // Being written: abort() has nothing left to stop.
        request = null;
        save(req.response, req.responseURL || sourceUri.spec);
      });
      try {
        req.send();
      } catch (e) {
        fail(String(e));
      }
    }

    if (!useBrowserDownloadApi()) {
      fetchThenSave();
      return handle;
    }

    // "Use browser download API" on: silent unless the script asks for
    // the Save dialog (saveAs: true), as Violentmonkey's
    // downloads.download() is.
    if (details.saveAs === true) {
      let picked = showFilePicker(chromeWin, leafName, getDownloadsDir());
      if (!picked) {
        safeCall(details.onabort, {});
        return handle;
      }
      startPersist(picked, false);
    } else {
      let target;
      let ownFile = true;
      try {
        target = buildTargetFile(getDownloadsDir(), nameParts);
        // conflictAction, as downloads.download() takes it: "uniquify"
        // (the default) saves as "name(1).ext", "overwrite" replaces the
        // file, "prompt" asks where to save instead.
        let clash = target.exists() && !target.isDirectory();
        if (clash && (details.conflictAction == "prompt")) {
          target = showFilePicker(chromeWin, leafName, target.parent);
          if (!target) {
            safeCall(details.onabort, {});
            return handle;
          }
          ownFile = false;
        } else if (clash && (details.conflictAction == "overwrite")) {
          ownFile = false;
        } else {
          target = uniqueTargetFile(target);
        }
      } catch (e) {
        safeCall(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download: can't save as " + nameParts.join("/")
              + ": " + e,
        });
        return handle;
      }
      startPersist(target, ownFile);
    }

    return handle;
  }

  return Cu.exportFunction(downloadImpl, aSandbox);
}
