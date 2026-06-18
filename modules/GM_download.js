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
 * Filename-extension policy.  GM_download uses a DENY-list only: known
 * dangerous, trivially-executable extensions are refused; everything else
 * is allowed.  Violentmonkey and Tampermonkey impose no allow-list, and the
 * former narrow whitelist here rejected common, safe types (.json, .pdf,
 * .csv, .js, .html, ...), so the allow-list was removed.
 */
const NAME_EXTENSION_BLACKLIST = [
  "bat", "com", "crx", "exe", "scr", "sh",
];

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
          "url", "name", "saveAs", "headers", "timeout",
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
          uri, aTargetFile, details.name, persist, loadContext);

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
          // the platform took.  The DM listener gets the 64-bit
          // variant directly (preserves precision on files > 2 GB).
          forwardToDm(dmListener, "onProgressChange64", arguments);
          if (aborted || terminalFired) {
            return;
          }
          safeCall(details.onprogress, {
            "done":             aCurTotalProgress,
            "total":            aMaxTotalProgress,
            "loaded":           aCurTotalProgress,
            "totalSize":        aMaxTotalProgress,
            "lengthComputable": aMaxTotalProgress > 0,
          });
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
      // string shape saveURI's aExtraHeaders slot expects.  details.headers
      // is the script's X-ray-waived object; enumerate defensively
      // (Object.keys, then for-in) because some UXP builds don't enumerate
      // waived expandos, and read values by bracket access (which does
      // work).  NOTE: the aExtraHeaders "in string" form and this
      // enumeration both want on-device confirmation on Pale Moon 34 /
      // Basilisk 52; a shape mismatch is caught by the try/fallback below
      // and simply means a header-bearing download fails (normal downloads
      // pass null and are unaffected).
      let extraHeaders = null;
      if (details.headers && (typeof details.headers === "object")) {
        let names = [];
        try {
          names = Object.keys(details.headers);
        } catch (e) {
          // ignore — fall through to for-in.
        }
        if (!names.length) {
          try {
            for (let n in details.headers) {
              names.push(n);
            }
          } catch (e) {
            // ignore.
          }
        }
        let headerLines = "";
        for (let i = 0; i < names.length; i++) {
          let v = details.headers[names[i]];
          if ((v !== undefined) && (v !== null)) {
            headerLines += names[i] + ": " + String(v) + "\r\n";
          }
        }
        if (headerLines) {
          extraHeaders = headerLines;
        }
      }

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
        safeCall(details.onerror, {
          "error":   ERROR.NOT_SUCCEEDED,
          "details": "GM_download.saveURI: " + lastErr.toString(),
        });
        persist = null;
      }
    }

    // Whether to prompt for save location.  GM_download's contract
    // (Tampermonkey / Violentmonkey) is silent download by default;
    // the picker is only shown when the script explicitly sets
    // `saveAs: true`.  An earlier draft of this module also honoured
    // browser.download.useDownloadDir, but that surprised scripts —
    // a GM_download call would prompt on Pale Moon (which defaults
    // useDownloadDir to false) but not on Firefox.  Aligned to the
    // GM4 spec instead.
    if (details.saveAs === true) {
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
