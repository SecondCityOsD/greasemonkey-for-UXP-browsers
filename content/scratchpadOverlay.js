// Scratchpad as Greasemonkey's built-in script editor.  Scratchpad's own
// scratchpad.js defines Cc / Ci / Cu in this window, but not Services:
// that is imported below with the other modules.
window.addEventListener("load", function () {
  Cu.import("chrome://greasemonkey-modules/content/constants.js");


  const FILE_SCRIPT_EXTENSION_REGEXP = new RegExp(
      GM_CONSTANTS.fileScriptExtensionRegexp + "$", "");

  let args = window.arguments;
  if (!args) {
    return undefined;
  }
  if (!(args[0] instanceof Ci.nsIDialogParamBlock)) {
    return undefined;
  }
  args = args[0].GetString(1);
  if (!args) {
    return undefined;
  }
  args = JSON.parse(args);
  if (!args.filename) {
    return undefined;
  }
  if (!FILE_SCRIPT_EXTENSION_REGEXP.test(args.filename)) {
    return undefined;
  }

  Cu.import("resource://gre/modules/Services.jsm");

  Cu.import("chrome://greasemonkey-modules/content/editorSave.js");
  Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
  Cu.import("chrome://greasemonkey-modules/content/util.js");

  GM_guardScratchpadSaves(Scratchpad);
  // A new script closed without saving leaves no draft behind.
  window.addEventListener("unload", function () {
    GM_editorSave.removeDraft(Scratchpad.filename);
  }, false);

  // The cursor at the top once the editor is in.
  Scratchpad.addObserver({
    "onReady": function () {
      Scratchpad.editor.setCursor({"line": 0, "ch": 0});
    },
  });

  // Preferences > Advanced > "Enhance the Scratchpad editor": its title,
  // toolbar, Metadata summary, folding, hints and the warnings bar
  // (scratchpadTools.js).  Off, Scratchpad is as it always was.
  let enhanced = GM_prefRoot.getValue(GM_SP_ENHANCED_PREF, true);
  if (enhanced) {
    GM_ScratchpadTools.init(Scratchpad);
  }

  // Hide all the elements which don't make sense when editing a script.
  // See #1771 and #1774.

  // The Main Menu and the keyboard shortcuts for them.
  let mainMenuNodes = [
    {
      "id": "sp-execute-menu",
      "attribute": "collapsed",
      "value": true,
    },
    {
      "id": "sp-environment-menu",
      "attribute": "collapsed",
      "value": true,
    },
    {
      "id": "sp-toolbar-run",
      "attribute": "collapsed",
      "value": true,
    },
    {
      "id": "sp-toolbar-inspect",
      "attribute": "collapsed",
      "value": true,
    },
    {
      "id": "sp-toolbar-display",
      "attribute": "collapsed",
      "value": true,
    },
    {
      "id": "sp-key-run",
      "attribute": "disabled",
      "value": true,
    },
    {
      "id": "sp-key-inspect",
      "attribute": "disabled",
      "value": true,
    },
    {
      "id": "sp-key-display",
      "attribute": "disabled",
      "value": true,
    },
    {
      "id": "sp-key-evalFunction",
      "attribute": "disabled",
      "value": true,
    },
    {
      "id": "sp-key-reloadAndRun",
      "attribute": "disabled",
      "value": true,
    },
  ];

  if (enhanced) {
    // Pretty Print reformats the whole script, metadata block and all.
    mainMenuNodes.push(
        {"id": "sp-toolbar-pprint", "attribute": "collapsed", "value": true},
        {"id": "sp-menu-pprint", "attribute": "collapsed", "value": true},
        {"id": "sp-cmd-pprint", "attribute": "disabled", "value": true});
  }

  for (let i = 0, iLen = mainMenuNodes.length; i < iLen; i++) {
    let mainMenuNode = mainMenuNodes[i];
    let el = document.getElementById(mainMenuNode.id);
    if (el) {
      el.setAttribute(mainMenuNode.attribute, mainMenuNode.value);
    }
  }

  // The Context Menu.
  let contextMenuNodes = [
    {
      "id": "sp-text-run",
      "previous": true,
    },
    {
      "id": "sp-text-inspect",
      "previous": false,
    },
    {
      "id": "sp-text-display",
      "previous": false,
    },
    {
      "id": "sp-text-evalFunction",
      "previous": false,
    },
    {
      "id": "sp-text-reloadAndRun",
      "previous": true,
    },
  ];

  let contextMenu = document.getElementById("scratchpad-text-popup");
  if (contextMenu) {
    for (let i = 0, iLen = contextMenu.childNodes.length; i < iLen; i++) {
      let contextMenuChildNode = contextMenu.childNodes[i];
      loop2:
      for (let j = 0, jLen = contextMenuNodes.length; j < jLen; j++) {
        let contextMenuNode = contextMenuNodes[j];
        if (contextMenuChildNode.id == contextMenuNode.id) {
          contextMenuChildNode.collapsed = true;
          if (contextMenuNode.previous) {
            if (contextMenuChildNode.previousSibling
                && (contextMenuChildNode.previousSibling.tagName.toLowerCase()
                == "menuseparator")) {
              contextMenuChildNode.previousSibling.collapsed = true;
            }
          }
          break loop2;
        }
      }
    }
  }
}, true);

/**
 * Routes Scratchpad's saves through GM_editorSave first.  Ctrl+S, the
 * File menu's Save and the save offered on closing all call
 * Scratchpad.saveFile, and Scratchpad keeps a window open when its save
 * reports a failure.
 *
 * - A refused save (a duplicate @name and @namespace, or a draft that
 *   doesn't parse) shows why and writes nothing.
 * - A new script's draft is installed by its first good save; the editor
 *   then edits the installed file.
 * - An installed script's save is written, then read at once, instead of
 *   at the next page load.
 * - A save that goes ahead with lines the parser ignores (a @match it
 *   can't use, say) says so in Scratchpad's notification bar, when the
 *   editor is enhanced (see GM_SP_ENHANCED_PREF).
 * - Each good save tells scratchpadTools.js (a GM_ScratchpadSaved event):
 *   a new script is installed now, and its name may have changed.
 *
 * @param {object} aScratchpad - This window's Scratchpad object.
 * @returns {void}
 */
function GM_guardScratchpadSaves(aScratchpad) {
  let scratchpadSave = aScratchpad.saveFile;
  let installing = false;

  function refuse(aMessage) {
    Services.prompt.alert(window, GM_CONSTANTS.info.scriptHandler, aMessage);
  }

  // Scratchpad's own notification bar: the browser window's "installed
  // successfully" popup was shown while Scratchpad had the focus, so it
  // was dismissed before anyone saw it.  Null where there's none.
  function noticeBox() {
    try {
      return aScratchpad.notificationBox
          || document.getElementById("scratchpad-notificationbox");
    } catch (e) {
      return null;
    }
  }

  function noticeInstalled(aScript) {
    let box = noticeBox();
    if (!box) {
      return undefined;
    }
    let old = box.getNotificationWithValue("greasemonkey-installed");
    if (old) {
      box.removeNotification(old);
    }
    box.appendNotification(
        "(" + aScript.localized.name + ") "
        + GM_CONSTANTS.localeStringBundle.createBundle(
            GM_CONSTANTS.localeGmBrowserProperties)
            .GetStringFromName("script.installed"),
        "greasemonkey-installed", null, box.PRIORITY_INFO_MEDIUM, null);
    return undefined;
  }

  // The parser's warnings about the text just saved, in place of the last
  // save's; none, nothing.
  function noticeWarnings(aWarnings) {
    let box = noticeBox();
    if (!box || !GM_prefRoot.getValue(GM_SP_ENHANCED_PREF, true)) {
      return undefined;
    }
    let old = box.getNotificationWithValue("greasemonkey-warnings");
    if (old) {
      box.removeNotification(old);
    }
    if (aWarnings.length) {
      box.appendNotification(
          GM_ScratchpadTools.string("scratchpad.savedWithWarnings",
              "Saved, with warnings: %1")
              .replace("%1", function () {
                return aWarnings.join("  \u2022  ");
              }),
          "greasemonkey-warnings", null, box.PRIORITY_WARNING_LOW, null);
    }
    return undefined;
  }

  aScratchpad.saveFile = function (aCallback) {
    let done = function (aStatus) {
      if (aCallback) {
        aCallback(aStatus);
      }
    };
    if (installing) {
      // The previous save is still installing the draft.
      done(Components.results.NS_ERROR_FAILURE);
      return undefined;
    }

    let text = this.getText();
    let result = GM_editorSave.check(this.filename, text);
    if (result.problem) {
      refuse(result.problem);
      done(Components.results.NS_ERROR_FAILURE);
      return undefined;
    }

    if (result.draft) {
      installing = true;
      let draftPath = this.filename;
      GM_util.installScriptFromSource(text, (aErr, aScript) => {
        installing = false;
        if (aErr || !aScript) {
          refuse(GM_editorSave.notSaved(
              aErr ? (aErr.message || String(aErr)) : ""));
          done(Components.results.NS_ERROR_FAILURE);
          return undefined;
        }
        GM_editorSave.removeDraft(draftPath);
        noticeInstalled(aScript);
        // Save again, now as the installed script's file: the text may
        // have changed while its @require files downloaded.
        this.setFilename(aScript.file.path);
        this.saveFile(aCallback);
      }, {
        // Its alert reports a failure; the success shows in its own bar
        // (the browser's popup where it has none).
        "reportsFailures": true,
        "silent": !!noticeBox(),
        "skipEditor": true,
      });
      return undefined;
    }

    scratchpadSave.call(this, function (aStatus) {
      if (result.script && Components.isSuccessCode(aStatus)) {
        GM_util.getService().config.updateModifiedScripts();
        noticeWarnings(result.warnings);
        window.dispatchEvent(new CustomEvent("GM_ScratchpadSaved"));
      }
      done(aStatus);
    });
  };
}
