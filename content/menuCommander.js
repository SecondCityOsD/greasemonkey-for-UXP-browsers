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
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


var GM_MenuCommander = {
  "cookieShowing": null,
  // The tab's windows (the page's and its frames') the open popup asked,
  // by the index each request carried.
  "frames": null,
  "groups": null,
  "messageCookie": 1,
  "popup": null,
};

/** The script ids (namespace/name) whose commands are folded away: a JSON
 *  array.  Keyed by id, not uuid, because the uuid changes with every
 *  update.  Relative to extensions.greasemonkey. */
GM_MenuCommander.COLLAPSED_PREF = "menuCommands.collapsed";

/** The header's arrow: ▲ folds the commands up, ▼ drops them down. */
GM_MenuCommander.ARROW_EXPANDED = "▲";
GM_MenuCommander.ARROW_COLLAPSED = "▼";

// Chrome ↔ sandbox menu-command transport on UXP single-process:
//   chrome → CustomEvent dispatched onto the active tab's page window and
//            each of its frames' (a command runs in the one it came from)
//   sandbox → Services.obs.notifyObservers("greasemonkey:menu-command-
//             response", …) → _observer below → messageMenuCommandResponse
// Both legs stay in-process and avoid any messageManager indirection.
//
// Display model: commands are grouped per owning script.  Each script gets
// a bold header row with its commands beneath it, separators between
// groups; groups are sorted by script name, commands keep their
// registration order.  Responses arrive in one batch per sandbox (script ×
// frame), so the popup is rebuilt from the accumulated groups on every
// batch.
//
// A header row folds its script's commands away and back (▲ / ▼ on the
// right).  It keeps the menu open (closemenu="none"), works from the
// keyboard too, and only hides or shows rows; the folded scripts are
// remembered in the menuCommands.collapsed pref.

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
  // Dispatch the run-command CustomEvent onto the window the command came
  // from: the page's, or a frame's.  The sandbox listens for
  // "greasemonkey-menu-command-run-<suffix>" and invokes the registered
  // callback for the matching {cookie, scriptUuid}.
  let win = aCommand.frameWin || gBrowser.selectedBrowser.contentWindow;
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
  // options.title (Violentmonkey / Tampermonkey), else the script's name.
  menuItem.setAttribute("tooltiptext", aCommand.title || aCommand.scriptName);
  if (aCommand.autoClose === false) {
    // options.autoClose: false keeps the menu open after a click.
    menuItem.setAttribute("closemenu", "none");
  }
  menuItem.addEventListener("command", function () {
    GM_MenuCommander.commandClicked(aCommand);
  }, false);

  if (aCommand.accesskey) {
    menuItem.setAttribute("accesskey", aCommand.accesskey);
  }

  return menuItem;
};

GM_MenuCommander.messageMenuCommandResponse = function (aMessage) {
  // The request this answers: {"popup": the popup's cookie, "frame": the
  // index of the window it went to}, as JSON.
  let request = null;
  try {
    request = JSON.parse(aMessage.data.cookie);
  } catch (e) {
    request = null;
  }
  if (!request || (request.popup != GM_MenuCommander.cookieShowing)) {
    return undefined;
  }
  if (!GM_MenuCommander.groups || !GM_MenuCommander.frames) {
    // Late response after the popup already hid.
    return undefined;
  }
  let frameWin = GM_MenuCommander.frames[request.frame] || null;

  // Fold the batch into the per-script groups.  A command's key (its
  // options.id, else its caption) that arrives again replaces the earlier
  // one, so the same script running in several frames doesn't produce
  // duplicate rows.  Null-prototype maps: keys are script-controlled
  // strings ("__proto__" must stay an ordinary key).
  let groups = GM_MenuCommander.groups;
  for (let i in aMessage.data.commands) {
    let command = aMessage.data.commands[i];
    command.frameWin = frameWin;
    let group = groups[command.scriptUuid];
    if (!group) {
      group = groups[command.scriptUuid] = {
        "byKey": Object.create(null),
        "order": [],
        "scriptId": GM_MenuCommander.scriptIdForUuid(command.scriptUuid),
        "scriptName": String(command.scriptName),
      };
    }
    let key = String(command.cookie);
    if (!(key in group.byKey)) {
      group.order.push(key);
    }
    group.byKey[key] = command;
  }

  GM_MenuCommander.rebuildPopup();
};

/**
 * @param {Window} aWin - A tab's page.
 * @returns {Window[]} It and every frame in it, at any depth: each runs its
 *   own scripts, with their own menu commands.
 */
GM_MenuCommander.framesOf = function (aWin) {
  let wins = [aWin];
  try {
    for (let i = 0; i < aWin.frames.length; i++) {
      wins.push.apply(wins, GM_MenuCommander.framesOf(aWin.frames[i]));
    }
  } catch (e) {
    // A frame going away: skip it.
  }
  return wins;
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

  let collapsedIds = GM_MenuCommander.collapsedIds();
  let total = 0;
  for (let u = 0, uLen = uuids.length; u < uLen; u++) {
    let group = groups[uuids[u]];
    if (u > 0) {
      popup.appendChild(document.createElement("menuseparator"));
    }
    let collapsed = collapsedIds.indexOf(group.scriptId) != -1;
    let header = document.createElement("menuitem");
    header.setAttribute("class", "greasemonkey-command-script-header");
    header.setAttribute("label", group.scriptName);
    // Clicking it folds or unfolds, and leaves the menu open.
    header.setAttribute("closemenu", "none");
    popup.appendChild(header);
    let items = [];
    for (let c = 0, cLen = group.order.length; c < cLen; c++) {
      let item = GM_MenuCommander.createMenuItem(
          group.byKey[group.order[c]]);
      items.push(item);
      popup.appendChild(item);
      total++;
    }
    GM_MenuCommander.showCollapsed(header, items, collapsed);
    header.addEventListener("command", function () {
      let fold = (header.getAttribute("collapsed-commands") != "true");
      GM_MenuCommander.showCollapsed(header, items, fold);
      GM_MenuCommander.setCollapsed(group.scriptId, fold);
    }, false);
  }

  popup.parentNode.disabled = (total == 0);
};

/**
 * Folds a script's commands away (or shows them) and sets its header's
 * arrow.
 * @param {Element} aHeader - The script's header row.
 * @param {Element[]} aItems - Its command rows.
 * @param {boolean} aCollapsed
 */
GM_MenuCommander.showCollapsed = function (aHeader, aItems, aCollapsed) {
  aHeader.setAttribute("collapsed-commands", String(aCollapsed));
  aHeader.setAttribute("acceltext", aCollapsed
      ? GM_MenuCommander.ARROW_COLLAPSED : GM_MenuCommander.ARROW_EXPANDED);
  for (let i = 0, iLen = aItems.length; i < iLen; i++) {
    aItems[i].hidden = aCollapsed;
  }
};

/** @returns {string[]} The ids of the scripts whose commands are folded. */
GM_MenuCommander.collapsedIds = function () {
  try {
    let ids = JSON.parse(
        GM_prefRoot.getValue(GM_MenuCommander.COLLAPSED_PREF, "[]"));
    return Array.isArray(ids) ? ids : [];
  } catch (e) {
    return [];
  }
};

/**
 * Remembers whether a script's commands are folded.  Ids of scripts that
 * are no longer installed are dropped on the way, so uninstalls clean up
 * after themselves.
 * @param {string} aScriptId
 * @param {boolean} aCollapsed
 */
GM_MenuCommander.setCollapsed = function (aScriptId, aCollapsed) {
  let installed = GM_util.getService().config.scripts.map(function (aScript) {
    return aScript.id;
  });
  let ids = GM_MenuCommander.collapsedIds().filter(function (aId) {
    return (aId != aScriptId) && (installed.indexOf(aId) != -1);
  });
  if (aCollapsed) {
    ids.push(aScriptId);
  }
  GM_prefRoot.setValue(GM_MenuCommander.COLLAPSED_PREF, JSON.stringify(ids));
};

/**
 * @param {string} aUuid - A command's scriptUuid.
 * @returns {string} The script's id (namespace/name), which survives
 *          updates; the uuid itself for a script the config doesn't know.
 */
GM_MenuCommander.scriptIdForUuid = function (aUuid) {
  let scripts = GM_util.getService().config.scripts;
  for (let i = 0, iLen = scripts.length; i < iLen; i++) {
    if (scripts[i].uuid == aUuid) {
      return scripts[i].id;
    }
  }
  return String(aUuid);
};

GM_MenuCommander.onPopupHiding = function () {
  GM_MenuCommander.groups = null;
  GM_MenuCommander.frames = null;
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

  // ...ask each sandbox running on the active tab, in its page and in every
  // frame, for its registered commands by dispatching a CustomEvent onto
  // each window (a sandbox listens on its own: commands from scripts in
  // frames never showed).  Each sandbox replies via the
  // "greasemonkey:menu-command-response" observer notification, which
  // _observer above feeds into messageMenuCommandResponse.
  let win = gBrowser.selectedBrowser.contentWindow;
  if (!win) {
    return undefined;
  }
  GM_MenuCommander.frames = GM_MenuCommander.framesOf(win);
  GM_MenuCommander.frames.forEach(function (aWin, aIndex) {
    try {
      let evt = new aWin.CustomEvent(
          "greasemonkey-menu-command-list-" + MenuCommandEventNameSuffix, {
            "detail": JSON.stringify({
              "frame": aIndex,
              "popup": GM_MenuCommander.cookieShowing,
            }),
          });
      aWin.dispatchEvent(evt);
    } catch (e) {
      // A frame going away: no commands from it.
    }
  });
};
