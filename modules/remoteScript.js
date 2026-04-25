/**
 * @file remoteScript.js
 * @overview Downloads, parses, and installs userscripts from remote URLs.
 *
 * Two main exports:
 *
 *   cleanFilename(aFilename, aDefault)
 *     Sanitises a raw filename by stripping disallowed characters, normalising
 *     whitespace, and (on Windows) truncating to a safe path length.
 *
 *   RemoteScript(aUrl)
 *     Manages the full lifecycle of fetching a userscript and its dependencies
 *     (@require, @resource, @icon) over HTTP.  The download is intentionally
 *     asynchronous and callback-driven.  Key methods:
 *       download(cb)        — fetch the .user.js then all dependencies
 *       downloadScript(cb)  — fetch only the .user.js
 *       parseScript(src)    — parse script source, discover dependencies
 *       install(old)        — move temp files into the scripts directory
 *       setScript(s, file)  — attach an existing Script for dependency re-fetch
 *       setSilent()         — suppress the install notification toast
 *       showSource(browser) — open the downloaded source in a new tab
 *       cancel()            — abort all pending channels and clean up temps
 *
 * Implementation notes:
 *   - DownloadListener (private) implements nsIStreamListener /
 *     nsIProgressEventSink and writes incoming bytes to a temp file.  For the
 *     main script file it also accumulates data and attempts live parsing.
 *   - assertIsFunction() and filenameFromUri() are private helpers.
 *   - On Windows the full path is limited to 240 chars (MSDN MAX_PATH minus
 *     safety margin); gWindowsNameMaxLen accounts for the scripts directory.
 *   - Scripts and dependencies are downloaded to a unique temp directory and
 *     moved atomically to the scripts directory on a successful install.
 */

const EXPORTED_SYMBOLS = ["cleanFilename", "RemoteScript"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}
if (typeof Cr === "undefined") {
  var Cr = Components.results;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");

Cu.import("resource://gre/modules/Services.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");

Cu.import("resource://gre/modules/NetUtil.jsm");
Cu.import("resource://gre/modules/PrivateBrowsingUtils.jsm");

Cu.import("chrome://greasemonkey-modules/content/addons.js");
Cu.import("chrome://greasemonkey-modules/content/GM_notification.js");
Cu.import("chrome://greasemonkey-modules/content/script.js");
Cu.import("chrome://greasemonkey-modules/content/scriptIcon.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const CALLBACK_IS_NOT_FUNCTION = "callback is not a function.";

const TIMEOUT = 500;

const FILENAME_DISALLOWED_CHARACTERS_REGEXP = new RegExp(
    "[\\\\/:*?'\"<>|]", "g");

const FILENAME_REGEXP = new RegExp(
    "^(.+?)("
    + GM_CONSTANTS.fileScriptExtensionRegexp
    + "|[^.{,8}])$", "");

// https://msdn.microsoft.com/en-us/library/aa365247.aspx#maxpath
// Actual limit is 260; 240 ensures e.g. ".user.js" and slashes still fit.
// The "/ 2" thing is so that we can have a directory, and a file in it.
var gWindowsNameMaxLen = (240 - GM_util.scriptDir().path.length) / 2;

/////////////////////////////// Private Helpers ////////////////////////////////

/**
 * Throws an Error if aFunc is not a function.
 *
 * @param {*}      aFunc    - Value to test.
 * @param {string} aMessage - Error message to use if the check fails.
 */
function assertIsFunction(aFunc, aMessage) {
  if (typeof aFunc != typeof function () {}) {
    throw new Error(aMessage);
  }
}

/**
 * Sanitises a raw filename for safe use on disk.
 *
 * Steps applied in order:
 *   1. Strips characters forbidden on most filesystems (\ / : * ? ' " < > |).
 *   2. Collapses runs of whitespace/"%20" into underscores.
 *   3. On Windows, truncates to gWindowsNameMaxLen characters (preserving the
 *      extension) to stay under the MAX_PATH limit.
 *   4. Falls back to aDefault (or "unknown") if the result would be empty.
 *
 * @param {string} aFilename - The raw filename to sanitise (may be empty/null).
 * @param {string} aDefault  - Fallback name used when aFilename is falsy or
 *   the result would otherwise be empty.
 * @returns {string} A safe, non-empty filename string.
 * @throws {Error} On Windows, if the scripts directory path itself is too long.
 */
function cleanFilename(aFilename, aDefault) {
  // Blacklist problem characters (slashes, colons, etc.).
  let filename = (aFilename || aDefault)
      .replace(FILENAME_DISALLOWED_CHARACTERS_REGEXP, "");

  // Make whitespace readable.
  filename = filename.replace(new RegExp("(\\s|%20)+", "g"), "_");

  // See #1548.
  // https://msdn.microsoft.com/en-us/library/aa365247.aspx#maxpath
  // Limit length on Windows.
  if (GM_CONSTANTS.xulRuntime.OS == "WINNT") {
    if (gWindowsNameMaxLen <= 0) {
      throw new Error(
          "remoteScript - cleanFilename:" + "\n"
          + GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.remoteScript.notMakeValidFileName"));
    }
    
    let match = filename.match(FILENAME_REGEXP);
    if (match) {
      filename = match[1].substr(0, gWindowsNameMaxLen) + match[2];
    } else {
      filename = filename.substr(0, gWindowsNameMaxLen);
    }
  }

  // Ensure that it's something.
  if (!filename) {
    filename = aDefault || "unknown";
  }

  return filename;
}

/**
 * Extracts and sanitises a filename from a URI's file component.
 *
 * @param {nsIURI}  aUri     - The URI to extract a filename from.
 * @param {string}  aDefault - Fallback used when the URI has no filename.
 * @returns {string} A safe filename string.
 */
function filenameFromUri(aUri, aDefault) {
  let filename = "";
  let url;
  try {
    url = aUri.QueryInterface(Ci.nsIURL);
    filename = url.fileName;
  } catch (e) {
    dump("remoteScript - filenameFromUri:" + "\n" + e + "\n");
  }

  return cleanFilename(filename, aDefault);
}

////////////////////////// Private Download Listener ///////////////////////////

/**
 * XPCOM stream listener that writes an HTTP (or file) download to disk.
 *
 * Implements nsIStreamListener, nsIProgressEventSink, and nsIInterfaceRequestor
 * so it can be passed directly as the notification callbacks and listener for
 * a channel.asyncOpen() call.
 *
 * For the main script file (aTryToParse=true) it also:
 *   - Strips any leading UTF-8 BOM bytes.
 *   - Accumulates received bytes and calls remoteScript.parseScript() on the
 *     fly so metadata (name, @require, etc.) is available before the download
 *     completes.
 *   - Detects an HTML content-type response and cancels the request, treating
 *     it as a bad install URL.
 *
 * @constructor
 * @param {boolean}      aTryToParse         - True only for the first (script) file.
 * @param {function}     aProgressCb         - Called with (channel, fraction) on progress.
 * @param {function}     aCompletionCallback - Called with (channel, success, errMsg, status, headers).
 * @param {nsIFile}      aFile               - Destination temp file (opened for writing).
 * @param {nsIURI}       aUri                - Source URI (used for error messages).
 * @param {RemoteScript} aRemoteScript       - Owning RemoteScript (for live parsing).
 * @param {boolean}      [aErrorsAreFatal=true] - If false, HTTP errors are non-fatal.
 */
function DownloadListener(
    aTryToParse, aProgressCb, aCompletionCallback, aFile, aUri, aRemoteScript,
    aErrorsAreFatal) {
  this._completionCallback = aCompletionCallback;
  this._data = [];
  this._errorsAreFatal = (typeof aErrorsAreFatal == "undefined")
      ? true : aErrorsAreFatal;
  this._progressCallback = aProgressCb;
  this._remoteScript = aRemoteScript;
  this._tryToParse = aTryToParse;
  this._uri = aUri;

  this._fileOutputStream = Cc["@mozilla.org/network/file-output-stream;1"]
      .createInstance(Ci.nsIFileOutputStream);
  this._fileOutputStream.init(aFile, -1, -1, null);
  if (aTryToParse) {
    // UTF-8 BOM.
    this._fileOutputStream.write(
        GM_CONSTANTS.scriptParseBOM, GM_CONSTANTS.scriptParseBOMArray.length);
  }
  this._binOutputStream = Cc["@mozilla.org/binaryoutputstream;1"]
      .createInstance(Ci.nsIBinaryOutputStream);
  this._binOutputStream.setOutputStream(this._fileOutputStream);
}

DownloadListener.prototype = {
  "_parse": function (aRemoteScript) {
    let converter = Cc["@mozilla.org/intl/scriptableunicodeconverter"]
        .createInstance(Ci.nsIScriptableUnicodeConverter);
    converter.charset = GM_CONSTANTS.fileScriptCharset;
    let source = "";
    try {
      source = converter.convertFromByteArray(this._data, this._data.length);
    } catch (e) {}

    return this._remoteScript.parseScript(source, true);
  },

  // nsIStreamListener.
  "onDataAvailable": function (
      aRequest, aContext, aInputStream, aOffset, aCount) {
    let binaryInputStream = Cc["@mozilla.org/binaryinputstream;1"]
        .createInstance(Ci.nsIBinaryInputStream);
    binaryInputStream.setInputStream(aInputStream);

    // Read incoming data.
    let data = binaryInputStream.readByteArray(aCount);

    if (this._tryToParse) {
      // See #1823.
      // Strip UTF-8 BOM(s) at the very start of the file.
      // See also GM_CONSTANTS.scriptParseBOM
      while (data && (data.length >= GM_CONSTANTS.scriptParseBOMArray.length)
          && (data[0] == GM_CONSTANTS.scriptParseBOMArray[0])
          && (data[1] == GM_CONSTANTS.scriptParseBOMArray[1])
          && (data[2]) == GM_CONSTANTS.scriptParseBOMArray[2]) {
        data = data.slice(GM_CONSTANTS.scriptParseBOMArray.length);
      }

      this._data = this._data.concat(data);
      this._tryToParse = !this._parse(aContext);
    } else {
      this._data = null;
    }

    // Write it to the file.
    this._binOutputStream.writeByteArray(data, data.length);
  },

  // nsIProgressEventSink.
  "onProgress": function (aRequest, aContext, aProgress, aProgressMax) {
    let progress;
    if ((aProgressMax == -1) || (aProgressMax == 0)
        || (aProgressMax == 0xFFFFFFFFFFFFFFFF)) {
      progress = 0;
    } else {
      progress = aProgress / aProgressMax;
    }
    this._progressCallback(aRequest, progress);
  },

  // nsIRequestObserver.
  "onStartRequest": function (aRequest, aContext) {
    // For the first file (the script) detect an HTML page and abort if so.
    if (this._tryToParse) {
      let contentType = false;
      try {
        aRequest.QueryInterface(Ci.nsIHttpChannel);
      } catch (e) {
        // Non-http channel?
        // Ignore.
        return undefined;
      }
      try {
        contentType = new RegExp(
            GM_CONSTANTS.fileScriptContentTypeNoRegexp, "i")
            .test(aRequest.contentType);
      } catch (e) {
        // Problem loading page (Unable to connect)?
        // Ignore.
        return undefined;
      }
      if (contentType) {
        // Cancel this request immediately
        // and let onStopRequest handle the cleanup for everything else.
        let httpChannel;
        let status;
        try {
          httpChannel = aRequest.QueryInterface(Ci.nsIHttpChannel);
          status = httpChannel.responseStatus;
        } catch (e) {
          // Ignore.
        }
        if (GM_CONSTANTS.installScriptBadStatus(status, true)) {
          aRequest.cancel(Cr.NS_BINDING_FAILED);
        } else {
          aRequest.cancel(Cr.NS_BINDING_ABORTED);
        }
      }
    }
  },

  // nsIRequestObserver
  "onStopRequest": function (aRequest, aContext, aStatusCode) {
    this._binOutputStream.close();
    this._fileOutputStream.close();

    let httpChannel;
    let error = !Components.isSuccessCode(aStatusCode);
    let errorMessage = GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGreasemonkeyProperties)
        .GetStringFromName("error.unknown");
    let status = -1;
    let headers = {};
    let headersProp = ["Retry-After"];
    let _headers = "";
    try {
      httpChannel = aRequest.QueryInterface(Ci.nsIHttpChannel);
      error |= !httpChannel.requestSucceeded;
      error |= httpChannel.responseStatus >= 400;
      status = httpChannel.responseStatus;
      for (let i = 0, iLen = headersProp.length; i < iLen; i++) {
        try {
          headers[headersProp[i]] = httpChannel
              .getResponseHeader(headersProp[i]);
        } catch (e) {
          // Ignore.
        }
      }
      Object.getOwnPropertyNames(headers).forEach(function (aProp) {
        _headers += "\n" + '"' + aProp + '": "' + headers[aProp] + '"';
      });
      errorMessage = GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("error.serverReturned")
          + " " + httpChannel.responseStatus + " "
          + httpChannel.responseStatusText + "."
          + ((_headers != "") ? "\n" + _headers : "");
    } catch (e) {
      try {
        aRequest.QueryInterface(Ci.nsIFileChannel);
        // No-op.
        // If it got this far, aStatus is accurate.
      } catch (e) {
        dump("remoteScript - DownloadListener - onStopRequest" + "\n"
            + "- aRequest is neither http nor file channel:" + "\n"
            + aRequest + "\n");
        for (let i in Ci) {
          try {
            aRequest.QueryInterface(Ci[i]);
            dump("it is a: " + i + "\n");
          } catch (e) {
            // Ignore.
          }
        }
      }
    }

    if (error && this._errorsAreFatal) {
      errorMessage = GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGreasemonkeyProperties)
          .GetStringFromName("error.downloadingUrl")
          + "\n" + this._uri.spec + "\n\n" + errorMessage;
    }

    this._progressCallback(aRequest, 1);
    this._completionCallback(
        aRequest, !error, errorMessage, status, headers);
  },

  // nsIProgressEventSink.
  "onStatus": function (aRequest, aContext, aStatus, aStatusArg) {},

  // nsIInterfaceRequestor.
  "getInterface": function (aIiD) {
    return this.QueryInterface(aIiD);
  },

  // nsISupports.
  "QueryInterface": XPCOMUtils.generateQI([
    Ci.nsIProgressEventSink,
    Ci.nsIStreamListener,
    Ci.nsISupports,
  ]),
};

/////////////////////////////// Public Interface ///////////////////////////////

// Note: The design of this class is very asynchronous,
// with the result that the code path spaghetti's through quite a few callbacks.
// A necessary evil.

/**
 * Manages downloading a userscript (and its dependencies) from a remote URL.
 *
 * The design is intentionally asynchronous: callers register callbacks via
 * onProgress() / onScriptMeta() and then call download() or downloadScript().
 * The actual work is done through DownloadListener and XPCOM channels.
 *
 * Lifecycle:
 *   1. new RemoteScript(url)
 *   2. [optional] setSilent() / onProgress() / onScriptMeta()
 *   3. download(completionCb) — fetches .user.js then all @require/@resource/@icon
 *   4. install([oldScript])   — moves temp files into the scripts directory
 *
 * @constructor
 * @param {string} aUrl - The remote URL of the .user.js file to download.
 */
function RemoteScript(aUrl) {
  this._baseName = null;
  this._cancelled = false;
  this._channels = [];
  this._dependencies = [];
  this._metadata = null;
  this._progress = [0, 0];
  this._progressCallbacks = [];
  this._progressIndex = 0;
  this._scriptFile = null;
  this._scriptMetaCallbacks = [];
  this._silent = false;
  this._tempDir = GM_util.getTempDir();
  this._uri = GM_util.getUriFromUrl(aUrl);
  this._url = aUrl;

  this.done = false;
  this.errorMessage = null;
  this.messageName = "script.installed";
  this.script = null;
}

Object.defineProperty(RemoteScript.prototype, "url", {
  "get": function RemoteScript_getUrl() {
    return new String(this._url);
  },
  "enumerable": true,
});

/** Cancels all in-progress channel requests and removes temp files. */
RemoteScript.prototype.cancel = function () {
  this._cancelled = true;
  this.cleanup();
};

/**
 * Aborts all pending channels, schedules removal of the temp directory, and
 * marks this RemoteScript as done.  Dispatches a final progress=1 callback.
 *
 * @param {string} [aErrorMessage] - If provided, stored as this.errorMessage.
 */
RemoteScript.prototype.cleanup = function (aErrorMessage) {
  this.errorMessage = null;
  // See #2327.
  if (aErrorMessage && (typeof aErrorMessage != "object")) {
    this.errorMessage = aErrorMessage;
  }
  this.done = true;

  this._channels.forEach(function (aChannel) {
    try {
      aChannel.QueryInterface(Ci.nsIRequest);
    } catch (e) {
      return undefined;
    }
    aChannel.cancel(Cr.NS_BINDING_ABORTED);
  });
  if (this._tempDir && this._tempDir.exists()) {
    var _RemoteScript_Cleanup_tempDir = this._tempDir;
    GM_util.timeout(function () {
      if (_RemoteScript_Cleanup_tempDir
          && _RemoteScript_Cleanup_tempDir.exists()) {
        try {
          _RemoteScript_Cleanup_tempDir.remove(true);
        } catch (e) {
          // Ignore.
        }
      }
      GM_util.timeout(function () {
        if (_RemoteScript_Cleanup_tempDir
            && _RemoteScript_Cleanup_tempDir.exists()) {
          GM_util.enqueueRemove(_RemoteScript_Cleanup_tempDir, true);
        }
      }, TIMEOUT);
    }, TIMEOUT);
  }

  this._dispatchCallbacks("progress", 1);
};

/**
 * Downloads the .user.js and all its dependencies (@require, @resource, @icon).
 * If the script metadata has already been parsed (this.script is set), skips
 * directly to downloading dependencies.
 *
 * @param {function} [aCompletionCallback] - Called with (success, type, status, headers)
 *   when everything finishes (or on error).
 */
RemoteScript.prototype.download = function (aCompletionCallback) {
  aCompletionCallback = aCompletionCallback || function () {};
  assertIsFunction(
      aCompletionCallback,
      "RemoteScript.download: Completion " + CALLBACK_IS_NOT_FUNCTION);

  if (this.script) {
    this._downloadDependencies(aCompletionCallback);
  } else {
    this.downloadScript(
        GM_util.hitch(this, function (aSuccess, aPoint, aStatus, aHeaders) {
          if (aSuccess) {
            this._downloadDependencies(aCompletionCallback);
          }
          aCompletionCallback(
              this._cancelled || aSuccess, aPoint, aStatus, aHeaders);
        }));
  }
};

/**
 * Downloads only the .user.js file itself (not its dependencies).
 * Use download() to also fetch @require/@resource/@icon files.
 *
 * @param {function} aCompletionCallback - Called with (success, point, status, headers).
 * @throws {Error} If this RemoteScript has no URL.
 */
RemoteScript.prototype.downloadScript = function (aCompletionCallback) {
  assertIsFunction(
      aCompletionCallback,
      "RemoteScript.downloadScript: Completion " + CALLBACK_IS_NOT_FUNCTION);
  if (!this._url) {
    throw new Error(
        "RemoteScript.downloadScript: "
        + "Tried to download script, but have no URL.");
  }

  this._scriptFile = GM_util.getTempFile(
      this._tempDir, filenameFromUri(this._uri, GM_CONSTANTS.fileScriptName));

  this._downloadFile(this._uri, this._scriptFile,
      GM_util.hitch(this, this._downloadScriptCb, aCompletionCallback),
      true); // aErrorsAreFatal.
};

/**
 * Moves downloaded temp files into the permanent scripts directory and
 * finalises the script installation.
 *
 * Two modes:
 *   - aOnlyDependencies=false (default): Full install.  Moves the entire temp
 *     directory into the scripts dir, updates the config, and (unless silent)
 *     shows an install/update notification to the user.
 *   - aOnlyDependencies=true: Dependency-only update.  Moves individual
 *     dependency files into the existing script's base directory.
 *
 * @param {Script}  [aOldScript]        - The previously installed Script to replace.
 * @param {boolean} [aOnlyDependencies=false] - Only update dependency files.
 * @throws {Error} If the script has not been downloaded yet (this.script is null).
 */
RemoteScript.prototype.install = function (aOldScript, aOnlyDependencies) {
  if (!this.script) {
    throw new Error(
        GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.remoteScript.notDownloaded"));
  }
  // Part 2/3 (install.js - Part 1/3, remoteScript.js - Part 3/3).
  if (!this._tempDir) {
    return undefined;
  }
  if (typeof aOnlyDependencies == "undefined") {
    aOnlyDependencies = false;
  }

  if (aOnlyDependencies) {
    // Just move the dependencies in.
    for (let i = 0, iLen = this._dependencies.length; i < iLen; i++) {
      let dep = this._dependencies[i];
      // Make sure this is actually a file, not a data URI.
      if (!dep._filename) {
        continue;
      }

      // See #1906.
      // Grab a unique file name to ensure we don't overwrite the script
      // in case it has the same name as one of the dependencies.
      let target = GM_util.getTempFile(this.script.baseDirFile, dep.filename);

      let file = this._tempDir.clone();
      file.append(dep.filename);
      file.moveTo(this.script.baseDirFile, target.leafName);

      dep.setFilename(target);
    }

    // Only delete the temporary directory if it's empty.
    try {
      this._tempDir.remove(false);
    } catch (e) {
      // Silently ignore.
    }

    // Part 1/2 (script.js - Part 2/2).
    // The fix update icon in the AOM (after a change in the editor).
    // ScriptAddonFactoryByScript(this.script, true);
    this.script._changed("modified", this.script.id);
  } else {
    // Completely install the new script.
    if (!this._baseName) {
      throw new Error(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.remoteScript.nameUnknown"));
    }

    GM_util.getService().config.install(this.script, aOldScript, this._tempDir);

    var suffix = 0;
    var file = GM_util.scriptDir();
    file.append(this._baseName);
    // See #2400.
    while (file.exists()
        || (file.leafName.substr(
            file.leafName.length - GM_CONSTANTS.fileScriptDBExtension.length)
            .toLowerCase() == GM_CONSTANTS.fileScriptDBExtension)) {
      suffix++;
      file = GM_util.scriptDir();
      file.append(this._baseName + "-" + suffix);
    }
    this._baseName = file.leafName;

    this.script.setFilename(this._baseName, this._scriptFile.leafName);
    // this._tempDir.moveTo(GM_util.scriptDir(), this._baseName);
    /*
    Part 3/3 (install.js - Part 1/3, remoteScript.js - Part 2/3).
    See #1919.
    Sometimes - throws an errors:
      NS_ERROR_FILE_IS_LOCKED: Component returned failure code:
        0x8052000e (NS_ERROR_FILE_IS_LOCKED) [nsIFile.moveTo]
        remoteScript.js
    */
    let _baseName = this._baseName;
    try {
      this._tempDir.moveTo(GM_util.scriptDir(), _baseName);
    } catch (e if (e.name == "NS_ERROR_FILE_IS_LOCKED")) {
      GM_util.timeout(function () {
        try {
          this._tempDir.moveTo(GM_util.scriptDir(), _baseName);
        } catch (e) {
          throw new Error(
              "RemoteScript.install:" + "\n"
              + e.description + "\n"
              + 'tempDir.moveTo: "' + _baseName + '"',
              e.fileName, e.lineNumber);
        }
      }, TIMEOUT);
    }
    this._tempDir = null;

    this.script.fixTimestampsOnInstall();
    this.script.checkConfig();

    // Now that we've fully populated the new state, update the AOM
    // and config data based on that.
    ScriptAddonFactoryByScript(this.script, true);
    this.script._changed("modified", this.script.id);

    // Let the user know we're all done.
    if (!this._silent) {
      let notificationOptions = null;
      if (this.messageName == "script.updated") {
        notificationOptions = {
          "persistence": -1,
          "persistWhileVisible": true,
          "learnMoreURL": this.script.homepageURL,
        };
      }
      GM_notification(
          "(" + this.script.localized.name + ") "
          + GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGmBrowserProperties)
              .GetStringFromName(this.messageName),
          this.messageName, notificationOptions);
    }
  }
};

/**
 * Registers a download-progress callback.
 * The callback is called with (remoteScript, "progress", fraction) where
 * fraction is in [0, 1].
 *
 * @param {function} aCallback - Progress callback to register.
 */
RemoteScript.prototype.onProgress = function (aCallback) {
  assertIsFunction(aCallback, "Progress " + CALLBACK_IS_NOT_FUNCTION);
  this._progressCallbacks.push(aCallback);
};

/**
 * Registers a callback to be called once script metadata has been parsed.
 * The callback is called with (remoteScript, "scriptMeta", scriptObj).
 *
 * @param {function} aCallback - Metadata-available callback to register.
 */
RemoteScript.prototype.onScriptMeta = function (aCallback) {
  assertIsFunction(aCallback, "Script meta " + CALLBACK_IS_NOT_FUNCTION);
  this._scriptMetaCallbacks.push(aCallback);
};

/**
 * Parses script source code, populates this.script, and discovers dependencies.
 * Called live during download (by DownloadListener) and again from
 * _parseScriptFile() after the download completes.
 *
 * @param {string}  aSource - The raw JavaScript source of the .user.js file.
 * @param {boolean} aFatal  - If true, parsing errors trigger cleanup(); if false,
 *   the error is set but parsing failure is non-fatal.
 * @returns {boolean} True if parsing succeeded and this.script was set.
 */
RemoteScript.prototype.parseScript = function (aSource, aFatal) {
  if (this.errorMessage) {
    return false;
  }
  if (this.script) {
    return true;
  }

  let scope = {};
  Cu.import("chrome://greasemonkey-modules/content/parseScript.js", scope);
  let script = scope.parse(aSource, this._uri, aFatal);
  if (!script || script.parseErrors.length) {
    if (!aFatal) {
      this.cleanup(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.parsingScript")
          + "\n" + (
              script
              ? script.parseErrors
              : stringBundle.GetStringFromName("error.unknown")
          ));
    }
    return false;
  }

  this._baseName = cleanFilename(script.name, GM_CONSTANTS.fileScriptName);
  this._dispatchCallbacks("scriptMeta", script);
  this.script = script;
  this._postParseScript();

  return true;
};

/**
 * Attaches an already-installed Script object so that calling download() will
 * only re-fetch its dependencies (not the .user.js itself).
 *
 * After calling this, download() will only fetch dependencies.
 * The RemoteScript can then be install()'d to update those files.
 *
 * @param {Script}  aScript   - The currently installed Script object.
 * @param {nsIFile} [aTempFile] - Temp file path, used for the "new script" dialog.
 */
RemoteScript.prototype.setScript = function (aScript, aTempFile) {
  this._scriptFile = aScript.file;
  this._baseName = aScript._basedir;
  this.script = aScript;
  if (aTempFile) {
    // Special case for "new script" dialog.
    this._scriptFile = aTempFile;
    this._baseName = cleanFilename(aScript.name, GM_CONSTANTS.fileScriptName);
  }
  this._postParseScript();
};

/**
 * Suppresses the install/update notification toast.
 * Used by the Sync engine when installing scripts silently in the background.
 *
 * @param {boolean} [aVal=true] - Pass a falsy value to re-enable notifications.
 */
RemoteScript.prototype.setSilent = function (aVal) {
  this._silent = !!aVal;
};

/**
 * Opens the downloaded script source in a new browser tab and shows an
 * install notification bar with an "Install" button.
 *
 * @param {XULBrowser|tabbrowser} aBrowser - The current browser or tab browser.
 * @throws {Error} If the script has not been fully downloaded yet.
 */
RemoteScript.prototype.showSource = function (aBrowser) {
  if (this._progress[0] < 1) {
    throw new Error(
        "RemoteScript.showSource: Script is not loaded.");
  }

  let tabBrowser = null;
  try {
    // The "new script" dialog.
    tabBrowser = aBrowser.getTabBrowser();
  } catch (e) {
    // The context menu.
    tabBrowser = aBrowser.ownerDocument.defaultView.gBrowser;
  }
  let tab = tabBrowser.addTab(
      GM_CONSTANTS.ioService.newFileURI(this._scriptFile).spec);
  tabBrowser.selectedTab = tab;

  // Ensure any temporary files are deleted after the tab is closed.
  var cleanup = GM_util.hitch(this, "cleanup");
  tab.addEventListener("TabClose", cleanup, false);

  let buttons = [];
  buttons.push({
    "accessKey": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGmBrowserProperties)
        .GetStringFromName("greeting.btnAccess"),
    // Clicking "Install" on the source-preview notification bar installs
    // the script directly instead of reopening the install dialog with a
    // fresh 5-second countdown.  The user has already seen the install
    // dialog (which is what brought them here via "Show Script Source")
    // AND just read the source — making them sit through the security
    // delay a second time adds friction without adding security.
    "callback": GM_util.hitch(this, function () {
      // Skip the cleanup handler, as the downloaded files
      // are used in the installation process.
      tab.removeEventListener("TabClose", cleanup, false);
      this.install();
      // Timeout puts this after the notification closes itself
      // for the button click, avoiding an error inside that (Pale Moon) code.
      GM_util.timeout(function () {
        tabBrowser.removeTab(tab);
      }, 0);
    }),
    "label": GM_CONSTANTS.localeStringBundle.createBundle(
        GM_CONSTANTS.localeGmBrowserProperties)
        .GetStringFromName("greeting.btn"),
    "popup": null,
  });

  // See #2348.
  let notificationBox = tabBrowser.getNotificationBox();
  let notification = notificationBox.appendNotification(
      GM_CONSTANTS.localeStringBundle.createBundle(
          GM_CONSTANTS.localeGmBrowserProperties)
          .GetStringFromName("greeting.msg"),
      "greasemonkey-install-userscript",
      "chrome://greasemonkey/skin/icon16.png",
      notificationBox.PRIORITY_WARNING_MEDIUM,
      buttons
    );
  notification.persistence = -1;
};

/** @returns {string} Human-readable description including the source URL. */
RemoteScript.prototype.toString = function () {
  return "[RemoteScript object; " + this._url + "]";
};

//////////////////////////// Private Implementation ////////////////////////////

/**
 * Invokes all registered callbacks of the given type.
 *
 * @param {string} aType - "progress" or "scriptMeta".
 * @param {*}      aData - Data to pass as the third argument to each callback.
 * @throws {Error} If aType is not a recognised callback list name.
 */
RemoteScript.prototype._dispatchCallbacks = function (aType, aData) {
  let callbacks = this["_" + aType + "Callbacks"];
  if (!callbacks) {
    throw new Error(
        "RemoteScript._dispatchCallbacks - Invalid callback type: " + aType);
  }
  for (let i = 0, iLen = callbacks.length; i < iLen; i++) {
    let callback = callbacks[i];
    callback(this, aType, aData);
  }
};

/**
 * Downloads the next pending dependency in sequence.
 * Called recursively until all dependencies are fetched, then invokes
 * aCompletionCallback(true, "dependencies").
 *
 * @param {function} aCompletionCallback - Called when all dependencies are done.
 */
RemoteScript.prototype._downloadDependencies = function (aCompletionCallback) {
  if (this.done) {
    return undefined;
  }

  this._progressIndex++;
  if (this._progressIndex > this._dependencies.length) {
    this.done = true;
    // Always call the callback asynchronously.
    // That way, the caller doesn't have to take special care of the case
    // where this is called synchronously when there is nothing to download.
    GM_util.timeout(GM_util.hitch(this, function () {
      this._dispatchCallbacks("progress", 1);
      aCompletionCallback(true, "dependencies");
    }), 0);
    return undefined;
  }

  // Because _progressIndex includes the base script at 0,
  // subtract one to get the dependency index.
  var dependency = this._dependencies[this._progressIndex - 1];
  let uri = GM_util.getUriFromUrl(dependency.downloadURL);
  let file = GM_util.getTempFile(
      this._tempDir, filenameFromUri(uri, GM_CONSTANTS.fileScriptName));
  dependency.setFilename(file);

  function dependencyDownloadComplete(aChannel, aSuccess, aErrorMessage) {
    if (!aSuccess) {
      if (dependency instanceof ScriptIcon) {
        // Ignore the failure to download the icon.
      } else {
        this.cleanup(aErrorMessage);
        aCompletionCallback(aSuccess, "dependency");
        return undefined;
      }
    }
    if (dependency.setCharset) {
      dependency.setCharset(aChannel.contentCharset || null);
    }
    if (dependency.setMimetype) {
      dependency.setMimetype(aChannel.contentType);
    }
    this._downloadDependencies(aCompletionCallback);
  }

  this._downloadFile(
      uri, file, GM_util.hitch(this, dependencyDownloadComplete),
      !(dependency instanceof ScriptIcon)); // aErrorsAreFatal.
};

/**
 * Downloads a single URI to a local file asynchronously.
 *
 * Security: if the requested URI has a different scheme from the script's own
 * URI, it must pass GM_util.isGreasemonkeyable() or the download is aborted.
 *
 * Handles private-browsing mode by marking the channel private when needed.
 * Uses TYPE_OBJECT_SUBREQUEST so the HTTP observer doesn't intercept it.
 *
 * @param {nsIURI}   aUri                - Remote URI to download.
 * @param {nsIFile}  aFile               - Destination temp file.
 * @param {function} aCompletionCallback - Called with (channel, success, errMsg, status, headers).
 * @param {boolean}  aErrorsAreFatal     - Passed through to the DownloadListener.
 */
RemoteScript.prototype._downloadFile = function (
    aUri, aFile, aCompletionCallback, aErrorsAreFatal) {
  aUri = aUri.QueryInterface(Ci.nsIURI);
  aFile = aFile.QueryInterface(Ci.nsIFile);
  aCompletionCallback = aCompletionCallback || function () {};
  assertIsFunction(aCompletionCallback,
      "RemoteScript._downloadFile: Completion " + CALLBACK_IS_NOT_FUNCTION);

  // If we have a URI (locally installed scripts, when updating, won't)...
  if (this._uri) {
    if (aUri == this._uri) {
      // No-op, always download the script itself.
    } else if (aUri.scheme == this._uri.scheme) {
      // No-op, always allow files from the same scheme as the script.
    } else if (!GM_util.isGreasemonkeyable(aUri.spec)) {
      // Otherwise, these are unsafe.
      // Do not download them.
      this.cleanup(
          GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.remoteScript.unsafeUrl")
              .replace("%1", aUri.spec));
      return undefined;
    }
  }

  // Construct a channel with a policy type
  // that the HTTP observer is designed to ignore,
  // so it won't intercept this network call.
  let channel = NetUtil.newChannel({
    "contentPolicyType": Ci.nsIContentPolicy.TYPE_OBJECT_SUBREQUEST,
    "loadUsingSystemPrincipal": true,
    "uri": aUri,
  });
  // When cache is used (*.user.js, e.g. MIME type: text/html):
  // 1. It creates temporary folder ("gm-temp-...") - permanently (see #2069).
  // 2. Infinite loading web page (see #2407).
  // But see also:
  // https://github.com/OpenUserJs/OpenUserJS.org/issues/1066
  // Pale Moon 27.2.x-
  // https://github.com/MoonchildProductions/Pale-Moon/pull/1002
  // Firefox 41.0-
  // http://bugzil.la/1170197
  // (http://bugzil.la/1166133)
  if (((Services.appinfo.ID == GM_CONSTANTS.browserIDPalemoon)
      && (GM_util.compareVersion("27.3.0a1", "20170405000000") < 0))
      || ((Services.appinfo.ID == GM_CONSTANTS.browserIDFirefox)
      && (GM_util.compareVersion("42.0a1", "20150702030207") < 0))) {
    channel.loadFlags |= channel.LOAD_BYPASS_CACHE;
  }
  // See #1717.
  // A page with a userscript - http auth.
  // Private Browsing, Containers (Firefox 42+).
  let privateMode = true;
  let userContextId = null;
  let chromeWin = GM_util.getBrowserWindow();
  if (chromeWin && chromeWin.gBrowser) {
    // i.e. the Private Browsing autoStart pref:
    // "browser.privatebrowsing.autostart"
    privateMode = PrivateBrowsingUtils.isBrowserPrivate(chromeWin.gBrowser);
    /*
    if (chromeWin.gBrowser.selectedBrowser
        && chromeWin.gBrowser.selectedBrowser.contentPrincipal
        && chromeWin.gBrowser.selectedBrowser.contentPrincipal.originAttributes
        && chromeWin.gBrowser.selectedBrowser.contentPrincipal.originAttributes
            .userContextId) {
      userContextId = chromeWin.gBrowser.selectedBrowser.contentPrincipal
          .originAttributes.userContextId;
    }
    */
  }
  if (userContextId === null) {
    if (channel instanceof Ci.nsIPrivateBrowsingChannel) {
      if (privateMode) {
        channel = channel.QueryInterface(Ci.nsIPrivateBrowsingChannel);
        channel.setPrivate(true);
      }
    }
  } else {
    req.setOriginAttributes({
      "privateBrowsingId": privateMode ? 1 : 0,
      // "userContextId": userContextId,
    });
  }
  /*
  dump("RemoteScript._downloadFile - url:" + "\n" + aUri.spec + "\n"
      + "Private Browsing mode: " + req.channel.isChannelPrivate + "\n");
  */
  this._channels.push(channel);
  let dsl = new DownloadListener(
      this._progressIndex == 0, // aTryToParse.
      GM_util.hitch(this, this._downloadFileProgress),
      aCompletionCallback,
      aFile,
      aUri,
      this,
      aErrorsAreFatal);
  channel.notificationCallbacks = dsl;
  channel.asyncOpen(dsl, this);
};

/**
 * Updates the per-file progress slot and dispatches the aggregate progress
 * (mean of all slots) to registered progress callbacks.
 *
 * @param {nsIChannel} aChannel      - The channel that reported progress (unused).
 * @param {number}     aFileProgress - Progress fraction [0, 1] for this file.
 */
RemoteScript.prototype._downloadFileProgress = function (
    aChannel, aFileProgress) {
  this._progress[this._progressIndex] = aFileProgress;
  let progress = this._progress.reduce(function (a, b) {
    return a + b;
  }) / this._progress.length;
  this._dispatchCallbacks("progress", progress);
};

/**
 * Called when the main .user.js file download finishes.
 * On success, parses the downloaded file; on failure, cleans up.
 * In both error cases that warrant an install dialog, fakes a "success" so
 * the install window can display the error message to the user.
 *
 * @param {function}   aCompletionCallback - Forwarded to the caller of downloadScript().
 * @param {nsIChannel} aChannel            - The completed channel.
 * @param {boolean}    aSuccess            - Whether the HTTP download succeeded.
 * @param {string}     aErrorMessage       - Human-readable error (if !aSuccess).
 * @param {number}     aStatus             - HTTP response status code.
 * @param {object}     aHeaders            - Selected response headers.
 */
RemoteScript.prototype._downloadScriptCb = function (
    aCompletionCallback, aChannel, aSuccess, aErrorMessage, aStatus, aHeaders) {
  if (aSuccess) {
    // At this point downloading the script itself is definitely done.

    // Parse the script.
    try {
      this._parseScriptFile();
    } catch (e) {
      // If that failed, set the error message, and...
      if (new String(e).indexOf("Unicode") === -1) {
        this.cleanup(
            GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.unknown"));
      } else {
        this.cleanup(
            GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGreasemonkeyProperties)
            .GetStringFromName("error.scriptCharset"));
      }
    }

    if (this.errorMessage) {
      // Fake a successful download,
      // so the install window will show, with the error message.
      this._dispatchCallbacks("scriptMeta", new Script());
      return aCompletionCallback(true, "script", aStatus, aHeaders);
    }

    if (!this.script) {
      dump("RemoteScript._downloadScriptCb:" + " "
          + "Finishing with error because no script was found." + "\n");
      // If we STILL don't have a script, this is a fatal error.
      return aCompletionCallback(false, "script", aStatus, aHeaders);
    }
  } else {
    this.cleanup(aErrorMessage);
    // https://github.com/OpenUserJs/OpenUserJS.org/issues/1066
    if (aErrorMessage
        && GM_CONSTANTS.installScriptBadStatus(aStatus, true)) {
      // Fake a successful download,
      // so the install window will show, with the error message.
      this._dispatchCallbacks("scriptMeta", new Script());
      return aCompletionCallback(true, "script", aStatus, aHeaders);
    }
  }

  aCompletionCallback(aSuccess, "script", aStatus, aHeaders);
};

/**
 * Reads the downloaded script file from disk and calls parseScript() on its
 * contents.  Called after onStopRequest confirms the download is complete.
 *
 * @returns {null} Always returns null (result goes via parseScript side effects).
 */
RemoteScript.prototype._parseScriptFile = function () {
  if (this.done) {
    return undefined;
  }
  let source = GM_util.getContents(this._scriptFile, null, true);
  if (!source) {
    return null;
  }
  let script = null;
  try {
    this.parseScript(source, false);
  } catch (e) {
    dump("RemoteScript._parseScriptFile:" + "\n" + e + "\n");
  }

  return script;
};

/**
 * Initialises the dependency list and progress array after this.script is set.
 * Called by both parseScript() and setScript().
 */
RemoteScript.prototype._postParseScript = function () {
  this._dependencies = this.script.dependencies;
  this._progress = [];
  for (let i = 0, iLen = this._dependencies.length; i < iLen; i++) {
    this._progress[i] = 0;
  }
};
