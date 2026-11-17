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
  Cu.import("chrome://greasemonkey-modules/content/util.js");

  GM_guardScratchpadSaves(Scratchpad);
  // A new script closed without saving leaves no draft behind.
  window.addEventListener("unload", function () {
    GM_editorSave.removeDraft(Scratchpad.filename);
  }, false);

  // If we're opening a user script:
  // Put the cursor at the top.
  var initializeCheckCount = 0;
  var initializeMaxCount = 50;
  var initializeCheckTimer = null;
  // ms
  let initializeInterval = 20;
  function moveCursorToTop() {
    if (initializeCheckCount > initializeMaxCount) {
      GM_util.logError(
          GM_CONSTANTS.info.scriptHandler + " - "
          + GM_CONSTANTS.localeStringBundle.createBundle(
              GM_CONSTANTS.localeGreasemonkeyProperties)
              .GetStringFromName("error.scratchpad.notInitialized"));
      clearInterval(initializeCheckTimer);
    }
    initializeCheckCount++;

    if (!Scratchpad.initialized) {
      return undefined;
    }

    Scratchpad.editor.setCursor({
      "line": 0,
      "ch": 0,
    });

    clearInterval(initializeCheckTimer);
  }
  initializeCheckTimer = setInterval(moveCursorToTop, initializeInterval);

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
        // Save again, now as the installed script's file: the text may
        // have changed while its @require files downloaded.
        this.setFilename(aScript.file.path);
        this.saveFile(aCallback);
      }, {"skipEditor": true});
      return undefined;
    }

    scratchpadSave.call(this, function (aStatus) {
      if (result.script && Components.isSuccessCode(aStatus)) {
        GM_util.getService().config.updateModifiedScripts();
      }
      done(aStatus);
    });
  };
}
