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
  "groups": null,
  "messageCookie": 1,
  "popup": null,
};

// Chrome ↔ sandbox menu-command transport on UXP single-process:
//   chrome → CustomEvent dispatched onto the active tab's content window
//   sandbox → Services.obs.notifyObservers("greasemonkey:menu-command-
//             response", …) → _observer below → messageMenuCommandResponse
// Both legs stay in-process and avoid any messageManager indirection.
//
// Display model: commands are grouped per owning script.  Each script gets
// a bold non-clickable header row with its commands beneath it, separators
// between groups; groups are sorted by script name, commands keep their
// registration order.  Responses arrive in one batch per sandbox (script ×
// frame), so the popup is rebuilt from the accumulated groups on every
// batch.

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
  menuItem.setAttribute("class", "greasemonkey-command-item");
  menuItem.setAttribute("label", aCommand.name);
  menuItem.setAttribute("tooltiptext", aCommand.scriptName);
  menuItem.addEventListener("command", function () {
    GM_MenuCommander.commandClicked(aCommand);
  }, false);

  if (aCommand.accesskey) {
    menuItem.setAttribute("accesskey", aCommand.accesskey);
  }

  return menuItem;
};

GM_MenuCommander.messageMenuCommandResponse = function (aMessage) {
  if (aMessage.data.cookie != GM_MenuCommander.cookieShowing) {
    return undefined;
  }
  if (!GM_MenuCommander.groups) {
    // Late response after the popup already hid.
    return undefined;
  }

  // Fold the batch into the per-script groups.  A (scriptUuid, name) pair
  // that arrives again replaces the earlier registration, so scripts that
  // re-register and the same script running in several frames don't
  // produce duplicate rows.  Null-prototype maps: command names are
  // script-controlled strings ("__proto__" must stay an ordinary key).
  let groups = GM_MenuCommander.groups;
  for (let i in aMessage.data.commands) {
    let command = aMessage.data.commands[i];
    let group = groups[command.scriptUuid];
    if (!group) {
      group = groups[command.scriptUuid] = {
        "byName": Object.create(null),
        "order": [],
        "scriptName": String(command.scriptName),
      };
    }
    if (!(command.name in group.byName)) {
      group.order.push(command.name);
    }
    group.byName[command.name] = command;
  }

  GM_MenuCommander.rebuildPopup();
};

GM_MenuCommander.rebuildPopup = function () {
  let popup = GM_MenuCommander.popup;
  let groups = GM_MenuCommander.groups;
  if (!popup || !groups) {
    return undefined;
  }

  GM_util.emptyElm(popup);

  let uuids = Object.keys(groups);
  uuids.sort(function (aA, aB) {
    return groups[aA].scriptName.localeCompare(groups[aB].scriptName);
  });

  let total = 0;
  for (let u = 0, uLen = uuids.length; u < uLen; u++) {
    let group = groups[uuids[u]];
    if (u > 0) {
      popup.appendChild(document.createElement("menuseparator"));
    }
    let header = document.createElement("menuitem");
    header.setAttribute("class", "greasemonkey-command-script-header");
    header.setAttribute("disabled", "true");
    header.setAttribute("label", group.scriptName);
    popup.appendChild(header);
    for (let c = 0, cLen = group.order.length; c < cLen; c++) {
      popup.appendChild(
          GM_MenuCommander.createMenuItem(group.byName[group.order[c]]));
      total++;
    }
  }

  popup.parentNode.disabled = (total == 0);
};

GM_MenuCommander.onPopupHiding = function () {
  GM_MenuCommander.groups = null;
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
  GM_MenuCommander.groups = Object.create(null);

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
