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
  function openDialog(aScript) {
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
      || !GM_util.inArray(GM_CONSTANTS.installScriptReloadStatus, status)) {
    if (rs.script) {
      openDialog(rs.script);
    } else {
      rs.onScriptMeta(function (aRemoteScript, aType, aScript) {
        openDialog(aScript);
      });
    }
  }
  if ((typeof status != "undefined")
      && GM_util.inArray(GM_CONSTANTS.installScriptReloadStatus, status)) {
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
  });
}
