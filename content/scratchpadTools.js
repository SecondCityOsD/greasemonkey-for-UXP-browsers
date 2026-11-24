/**
 * @file scratchpadTools.js
 * @overview Scratchpad as a user script editor, beyond saving (that is
 *   scratchpadOverlay.js, which starts this for a user script only):
 *   - the window is titled with the script's name and version, not its
 *     file's path;
 *   - toolbar buttons: Options, View and Open Folder for the installed
 *     script, and Metadata, which shows or hides a summary of what the
 *     script declares (where it runs, what it may use, the parser's
 *     warnings) above the code, kept up to date as you type;
 *   - code folding;
 *   - hints as you type: the metadata keywords after "// @", the values
 *     of @grant, @run-at and @inject-into, and the GM API names after
 *     "GM_" or "GM." in the code.  (Ctrl+Space stays Scratchpad's own
 *     completion.)
 *
 * All of it only with Preferences > Advanced > "Enhance the Scratchpad
 * editor" ticked (GM_SP_ENHANCED_PREF); unticked, Scratchpad is as it
 * always was.  Everything here is guarded: a part Scratchpad doesn't
 * offer (an older build, Pale Moon's) is left out, and the editor still
 * works.
 */

/** Whether Scratchpad gets these tools (relative to extensions.greasemonkey). */
const GM_SP_ENHANCED_PREF = "scratchpad.enhanced";

/** The Metadata summary shows this many values in a row, then "+N more". */
const GM_SP_META_MAX_VALUES = 4;

/** Typing stops this long before the summary and the title follow it. */
const GM_SP_REPARSE_MS = 600;

/** CodeMirror's hint add-on, as Scratchpad's own completion loads it. */
const GM_SP_SHOW_HINT_URL =
    "chrome://devtools/content/sourceeditor/codemirror/addon/hint/show-hint.js";

/** Whether the Metadata summary is shown (relative to extensions.greasemonkey). */
const GM_SP_META_PREF = "scratchpad.metadata";

/** The metadata keywords Greasemonkey reads (parseScript.js). */
const GM_SP_META_KEYWORDS = [
  "antifeature", "author", "connect", "contributionURL", "copyright",
  "description", "downloadURL", "exclude", "exclude-match", "grant",
  "homepage", "homepageURL", "icon", "icon64", "include", "inject-into",
  "installURL", "match", "name", "namespace", "noframes", "require",
  "resource", "run-at", "source", "supportURL", "topLevelAwait", "unwrap",
  "updateURL", "version", "website",
];

/** The values the hints offer after a keyword (@grant's: the API names). */
const GM_SP_META_VALUES = {
  "inject-into": ["auto", "content", "page"],
  "run-at": ["document-body", "document-end", "document-idle",
    "document-start"],
};

/** What @grant can name besides the GM APIs. */
const GM_SP_GRANT_EXTRAS = ["none", "window.close", "window.focus",
  "window.onurlchange"];

/**
 * The Metadata summary's rows: the keywords each covers (to find their
 * line), its label (as the source viewer's header has it) and how its
 * values are read from the parsed script.
 */
const GM_SP_META_ROWS = [
  {"id": "runsOn", "keywords": ["match", "include"],
    "label": "sourceViewer.meta.runsOn",
    "fallback": "Runs on (@match, @include):"},
  {"id": "notOn", "keywords": ["exclude", "exclude-match"],
    "label": "sourceViewer.meta.notOn",
    "fallback": "Doesn't run on (@exclude, @exclude-match):"},
  {"id": "runAt", "keywords": ["run-at", "noframes"],
    "label": "install.runAt", "fallback": "Runs at (@run-at):"},
  {"id": "grants", "keywords": ["grant"],
    "label": "install.grants", "fallback": "Permissions (@grant):"},
  {"id": "connects", "keywords": ["connect"],
    "label": "install.connects", "fallback": "Can connect to (@connect):"},
  {"id": "requires", "keywords": ["require"],
    "label": "install.requires", "fallback": "Code it loads (@require):"},
  {"id": "resources", "keywords": ["resource"],
    "label": "install.resources", "fallback": "Files it loads (@resource):"},
  {"id": "errors", "keywords": [], "kind": "error",
    "label": "scratchpad.meta.errors", "fallback": "Errors:"},
  {"id": "warnings", "keywords": [], "kind": "warning",
    "label": "scratchpad.meta.warnings", "fallback": "Warnings:"},
];

var GM_ScratchpadTools = {
  "_apis": null,
  "_bundles": null,
  "_parse": null,
  "_reparseTimer": null,
  "_scratchpad": null,
  "_title": null,

  /**
   * @param {object} aScratchpad - This window's Scratchpad.
   * @returns {void}
   */
  "init": function (aScratchpad) {
    this._scratchpad = aScratchpad;
    this._bundles = [GM_CONSTANTS.localeGreasemonkeyProperties,
        GM_CONSTANTS.localeGmBrowserProperties].map(function (aUrl) {
      try {
        return GM_CONSTANTS.localeStringBundle.createBundle(aUrl);
      } catch (e) {
        return null;
      }
    }).filter(Boolean);
    this._apis = this.apiNames();
    this._parse = Cu.import(
        "chrome://greasemonkey-modules/content/parseScript.js", {}).parse;

    this._titleWithScriptName();
    this._addToolbarButtons();
    this._addMetadataSummary();

    let tools = this;
    aScratchpad.addObserver({
      "onReady": function () {
        tools._editorReady();
      },
    });
    window.addEventListener("GM_ScratchpadSaved", function () {
      tools._updateButtons();
      tools._reparse();
    }, false);
  },

  /** Once the editor is in: folding, hints, the summary. */
  "_editorReady": function () {
    let editor = this._scratchpad.editor;
    try {
      editor.setOption("enableCodeFolding", true);
    } catch (e) {
      // An editor without folding.
    }
    this._setUpHints(editor);
    let tools = this;
    editor.on("change", function () {
      if (tools._reparseTimer) {
        clearTimeout(tools._reparseTimer);
      }
      tools._reparseTimer = setTimeout(function () {
        tools._reparseTimer = null;
        tools._reparse();
      }, GM_SP_REPARSE_MS);
    });
    this._reparse();
  },

  /**
   * @param {string} aKey
   * @param {string} aFallback - English, when no bundle has aKey.
   * @returns {string}
   */
  "string": function (aKey, aFallback) {
    for (let i = 0; i < this._bundles.length; i++) {
      try {
        return this._bundles[i].GetStringFromName(aKey);
      } catch (e) {
        // Not in this one.
      }
    }
    return aFallback;
  },

  /**
   * @returns {string[]} The names the hints offer in code: GM_info and
   *   every GM_ API with its GM. twin, and unsafeWindow, sorted.
   */
  "apiNames": function () {
    let names = ["GM_info", "GM.info"];
    GM_CONSTANTS.addonAPI.forEach(function (aName) {
      names.push(aName);
      if (aName.indexOf(GM_CONSTANTS.addonAPIPrefix1) == 0) {
        names.push(GM_CONSTANTS.addonAPIPrefix2
            + (GM_CONSTANTS.addonAPIConversion[aName]
                || aName.slice(GM_CONSTANTS.addonAPIPrefix1.length)));
      }
    });
    return names.sort();
  },

  /**
   * What a hint at the end of aLine would complete.
   *
   * @param {string}  aLine - The line, up to the cursor.
   * @param {boolean} aInHeader - The line is inside the metadata block.
   * @returns {?{start: number, list: string[]}} start: where the word
   *   being completed begins; null for nothing to offer.
   */
  "hintFor": function (aLine, aInHeader) {
    if (aInHeader) {
      let keyword = /^(\s*\/\/\s*@)([\w.:-]*)$/.exec(aLine);
      if (keyword) {
        return this._hintFrom(
            keyword[1].length, keyword[2], GM_SP_META_KEYWORDS);
      }
      let value = /^\s*\/\/\s*@([\w.:-]+)\s+(\S*)$/.exec(aLine);
      if (value) {
        let words = (value[1] == "grant")
            ? GM_SP_GRANT_EXTRAS.concat(this._apis)
            : GM_SP_META_VALUES[value[1]];
        if (words) {
          return this._hintFrom(
              aLine.length - value[2].length, value[2], words);
        }
      }
      return null;
    }
    let api = /(?:^|[^\w$.])((?:GM[_.]|unsafeW)[\w$.]*)$/.exec(aLine);
    if (api) {
      return this._hintFrom(aLine.length - api[1].length, api[1], this._apis);
    }
    return null;
  },

  "_hintFrom": function (aStart, aTyped, aWords) {
    let typed = aTyped.toLowerCase();
    let list = aWords.filter(function (aWord) {
      return (aWord != aTyped) && (aWord.toLowerCase().indexOf(typed) == 0);
    });
    return list.length ? {"start": aStart, "list": list} : null;
  },

  /**
   * @param {function(number): string} aLineAt - A line's text by number.
   * @param {number} aLine - A line number.
   * @returns {boolean} Whether aLine is inside the ==UserScript== block.
   */
  "inHeader": function (aLineAt, aLine) {
    for (let i = aLine; (i >= 0) && (i > aLine - 1000); i--) {
      let text = aLineAt(i);
      if (/^\s*\/\/\s*==\/UserScript==/.test(text)) {
        return false;
      }
      if (/^\s*\/\/\s*==UserScript==/.test(text)) {
        return i < aLine;
      }
    }
    return false;
  },

  /**
   * Hints open by themselves as you type where they can help (after
   * "// @", "GM_", "GM."), through CodeMirror's hint add-on.
   */
  "_setUpHints": function (aEditor) {
    let cm;
    let win;
    try {
      aEditor.loadScript(GM_SP_SHOW_HINT_URL);
      cm = aEditor.codeMirror;
      win = aEditor.container.contentWindow.wrappedJSObject;
      if (!win.CodeMirror.showHint) {
        return undefined;
      }
    } catch (e) {
      // No hint add-on here.
      return undefined;
    }
    let tools = this;
    let hintAt = function (aCm) {
      let cursor = aCm.getCursor();
      let hint = tools.hintFor(
          aCm.getLine(cursor.line).slice(0, cursor.ch),
          tools.inHeader(function (aLine) {
            return aCm.getLine(aLine) || "";
          }, cursor.line));
      return hint && {
        "from": {"line": cursor.line, "ch": hint.start},
        "list": hint.list,
        "to": cursor,
      };
    };
    cm.on("inputRead", function (aCm) {
      if (!aCm.state.completionActive && hintAt(aCm)) {
        win.CodeMirror.showHint(aCm, hintAt, {"completeSingle": false});
      }
    });
    return undefined;
  },

  ///////////////////////////////// The title /////////////////////////////////

  /** The window says the script's name and version, not its file's path. */
  "_titleWithScriptName": function () {
    let scratchpad = this._scratchpad;
    let tools = this;
    let updateTitle = scratchpad._updateTitle;
    scratchpad._updateTitle = function () {
      if (!tools._title) {
        return updateTitle.apply(this, arguments);
      }
      document.title = (this.dirty ? "*" : "") + tools._title;
      return undefined;
    };
  },

  /////////////////////////////// The toolbar ///////////////////////////////

  /** @returns {?Script} The installed script this window edits. */
  "_installedScript": function () {
    return GM_editorSave.scriptForPath(this._scratchpad.filename);
  },

  "_addToolbarButtons": function () {
    let toolbar = document.getElementById("sp-toolbar");
    if (!toolbar) {
      return undefined;
    }
    let tools = this;
    toolbar.appendChild(document.createElement("toolbarspacer"));
    [
      ["options", "Options", "Opens this script's Options window.",
        function (aScript) {
          GM_util.openScriptOptions(aScript);
        }],
      ["view", "View", "Shows the saved script, read-only, in a browser tab.",
        function (aScript) {
          let browserWin = GM_util.getBrowserWindow();
          if (browserWin) {
            browserWin.gBrowser.selectedTab = browserWin.gBrowser.addTab(
                GM_util.sourceViewerUrl(aScript.file, aScript.downloadURL));
            browserWin.focus();
          }
        }],
      ["folder", "Open Folder", "Opens the script's folder.",
        function (aScript) {
          GM_openFolder(aScript.file);
        }],
    ].forEach(function (aButton) {
      let button = document.createElement("toolbarbutton");
      button.id = "gm-sp-" + aButton[0];
      button.className = "devtools-toolbarbutton";
      button.setAttribute("label",
          tools.string("scratchpad." + aButton[0], aButton[1]));
      button.setAttribute("data-tooltip",
          tools.string("scratchpad." + aButton[0] + ".tooltip", aButton[2]));
      button.addEventListener("command", function () {
        let script = tools._installedScript();
        if (script) {
          aButton[3](script);
        }
      }, false);
      toolbar.appendChild(button);
    });

    toolbar.appendChild(document.createElement("toolbarspacer"));
    let meta = document.createElement("toolbarbutton");
    meta.id = "gm-sp-meta-toggle";
    meta.className = "devtools-toolbarbutton";
    meta.setAttribute("type", "checkbox");
    meta.setAttribute("label",
        this.string("sourceViewer.meta.toggle", "Metadata"));
    meta.setAttribute("tooltiptext", this.string(
        "sourceViewer.meta.toggle.tooltip",
        "Show or hide what the script declares"));
    meta.setAttribute("checked",
        String(GM_prefRoot.getValue(GM_SP_META_PREF, true)));
    meta.addEventListener("command", function () {
      GM_prefRoot.setValue(GM_SP_META_PREF, meta.checked);
      tools._showSummary();
    }, false);
    toolbar.appendChild(meta);

    this._updateButtons();
    return undefined;
  },

  /**
   * Options, View and Open Folder are for an installed script: a new one
   * gets them with its first save (which installs it).
   */
  "_updateButtons": function () {
    let installed = !!this._installedScript();
    let waiting = this.string("scratchpad.installFirst.tooltip",
        "Save the script first: its first save installs it.");
    ["options", "view", "folder"].forEach(function (aName) {
      let button = document.getElementById("gm-sp-" + aName);
      if (!button) {
        return undefined;
      }
      button.disabled = !installed;
      button.setAttribute("tooltiptext", installed
          ? button.getAttribute("data-tooltip") : waiting);
      return undefined;
    });
  },

  //////////////////////////// The Metadata summary ////////////////////////////

  /** Above the code, below Scratchpad's notifications. */
  "_addMetadataSummary": function () {
    let box = document.getElementById("scratchpad-notificationbox");
    if (!box) {
      return undefined;
    }
    let summary = document.createElement("grid");
    summary.id = "gm-sp-meta";
    let columns = document.createElement("columns");
    columns.appendChild(document.createElement("column"));
    let values = document.createElement("column");
    values.setAttribute("flex", "1");
    columns.appendChild(values);
    summary.appendChild(columns);
    let rows = document.createElement("rows");
    rows.id = "gm-sp-meta-rows";
    summary.appendChild(rows);
    // Notifications go first in the box, whatever comes after them.
    let editorBox = document.getElementById("scratchpad-editor");
    box.insertBefore(summary, editorBox ? editorBox.parentNode : null);
    this._showSummary();
    return undefined;
  },

  "_showSummary": function () {
    let summary = document.getElementById("gm-sp-meta");
    let rows = document.getElementById("gm-sp-meta-rows");
    if (summary) {
      summary.hidden = !GM_prefRoot.getValue(GM_SP_META_PREF, true)
          || !rows.childNodes.length;
    }
  },

  /** The text parsed again: the summary and the title follow it. */
  "_reparse": function () {
    let text;
    try {
      text = this._scratchpad.getText();
    } catch (e) {
      return undefined;
    }
    let installed = this._installedScript();
    let script = null;
    try {
      script = this._parse(text, installed
          ? GM_util.getUriFromUrl(installed.downloadURL) : null);
    } catch (e) {
      script = null;
    }
    let title = script && (script.localized.name || script.name);
    this._title = title ? title + (script.version ? " " + script.version : "")
        : null;
    this._scratchpad._updateTitle();
    this._fillSummary(script ? this.summaryRows(script) : [], text);
    return undefined;
  },

  /**
   * @param {Script} aScript - As parse() gives it.
   * @returns {Array<{id: string, label: string, values: string[],
   *   keywords: string[], kind: ?string}>} The summary's rows that have
   *   something to show (Permissions always: "none declared").
   */
  "summaryRows": function (aScript) {
    let patterns = function (aList) {
      return (aList || []).map(function (aPattern) {
        return (typeof aPattern == "string") ? aPattern : aPattern.pattern;
      });
    };
    let values = {
      "connects": aScript._connects || [],
      "errors": aScript.parseErrors || [],
      "grants": (aScript._grants && aScript._grants.length)
          ? aScript._grants
          : [this.string("sourceViewer.meta.noGrant", "none declared")],
      "notOn": (aScript._excludes || []).concat(
          patterns(aScript._excludeMatches)),
      // Without a pinned hash's #fragment, as the Externals tab shows it.
      "requires": (aScript._requires || []).map(function (aRequire) {
        return aRequire._integrity
            ? aRequire.downloadURL.replace(/#.*$/, "") : aRequire.downloadURL;
      }),
      "resources": (aScript._resources || []).map(function (aResource) {
        return aResource.name;
      }),
      "runAt": [aScript._runAt || "document-end"].concat(aScript._noframes
          ? [this.string("sourceViewer.meta.topFrameOnly",
              "top frame only (@noframes)")]
          : []),
      "runsOn": patterns(aScript._matches).concat(aScript._includes || []),
      "warnings": aScript.parseWarnings || [],
    };
    return GM_SP_META_ROWS.filter(function (aRow) {
      return values[aRow.id].length > 0;
    }).map(function (aRow) {
      return {
        "id": aRow.id,
        "keywords": aRow.keywords,
        "kind": aRow.kind || null,
        "label": this.string(aRow.label, aRow.fallback),
        "values": values[aRow.id],
      };
    }, this);
  },

  /**
   * @param {object[]} aRows - From summaryRows.
   * @param {string} aText - The script, to find the lines rows point at.
   */
  "_fillSummary": function (aRows, aText) {
    let rows = document.getElementById("gm-sp-meta-rows");
    if (!rows) {
      return undefined;
    }
    while (rows.firstChild) {
      rows.removeChild(rows.firstChild);
    }
    let lines = aText.split(/\r\n|\r|\n/);
    let tools = this;
    aRows.forEach(function (aRow) {
      let row = document.createElement("row");
      row.className = "gm-sp-meta-row";
      row.setAttribute("align", "center");
      if (aRow.kind) {
        row.setAttribute("kind", aRow.kind);
      }
      let key = document.createElement("label");
      key.className = "gm-sp-meta-key";
      key.setAttribute("value", aRow.label);
      row.appendChild(key);
      let shown = aRow.values.slice(0, GM_SP_META_MAX_VALUES).join(", ");
      let more = aRow.values.length - GM_SP_META_MAX_VALUES;
      if (more > 0) {
        shown += "  " + tools.string("sourceViewer.meta.more", "+%1 more")
            .replace("%1", more);
      }
      let value = document.createElement("label");
      value.className = "gm-sp-meta-value";
      value.setAttribute("value", shown);
      value.setAttribute("crop", "end");
      value.setAttribute("tooltiptext", aRow.values.join("\n"));
      let line = tools.lineOf(lines, aRow.keywords);
      if (line > -1) {
        value.classList.add("gm-sp-meta-jump");
        value.addEventListener("click", function () {
          tools._jumpTo(line);
        }, false);
      }
      row.appendChild(value);
      rows.appendChild(row);
    });
    this._showSummary();
    return undefined;
  },

  /**
   * @param {string[]} aLines - The script's lines.
   * @param {string[]} aKeywords
   * @returns {number} The first metadata line with one of aKeywords, or -1.
   */
  "lineOf": function (aLines, aKeywords) {
    if (!aKeywords.length) {
      return -1;
    }
    let keyword = new RegExp("^\\s*//\\s*@(?:" + aKeywords.map(function (aWord) {
      return aWord.replace(/[.\-]/g, "\\$&");
    }).join("|") + ")(?:\\s|$)");
    let inBlock = false;
    for (let i = 0; i < aLines.length; i++) {
      if (/^\s*\/\/\s*==UserScript==/.test(aLines[i])) {
        inBlock = true;
      } else if (/^\s*\/\/\s*==\/UserScript==/.test(aLines[i])) {
        return -1;
      } else if (inBlock && keyword.test(aLines[i])) {
        return i;
      }
    }
    return -1;
  },

  "_jumpTo": function (aLine) {
    let editor = this._scratchpad.editor;
    editor.setCursor({"line": aLine, "ch": 0}, "center");
    editor.focus();
  },
};
