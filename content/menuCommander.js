if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

// Strict mode:
// TypeError: setting a property that has only a getter
// Cu.import("resource://gre/modules/Services.jsm");

Cu.import("chrome://greasemonkey-modules/content/menuCommand.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


var GM_MenuCommander = {
  "cookieShowing": null,
  "messageCookie": 1,
  "popup": null,
};

// Chrome ↔ sandbox menu-command transport on UXP single-process:
//   chrome → CustomEvent dispatched onto the active tab's content window
//   sandbox → Services.obs.notifyObservers("greasemonkey:menu-command-
//             response", …) → _observer below → messageMenuCommandResponse
// Both legs stay in-process and avoid any messageManager indirection.

/**
 * Bridge object passed to Services.obs.addObserver.  The platform calls
 * .observe(subject, topic, data); we re-shape the payload into the
 * { data: payload } shape expected by messageMenuCommandResponse.
 */
GM_MenuCommander._observer = {
  "observe": function (aSubject, aTopic, aData) {
    if (aTopic !== "greasemonkey:menu-command-response") {
      return undefined;
    }
    let payload;
    try {
      payload = JSON.parse(aData);
    } catch (e) {
      return undefined;
    }
    GM_MenuCommander.messageMenuCommandResponse({ "data": payload });
  },
};

GM_MenuCommander.initialize = function () {
  Services.obs.addObserver(GM_MenuCommander._observer,
      "greasemonkey:menu-command-response", false);
};

GM_MenuCommander.uninitialize = function () {
  Services.obs.removeObserver(GM_MenuCommander._observer,
      "greasemonkey:menu-command-response");
};

GM_MenuCommander.commandClicked = function (aCommand) {
  // Dispatch the run-command CustomEvent directly onto the active tab's
  // content window.  The sandbox listens for
  // "greasemonkey-menu-command-run-<suffix>" and invokes the registered
  // callback for the matching {cookie, scriptUuid}.
  let win = gBrowser.selectedBrowser.contentWindow;
  if (!win) {
    return undefined;
  }
  let evt = new win.CustomEvent(
      "greasemonkey-menu-command-run-" + MenuCommandEventNameSuffix, {
        "detail": JSON.stringify({
          "cookie": aCommand.cookie,
          "scriptUuid": aCommand.scriptUuid,
        }),
      });
  win.dispatchEvent(evt);
};

GM_MenuCommander.createMenuItem = function (aCommand) {
  let menuItem = document.createElement("menuitem");
  menuItem.setAttribute("label", aCommand.name);
  menuItem.setAttribute("tooltiptext", aCommand.scriptName);
  menuItem.addEventListener("command", function () {
    GM_MenuCommander.commandClicked(aCommand);
  }, false);

  if (aCommand.accesskey) {
    menuItem.setAttribute("accesskey", aCommand.accesskey);
  }

  menuItem.setAttribute("_object", JSON.stringify(aCommand));

  return menuItem;
};

GM_MenuCommander.messageMenuCommandResponse = function (aMessage) {
  if (aMessage.data.cookie != GM_MenuCommander.cookieShowing) {
    return undefined;
  }

  for (let i in aMessage.data.commands) {
    let command = aMessage.data.commands[i];
    let menuItem = GM_MenuCommander.createMenuItem(command);
    let menuItems = GM_MenuCommander.popup.childNodes;
    let menuItemExists = false;
    for (let i = 0, iLen = menuItems.length; i < iLen; i++) {
      if (JSON.stringify(command) == menuItems[i].getAttribute("_object")) {
        menuItemExists = true;
        break;
      }
    }
    if (!menuItemExists) {
      GM_MenuCommander.popup.appendChild(menuItem);
    }
  }
  if (GM_MenuCommander.popup.firstChild) {
    GM_MenuCommander.popup.parentNode.disabled = false;
  }
};

GM_MenuCommander.onPopupHiding = function () {
  // See #1632.
  // Asynchronously.
  GM_util.timeout(function () {
    GM_util.emptyElm(GM_MenuCommander.popup);
  }, 0);
};

GM_MenuCommander.onPopupShowing = function (aEventTarget) {
  GM_MenuCommander.popup = aEventTarget.querySelector(
      "menupopup.greasemonkey-user-script-commands-popup");

  GM_MenuCommander.messageCookie++;
  GM_MenuCommander.cookieShowing = GM_MenuCommander.messageCookie;

  // Start disabled and empty...
  GM_MenuCommander.popup.parentNode.disabled = true;
  GM_util.emptyElm(GM_MenuCommander.popup);

  // ...ask each sandbox running on the active tab for its registered
  // commands by dispatching a CustomEvent directly onto the content
  // window.  Each sandbox replies via the
  // "greasemonkey:menu-command-response" observer notification, which
  // _observer above feeds into messageMenuCommandResponse.
  let win = gBrowser.selectedBrowser.contentWindow;
  if (!win) {
    return undefined;
  }
  let evt = new win.CustomEvent(
      "greasemonkey-menu-command-list-" + MenuCommandEventNameSuffix, {
        "detail": GM_MenuCommander.cookieShowing,
      });
  win.dispatchEvent(evt);
};
