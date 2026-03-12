/**
 * @file scriptDependency.js
 * @overview Base class for all resources associated with a userscript:
 *   icons (@icon), required scripts (@require), and named resources (@resource).
 *
 * ScriptDependency manages the common state shared by all three:
 *   - The original download URL (@downloadURL / resource URL from metadata).
 *   - The local filename once the dependency has been downloaded.
 *   - The MIME type and optional charset (used when serving to the sandbox).
 *   - A back-reference to the owning Script object for path resolution.
 *
 * Concrete subclasses (ScriptIcon, ScriptRequire, ScriptResource) override
 * or extend this as needed.
 */

const EXPORTED_SYMBOLS = ["ScriptDependency"];

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
 * Base class for a script dependency (icon, @require, @resource).
 *
 * @constructor
 * @param {Script|null} aScript - The Script that owns this dependency.
 *   May be null when constructing a temporary/detached dependency.
 */
function ScriptDependency(aScript) {
  this._charset = null;
  this._dataURI = null;
  this._downloadURL = null;
  this._filename = null;
  this._mimetype = null;
  this._name = null;
  this._script = aScript || null;
  this._tempFile = null;

  this.type = "UnknownDependency";
}

ScriptDependency.prototype = {
  /**
   * Sets the character encoding reported when serving this dependency.
   * @param {string} aCharset - IANA charset name, e.g. "UTF-8".
   */
  "setCharset": function (aCharset) {
    this._charset = aCharset;
  },

  /**
   * Records the local filename from an nsIFile object.
   * Only the leaf name (i.e. the file's base name without directory) is stored.
   * @param {nsIFile} aFile - The downloaded local file.
   */
  "setFilename": function (aFile) {
    aFile.QueryInterface(Components.interfaces.nsIFile);
    this._filename = aFile.leafName;
  },

  /**
   * Sets the MIME type for this dependency.
   * @param {string} aMimetype - MIME type string, e.g. "text/javascript".
   */
  "setMimetype": function (aMimetype) {
    this._mimetype = aMimetype;
  },

  /**
   * Returns a human-readable string representation.
   * @returns {string} e.g. "[ScriptRequire; foo.js]"
   */
  "toString": function () {
    return "[" + this.type + "; " + this.filename + "]";
  },
};

/**
 * The remote URL from which this dependency was (or should be) downloaded.
 * Returns an empty string if no URL has been set.
 *
 * @type {string}
 */
Object.defineProperty(ScriptDependency.prototype, "downloadURL", {
  "get": function ScriptDependency_getDownloadURL() {
    return "" + (this._downloadURL || "");
  },
  "enumerable": true,
});

/**
 * The nsIFile pointing to the locally stored copy of this dependency.
 * Resolves to <script.baseDirFile>/<filename>.
 *
 * @type {nsIFile}
 */
Object.defineProperty(ScriptDependency.prototype, "file", {
  "get": function ScriptDependency_getFile() {
    let file = this._script.baseDirFile;

    file.append(this._filename);

    return file;
  },
  "enumerable": true,
});

/**
 * The leaf filename of the locally stored dependency.
 * Falls back to the data URI string if no filename has been set.
 *
 * @type {string}
 */
Object.defineProperty(ScriptDependency.prototype, "filename", {
  "get": function ScriptDependency_getFilename() {
    return "" + (this._filename || this._dataURI || "");
  },
  "enumerable": true,
});

/**
 * The MIME type of this dependency, with charset appended if set.
 * e.g. "text/javascript" or "text/css;charset=UTF-8".
 *
 * @type {string}
 */
Object.defineProperty(ScriptDependency.prototype, "mimetype", {
  "get": function ScriptDependency_getMimetype() {
    let mimetype = this._mimetype;

    if (this._charset && (this._charset.length > 0)) {
      mimetype += ";charset=" + this._charset;
    }

    return mimetype;
  },
  "enumerable": true,
});

/**
 * The logical name of this dependency (used as the key in GM_getResourceText /
 * GM_getResourceURL calls for @resource entries).
 *
 * @type {string}
 */
Object.defineProperty(ScriptDependency.prototype, "name", {
  "get": function ScriptDependency_getName() {
    return "" + this._name;
  },
  "enumerable": true,
});

/**
 * The full text content of the locally stored dependency file.
 * Used by GM_getResourceText() to return the raw text of a @resource.
 *
 * @type {string}
 */
Object.defineProperty(ScriptDependency.prototype, "textContent", {
  "get": function ScriptDependency_getTextContent() {
    return GM_util.getContents(this.file);
  },
  "enumerable": true,
});
