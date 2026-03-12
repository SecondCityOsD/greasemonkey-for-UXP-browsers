/*
 * GM_download() — native implementation for Greasemonkey UXP port.
 *
 * Adapted from the GM_download polyfill originally by:
 *   ccloli (original author)
 *   Jan Biniok (blacklist/whitelist from Tampermonkey)
 *   janekptacijarabaci
 *
 * This file is loaded into the script sandbox via jsSubScriptLoader when
 * @grant GM_download (or @grant GM.download) is present.
 *
 * Mechanism: fetches the URL via GM_xmlhttpRequest as a Blob, then triggers
 * the browser's save dialog using an <a download="..."> click in the page.
 *
 * GM_xmlhttpRequest is auto-injected by sandbox.js when GM_download is
 * granted, so scripts do not need to separately grant GM_xmlhttpRequest.
 *
 * Supported callbacks: onabort, onerror, onload, onprogress, ontimeout
 * Not supported: saveAs (requires native file picker integration)
 */

// *****************************************************************************

const _GM_DL_API = {
  "name": {
    "basic": "GM_download",
    "fully": "GM_download()",
  },
  "nameInternal": {
    "basic": "GM_xmlhttpRequest",
    "fully": "GM_xmlhttpRequest()",
  },
};

// *****************************************************************************

// Locale strings for error messages.

const _GM_DL_LOCALE = {
  "_default": "en-US",
  "_enforce": null,
  "cs": {
    "error": {
      "download": {
        "error": _GM_DL_API.name.fully + ":%1",
        "failed": _GM_DL_API.name.fully + " se nezdařilo.%1",
        "noUrl": _GM_DL_API.name.fully + ": url nenalezeno.%1",
        "onabortIsNotFunction":
            _GM_DL_API.name.fully + ": details.onabort není funkce!",
        "onerrorIsNotFunction":
            _GM_DL_API.name.fully + ": details.onerror není funkce!",
        "onloadIsNotFunction":
            _GM_DL_API.name.fully + ": details.onload není funkce!",
        "onprogressIsNotFunction":
            _GM_DL_API.name.fully + ": details.onprogress není funkce!",
        "ontimeoutIsNotFunction":
            _GM_DL_API.name.fully + ": details.ontimeout není funkce!",
        "xmlhttpRequest": {
          "require": _GM_DL_API.nameInternal.fully
              + ' - typeof: "%1".'
              + "\n"
              + 'Nastavte "@grant '
              + _GM_DL_API.nameInternal.basic
              + '" v "metadata block".',
        },
      },
    },
    "file": {
      "name": "soubor",
      "extension": "bin",
    },
  },
  "en-US": {
    "error": {
      "download": {
        "error": _GM_DL_API.name.fully + ":%1",
        "failed": _GM_DL_API.name.fully + " failed:%1",
        "noUrl": _GM_DL_API.name.fully + ": url not found.%1",
        "onabortIsNotFunction":
            _GM_DL_API.name.fully + ": details.onabort is not a function!",
        "onerrorIsNotFunction":
            _GM_DL_API.name.fully + ": details.onerror is not a function!",
        "onloadIsNotFunction":
            _GM_DL_API.name.fully + ": details.onload is not a function!",
        "onprogressIsNotFunction":
            _GM_DL_API.name.fully + ": details.onprogress is not a function!",
        "ontimeoutIsNotFunction":
            _GM_DL_API.name.fully + ": details.ontimeout is not a function!",
        "xmlhttpRequest": {
          "require": _GM_DL_API.nameInternal.fully
              + ' - typeof: "%1".'
              + "\n"
              + 'Set "@grant '
              + _GM_DL_API.nameInternal.basic
              + '" at "metadata block".',
        },
      },
    },
    "file": {
      "name": "filename",
      "extension": "bin",
    },
  },
};

// *****************************************************************************

// Extension whitelist/blacklist for downloaded file extensions.
// NAME_EXTENSION_BLACKLIST = false means blacklist is not enforced;
// whitelist is always enforced.

const _GM_DL_NAME_EXTENSION_BLACKLIST = false;

const _GM_DL_NAME_EXTENSION = {
  "blacklist": [
    "bat",
    "com",
    "crx",
    "exe",
    "scr",
    "sh",
  ],
  "blacklistRegexp": [
  ],
  "whitelist": [
    "7z",
    "avi",
    "bin",
    "divx",
    "gif",
    "ico",
    "idx",
    "iso",
    "jpe",
    "jpeg",
    "mkv",
    "mp3",
    "mp4",
    "mpe",
    "mpeg",
    "png",
    "rar",
    "srt",
    "sub",
    "txt",
    "wav",
    "webm",
    "zip",
  ],
  "whitelistRegexp": [
    "r(ar|[0-9]{2,2})",
  ],
};

// *****************************************************************************

var _gm_dl_language = ((_GM_DL_LOCALE._enforce) ? _GM_DL_LOCALE._enforce
    : (navigator.language ? navigator.language
    : _GM_DL_LOCALE._default));
_gm_dl_language = (_gm_dl_language in _GM_DL_LOCALE)
    ? _gm_dl_language : _GM_DL_LOCALE._default;

const _GM_DL_L = {
  "result": {
    "error": {
      "download": {
        "error": _GM_DL_LOCALE[_gm_dl_language].error.download.error,
        "failed": _GM_DL_LOCALE[_gm_dl_language].error.download.failed,
        "noUrl": _GM_DL_LOCALE[_gm_dl_language].error.download.noUrl,
        "onabortIsNotFunction":
            _GM_DL_LOCALE[_gm_dl_language].error.download.onabortIsNotFunction,
        "onerrorIsNotFunction":
            _GM_DL_LOCALE[_gm_dl_language].error.download.onerrorIsNotFunction,
        "onloadIsNotFunction":
            _GM_DL_LOCALE[_gm_dl_language].error.download.onloadIsNotFunction,
        "onprogressIsNotFunction":
            _GM_DL_LOCALE[_gm_dl_language].error.download.onprogressIsNotFunction,
        "ontimeoutIsNotFunction":
            _GM_DL_LOCALE[_gm_dl_language].error.download.ontimeoutIsNotFunction,
        "xmlhttpRequest": {
          "require":
              _GM_DL_LOCALE[_gm_dl_language].error.download.xmlhttpRequest.require,
        },
      },
    },
    "file": {
      "name": _GM_DL_LOCALE[_gm_dl_language].file.name,
      "extension": _GM_DL_LOCALE[_gm_dl_language].file.extension,
    },
  },
};

const _GM_DL_RESULT = {
  "error": {
    "BLACKLISTED": "blacklisted",
    "NOT_SUCCEEDED": "not_succeeded",
    "NOT_WHITELISTED": "not_whitelisted",
  },
};

// *****************************************************************************

// Safety check: GM_xmlhttpRequest must be available in the sandbox.
// sandbox.js auto-injects it when GM_download is granted, so this should
// never fire under normal circumstances.
if (typeof GM_xmlhttpRequest != "function") {
  throw new Error(
      _GM_DL_L.result.error.download.xmlhttpRequest.require
      .replace("%1", typeof GM_xmlhttpRequest));
}

/**
 * Downloads a file from a URL and triggers the browser's save dialog via an
 * anchor-click mechanism.  Validates the filename extension against a whitelist.
 * @param {string|object} aDetailsOrUrl - A URL string, or a details object with url, name, and callback properties.
 * @param {string} [aName] - Filename override; takes precedence over details.name when provided.
 * @returns {object|false} The GM_xmlhttpRequest return value on success, or false on validation/error failure.
 */
function GM_download(aDetailsOrUrl, aName) {
  let _functionEmpty = function () {};

  var message = "";

  var details = {
    "url": null,
    "name": _GM_DL_L.result.file.name + "." + _GM_DL_L.result.file.extension,
    "onabort": _functionEmpty,
    "onerror": _functionEmpty,
    "onload": _functionEmpty,
    "onprogress": _functionEmpty,
    "ontimeout": _functionEmpty,
  };

  var _details = {};

  if (aDetailsOrUrl) {
    if (typeof aDetailsOrUrl == "object") {
      for (let i in aDetailsOrUrl) {
        _details[i] = aDetailsOrUrl[i];
      }
    } else if (typeof aDetailsOrUrl == "string") {
      details.url = aDetailsOrUrl;
    }
  }

  if (_details.url && (typeof _details.url == "string")) {
    details.url = _details.url;
  }
  if (_details.name && (typeof _details.name == "string")) {
    details.name = _details.name;
  }
  if (_details.onabort) { details.onabort = _details.onabort; }
  if (_details.onerror) { details.onerror = _details.onerror; }
  if (_details.onload)  { details.onload  = _details.onload;  }
  if (_details.onprogress) { details.onprogress = _details.onprogress; }
  if (_details.ontimeout)  { details.ontimeout  = _details.ontimeout;  }

  for (let i in _details) {
    if (!(i in details)) {
      details[i] = _details[i];
    }
  }

  if (details.url == null) {
    message = "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    message = _GM_DL_L.result.error.download.noUrl.replace("%1", message);
    details.onerror({
      "details": message,
      "error": _GM_DL_RESULT.error.NOT_SUCCEEDED,
    });
    return false;
  }

  if (typeof details.onabort != "function") {
    message = _GM_DL_L.result.error.download.onabortIsNotFunction;
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    details.onerror({ "details": message, "error": _GM_DL_RESULT.error.NOT_SUCCEEDED });
    return false;
  }
  if (typeof details.onerror != "function") {
    message = _GM_DL_L.result.error.download.onerrorIsNotFunction;
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    console.error(message);
    return false;
  }
  if (typeof details.onload != "function") {
    message = _GM_DL_L.result.error.download.onloadIsNotFunction;
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    details.onerror({ "details": message, "error": _GM_DL_RESULT.error.NOT_SUCCEEDED });
    return false;
  }
  if (typeof details.onprogress != "function") {
    message = _GM_DL_L.result.error.download.onprogressIsNotFunction;
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    details.onerror({ "details": message, "error": _GM_DL_RESULT.error.NOT_SUCCEEDED });
    return false;
  }
  if (typeof details.ontimeout != "function") {
    message = _GM_DL_L.result.error.download.ontimeoutIsNotFunction;
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    details.onerror({ "details": message, "error": _GM_DL_RESULT.error.NOT_SUCCEEDED });
    return false;
  }

  if (aName && typeof aName == "string") {
    details.name = aName;
  }

  let nameCheckBlacklist = false;
  if (_GM_DL_NAME_EXTENSION_BLACKLIST
      && (_GM_DL_NAME_EXTENSION.blacklist.length > 0)) {
    nameCheckBlacklist = _GM_DL_NAME_EXTENSION.blacklist.some(function (aItem) {
      return details.name.toLowerCase().endsWith("." + aItem.toLowerCase());
    });
  }
  let nameCheckBlacklistRegexp = false;
  if (_GM_DL_NAME_EXTENSION_BLACKLIST
      && (_GM_DL_NAME_EXTENSION.blacklistRegexp.length > 0)) {
    nameCheckBlacklistRegexp = _GM_DL_NAME_EXTENSION.blacklistRegexp.some(
        function (aItem) {
          return (new RegExp("\\." + aItem + "$", "i")).test(details.name);
        });
  }
  let nameCheckWhitelist = false;
  if (_GM_DL_NAME_EXTENSION.whitelist.length > 0) {
    nameCheckWhitelist = _GM_DL_NAME_EXTENSION.whitelist.some(function (aItem) {
      return details.name.toLowerCase().endsWith("." + aItem.toLowerCase());
    });
  }
  let nameCheckWhitelistRegexp = false;
  if (_GM_DL_NAME_EXTENSION.whitelistRegexp.length > 0) {
    nameCheckWhitelistRegexp = _GM_DL_NAME_EXTENSION.whitelistRegexp.some(
        function (aItem) {
          return (new RegExp("\\." + aItem + "$", "i")).test(details.name);
        });
  }

  if (_GM_DL_NAME_EXTENSION_BLACKLIST
      && (nameCheckBlacklist || nameCheckBlacklistRegexp)) {
    details.onerror({ "error": _GM_DL_RESULT.error.BLACKLISTED });
    return false;
  }
  if (!nameCheckWhitelist && !nameCheckWhitelistRegexp) {
    details.onerror({ "error": _GM_DL_RESULT.error.NOT_WHITELISTED });
    return false;
  }

  let data = {
    "method": "GET",
    "responseType": "blob",
    "url": details.url,

    "onabort": function (aResponse) {
      details.onabort(aResponse);
    },
    "onerror": function (aResponse) {
      message = "\n" + "url: " + details.url;
      message += "\n" + "name: " + details.name;
      message = _GM_DL_L.result.error.download.failed.replace("%1", message);
      details.onerror({
        "details": message,
        "error": _GM_DL_RESULT.error.NOT_SUCCEEDED,
      });
      return false;
    },
    "onload": function (aResponse) {
      let separators = { "headers": "\n", "nameValue": ":" };
      var contentTypeStartsWith = "content-type" + separators.nameValue;
      let responseHeaders = aResponse.responseHeaders.split(separators.headers);
      let contentType = responseHeaders.find(function (aHeader) {
        return aHeader.toLowerCase().trim().startsWith(contentTypeStartsWith);
      });
      if (contentType) {
        contentType = contentType.split(separators.nameValue, 2);
        contentType = contentType[1] ? contentType[1].trim() : undefined;
      }
      let type = details.overrideMimeType || contentType
          || "application/octet-stream";
      let blob = new Blob([aResponse.response], { "type": type });
      let url = URL.createObjectURL(blob);

      let a = document.createElement("a");
      a.setAttribute("href", url);
      a.setAttribute("download", details.name);
      a.setAttribute("style", "display: none;");
      document.documentElement.appendChild(a);

      let event = new MouseEvent("click");
      a.dispatchEvent(event);

      document.documentElement.removeChild(a);

      setTimeout(function () {
        URL.revokeObjectURL(url);
        blob = undefined;
      }, 1000);

      details.onload(aResponse);
    },
    "onprogress": function (aResponse) {
      details.onprogress(aResponse);
    },
    "ontimeout": function (aResponse) {
      details.ontimeout(aResponse);
    },
  };

  for (let i in details) {
    if (!(i in data)) {
      data[i] = details[i];
    }
  }

  try {
    return GM_xmlhttpRequest(data);
  } catch (e) {
    message = "\n" + "error: " + e.toString();
    message += "\n" + "url: " + details.url;
    message += "\n" + "name: " + details.name;
    message = _GM_DL_L.result.error.download.error.replace("%1", message);
    details.onerror({
      "details": message,
      "error": _GM_DL_RESULT.error.NOT_SUCCEEDED,
    });
    return false;
  }
}
