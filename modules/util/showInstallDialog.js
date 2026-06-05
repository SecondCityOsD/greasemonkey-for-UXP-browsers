/**
 * @file showInstallDialog.js
 * @overview Downloads a remote script and opens the Greasemonkey install
 * confirmation dialog, handling HTTP authentication and request lifecycle.
 */

const EXPORTED_SYMBOLS = ["showInstallDialog"];

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

Cu.import("chrome://greasemonkey-modules/content/remoteScript.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


/**
 * Downloads a script and opens the Greasemonkey install confirmation dialog.
 * @param {string|RemoteScript} aUrlOrRemoteScript - A script download URL string, or an existing RemoteScript instance.
 * @param {object} [aBrowser] - The browser element to use; defaults to the current browser window's gBrowser.
 * @param {nsIRequest} [aRequest] - The intercepted HTTP request associated with the install trigger; may be resumed or cancelled.
 * @returns {void}
 */
function showInstallDialog(aUrlOrRemoteScript, aBrowser, aRequest) {
  var rs = null;
  if (typeof aUrlOrRemoteScript == "string") {
    rs = new RemoteScript(aUrlOrRemoteScript);
  } else {
    rs = aUrlOrRemoteScript;
  }

  var browser = aBrowser || GM_util.getBrowserWindow().gBrowser;
  var params = null;
  // opened: did the install dialog actually open?  reported: have we already
  // shown a failure alert?  These let a programmatic install (Install-from-URL
  // or drag-and-drop, which pass no intercepted request) report a clear error
  // when the download finishes without producing a valid user script, instead
  // of failing silently.
  var opened = false;
  var reported = false;
  function openDialog(aScript) {
    opened = true;
    params = [rs, browser, aScript];
    params.wrappedJSObject = params;
    // Don't set "modal" param, or this blocks.
    // Even though we'd prefer the sort of behavior that gives us.
    Cc["@mozilla.org/embedcomp/window-watcher;1"]
        .getService(Ci.nsIWindowWatcher)
        .openWindow(
            /* aParent */ null,
            "chrome://greasemonkey/content/install.xul",
            /* aName */ null,
            "chrome,centerscreen,dialog,titlebar,resizable",
            params);
  }

  let httpChannel;
  let status;
  try {
    httpChannel = aRequest.QueryInterface(Ci.nsIHttpChannel);
    status = httpChannel.responseStatus;
  } catch (e) {
    // Ignore.
  }
  // After successful authentication the user must refresh page.
  // Other solutions have been worse.
  if ((typeof status == "undefined")
      || !GM_CONSTANTS.installScriptReloadStatus.includes(status)) {
    if (rs.script) {
      openDialog(rs.script);
    } else {
      rs.onScriptMeta(function (aRemoteScript, aType, aScript) {
        openDialog(aScript);
      });
    }
  }
  if ((typeof status != "undefined")
      && GM_CONSTANTS.installScriptReloadStatus.includes(status)) {
    rs.cleanup();
  }

  rs.download(function (aSuccess, aType, aStatus, aHeaders) {
    if (aRequest && (aType == "script")) {
      let _cancel = false;
      if (aSuccess
          && GM_CONSTANTS.installScriptBadStatus(aStatus, false)) {
        aRequest.cancel(Cr.NS_BINDING_ABORTED);
        _cancel = true;
      } else if (GM_CONSTANTS.installScriptBadStatus(aStatus, true)) {
        aRequest.cancel(Cr.NS_BINDING_FAILED);
        _cancel = true;
      } else {
        try {
          aRequest.resume();
        } catch (e) {
          /*
          See #1717.
          The HTTP status code: GM_CONSTANTS.installScriptReloadStatus
          If the user unauthorized - throws an error:
            NS_ERROR_UNEXPECTED: Component returned failure code:
              0x8000ffff (NS_ERROR_UNEXPECTED)
          */
          // Ignore.
          if (!(e instanceof Components.Exception)
              || (e.result != Cr.NS_ERROR_UNEXPECTED)) {
            throw e;
          }
        }
      }
      if (_cancel) {
        // See #1717.
        try {
          browser = aRequest
              .QueryInterface(Ci.nsIHttpChannel)
              .notificationCallbacks.getInterface(Ci.nsILoadContext)
              .topFrameElement;
          browser.webNavigation.stop(Ci.nsIWebNavigation.STOP_ALL);
        } catch (e) {
          // Ignore.
          /*
          dump("URL: " + aRequest.URI.spec + "\n"
              + "aRequest.isPending(): " + aRequest.isPending().toString()
              + "\n" + "e:" + "\n" + e);
          */
        }
      }
    }

    // Programmatic install with no intercepted request (Install-from-URL or
    // drag-and-drop): if the download finished without ever opening the
    // install dialog, the URL either failed to download or wasn't a user
    // script — surface that instead of failing silently.  (With an
    // intercepted request the browser's own navigation/error UI covers it;
    // if the dialog opened there's nothing to report.)
    if (!aRequest && !opened && !reported) {
      reported = true;
      let msg = rs.errorMessage;
      if (!msg) {
        let url = (typeof aUrlOrRemoteScript == "string")
            ? aUrlOrRemoteScript
            : (rs._url || "");
        try {
          msg = GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.notUserScript");
        } catch (e) {
          msg = "This URL does not point to a user script.";
        }
        if (url) {
          msg += "\n" + url;
        }
      }
      GM_util.alert(msg);
    }
  });
}
