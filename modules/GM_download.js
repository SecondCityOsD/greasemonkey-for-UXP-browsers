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
 *
 * API shape (matches Tampermonkey / Violentmonkey / GM4):
 *
 *   handle = GM_download(details)
 *   handle = GM_download(url, name)
 *
 *   details = {
 *     url:      string (required),
 *     name:     string (filename to save as),
 *     saveAs:   bool   (force file picker; default honours pref),
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
 * Filename extension policy: a whitelist is enforced (the polyfill's
 * original list, e.g. archives, images, video, audio, text), and an
 * optional blacklist (bat/com/crx/exe/scr/sh) is supported but disabled
 * by default — flipping it on adds a defence-in-depth layer at the
 * cost of breaking edge-case scripts.
 *
 * Each call gets its own nsIWebBrowserPersist instance; concurrent
 * downloads do not share state.  The returned handle's abort()
 * captures `aborted = true` synchronously and calls
 * persist.cancelSave() on the live persist if one has already been
 * constructed; if abort fires before the file-picker resolves, the
 * picker callback short-circuits to onabort.
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
Cu.import("chrome://greasemonkey-modules/content/thirdParty/getChromeWinForContentWin.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");
Cu.import("resource://gre/modules/Services.jsm");

Cu.importGlobalProperties(["URL"]);


/**
 * Filename-extension policy carried over from the polyfill so existing
 * scripts that pass the polyfill's checks continue to pass here.
 *
 * Whitelist is always enforced; blacklist is gated on
 * BLACKLIST_ENFORCED.  The blacklist is intended as defence-in-depth
 * against trivially-executable extensions; it is off by default to
 * preserve script compatibility, matching the polyfill's default.
 */
const BLACKLIST_ENFORCED = false;

const NAME_EXTENSION_BLACKLIST = [
  "bat", "com", "crx", "exe", "scr", "sh",
];

const NAME_EXTENSION_BLACKLIST_REGEXP = [
];

const NAME_EXTENSION_WHITELIST = [
  "7z", "avi", "bin", "divx", "gif", "ico", "idx", "iso",
  "jpe", "jpeg", "mkv", "mp3", "mp4", "mpe", "mpeg",
  "png", "rar", "srt", "sub", "txt", "wav", "webm", "zip",
];

const NAME_EXTENSION_WHITELIST_REGEXP = [
  "r(ar|[0-9]{2,2})",
];

const DEFAULT_FILENAME = "filename.bin";

const ERROR = {
  "BLACKLISTED":    "blacklisted",
  "NOT_SUCCEEDED":  "not_succeeded",
  "NOT_WHITELISTED": "not_whitelisted",
};

/** Pref the browser itself reads to decide auto-save vs prompt. */
const PREF_USE_DOWNLOAD_DIR = "browser.download.useDownloadDir";


/**
 * Tests details.name against the blacklist (if enforced) and whitelist.
 * Returns null if the filename is acceptable, or an ERROR code otherwise.
 *
 * @param {string} aName
 * @returns {string|null}
 */
function checkExtension(aName) {
  let lower = String(aName).toLowerCase();

  if (BLACKLIST_ENFORCED) {
    let hitBlack = NAME_EXTENSION_BLACKLIST.some(function (aExt) {
      return lower.endsWith("." + aExt.toLowerCase());
    });
    let hitBlackRe = NAME_EXTENSION_BLACKLIST_REGEXP.some(function (aRe) {
      return (new RegExp("\\." + aRe + "$", "i")).test(aName);
    });
    if (hitBlack || hitBlackRe) {
      return ERROR.BLACKLISTED;
    }
  }

  let hitWhite = NAME_EXTENSION_WHITELIST.some(function (aExt) {
    return lower.endsWith("." + aExt.toLowerCase());
  });
  let hitWhiteRe = NAME_EXTENSION_WHITELIST_REGEXP.some(function (aRe) {
    return (new RegExp("\\." + aRe + "$", "i")).test(aName);
  });
  if (!hitWhite && !hitWhiteRe) {
    return ERROR.NOT_WHITELISTED;
  }
  return null;
}

/**
 * Reads browser.download.useDownloadDir.  If true (the default in every
 * UXP build), downloads land in the configured Downloads folder without
 * a prompt; if false, the browser would normally prompt — and so will
 * we, by forcing saveAs.
 *
 * @returns {boolean}
 */
function shouldPromptByPref() {
  try {
    return !Services.prefs.getBoolPref(PREF_USE_DOWNLOAD_DIR);
  } catch (e) {
    // Pref missing → assume the browser's hard-coded default (true).
    return false;
  }
}

/**
 * Resolves the default Downloads folder as an nsIFile.  Falls back to
 * the OS temp dir if "DfltDwnld" is unavailable (extremely unusual,
 * but never fatal here — the user can still pick a folder via saveAs).
 *
 * @returns {nsIFile}
 */
function getDownloadsDir() {
  let dirsvc = Cc["@mozilla.org/file/directory_service;1"]
      .getService(Ci.nsIProperties);
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
 * Builds the destination nsIFile inside aDir with name aName.  Does not
 * collision-check; nsIWebBrowserPersist is configured with
 * PERSIST_FLAGS_REPLACE_EXISTING_FILES so an existing file is overwritten,
 * matching the polyfill's overwrite-on-save behaviour.
 *
 * @param {nsIFile} aDir
 * @param {string}  aName
 * @returns {nsIFile}
 */
function buildTargetFile(aDir, aName) {
  let file = aDir.clone();
  file.append(aName);
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
 * @returns {nsIFile|null}
 */
function showFilePicker(aChromeWin, aDefaultName) {
  let fp = Cc["@mozilla.org/filepicker;1"].createInstance(Ci.nsIFilePicker);
  fp.init(aChromeWin, "GM_download", Ci.nsIFilePicker.modeSave);
  fp.defaultString = aDefaultName;
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
        for (let k in aDetailsOrUrl) {
          // Capture every field, including unknown ones, in case the
          // script reads its own auxiliary data back from `details`.
          details[k] = aDetailsOrUrl[k];
        }
      } else if (typeof aDetailsOrUrl === "string") {
        details.url = aDetailsOrUrl;
      }
    }
    if (typeof aNameArg === "string" && aNameArg) {
      details.name = aNameArg;
    }
    return details;
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

    let extError = checkExtension(details.name);
    if (extError) {
      safeCall(details.onerror, { "error": extError });
      return false;
    }

    // Build the sandbox-side handle first so it can be returned
    // synchronously.  The persist instance is filled in below; if abort
    // fires before then, `aborted` short-circuits the picker callback.
    let handle = Cu.createObjectIn(aSandbox);
    let persist = null;
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
     */
    function startPersist(aTargetFile) {
      if (aborted) {
        safeCall(details.onabort, {});
        return;
      }

      let uri;
      try {
        uri = Services.io.newURI(details.url, null, null);
      } catch (e) {
        safeCall(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download: malformed URL: " + e.toString(),
        });
        return;
      }

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
      persist.persistFlags =
            Ci.nsIWebBrowserPersist.PERSIST_FLAGS_REPLACE_EXISTING_FILES
          | Ci.nsIWebBrowserPersist.PERSIST_FLAGS_BYPASS_CACHE
          | Ci.nsIWebBrowserPersist.PERSIST_FLAGS_AUTODETECT_APPLY_CONVERSION;

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
          if (aborted) {
            return;
          }
          // Match the polyfill / TM/VM event shape:
          //   { done, total, loaded, totalSize, lengthComputable }
          safeCall(details.onprogress, {
            "done":             aCurTotalProgress,
            "total":            aMaxTotalProgress,
            "loaded":           aCurTotalProgress,
            "totalSize":        aMaxTotalProgress,
            "lengthComputable": aMaxTotalProgress > 0,
          });
        },
        "onProgressChange64": function (aWebProgress, aRequest,
            aCurSelfProgress, aMaxSelfProgress,
            aCurTotalProgress, aMaxTotalProgress) {
          // Numeric arguments are 64-bit signed integers here.  The
          // payload shape is identical to onProgressChange so the
          // sandbox sees consistent fields regardless of which path
          // the platform took.
          this.onProgressChange(aWebProgress, aRequest,
              aCurSelfProgress, aMaxSelfProgress,
              aCurTotalProgress, aMaxTotalProgress);
        },
        "onStateChange": function (aWebProgress, aRequest,
            aStateFlags, aStatus) {
          let stop = Ci.nsIWebProgressListener.STATE_STOP;
          if (!(aStateFlags & stop)) {
            return;
          }
          if (aborted) {
            safeCall(details.onabort, {});
            return;
          }
          if (Components.isSuccessCode(aStatus)) {
            safeCall(details.onload, {
              "finalUrl": details.url,
            });
          } else {
            safeCall(details.onerror, {
              "error":   ERROR.NOT_SUCCEEDED,
              "details": "GM_download: nsresult=0x" + aStatus.toString(16),
            });
          }
        },
        "onLocationChange":  function () {},
        "onStatusChange":    function () {},
        "onSecurityChange":  function () {},
        "onContentBlockingEvent": function () {},
      };
      persist.progressListener = progressListener;

      let loadContext = getLoadContext(aWrappedContentWin);
      try {
        // saveURI signature on UXP (Pale Moon / Basilisk):
        //   void saveURI(in nsIURI aURI,
        //                in nsISupports aCacheKey,
        //                in nsIURI aReferrer,
        //                in long aReferrerPolicy,
        //                in nsIInputStream aPostData,
        //                in string aExtraHeaders,
        //                in nsISupports aFile,
        //                in nsILoadContext aPrivacyContext);
        persist.saveURI(
            uri,
            /* cacheKey       */ null,
            /* referrer       */ referrer,
            /* referrerPolicy */ 0,
            /* postData       */ null,
            /* extraHeaders   */ null,
            /* file           */ aTargetFile,
            /* loadContext    */ loadContext);
      } catch (e) {
        safeCall(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download.saveURI: " + e.toString(),
        });
        persist = null;
      }
    }

    // Decide whether to prompt for save location.  Honour the script's
    // explicit `saveAs` first; otherwise fall back to the browser's own
    // download-prompt pref so the user's choice in about:preferences is
    // respected.
    let needPicker;
    if (typeof details.saveAs === "boolean") {
      needPicker = details.saveAs;
    } else {
      needPicker = shouldPromptByPref();
    }

    if (needPicker) {
      let picked = showFilePicker(chromeWin, details.name);
      if (!picked) {
        safeCall(details.onabort, {});
        return handle;
      }
      startPersist(picked);
    } else {
      startPersist(buildTargetFile(getDownloadsDir(), details.name));
    }

    return handle;
  }

  return Cu.exportFunction(downloadImpl, aSandbox);
}
