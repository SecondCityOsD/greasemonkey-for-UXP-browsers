/**
 * @file sourceViewer/view.js
 * @overview How the source viewer shows the code: folding, word wrap and
 *   text size.  Wrap and size are remembered and shared by every open
 *   viewer, like the theme.
 *
 *   - Folding: a gutter beside the line numbers folds braces and the
 *     whole ==UserScript== block (the browser's CodeMirror bundle has the
 *     fold addons, but not their stylesheet; sourceViewer.css has that).
 *   - Wrap: the toolbar's Wrap button, or Alt+Z as in VS Code
 *     (extensions.greasemonkey.sourceViewer.wrap).
 *   - Text size: Ctrl++ / Ctrl+- / Ctrl+0 and Ctrl+wheel resize the code
 *     only, not the toolbar, instead of zooming the whole page
 *     (extensions.greasemonkey.sourceViewer.zoom, a percentage).  The
 *     status bar shows the size when it isn't 100%; clicking it resets.
 *
 *   - Copy: the toolbar's Copy button puts the whole file on the
 *     clipboard.
 *   - Links: http(s) addresses in the code are underlined, and
 *     Ctrl+click opens one in a new tab (a plain click still just places
 *     the cursor, so selecting text works as before).
 *   - Shortcuts: the toolbar's "?" button, or the ? key, lists them.
 *
 * The plain-text fallback gets the text size and Copy; it has no folding,
 * links or wrap toggle.
 *
 * Loaded before viewer.js, in the same page scope.
 */

if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");

/** Relative to extensions.greasemonkey. */
const SV_VIEW_WRAP_PREF = "sourceViewer.wrap";
const SV_VIEW_ZOOM_PREF = "sourceViewer.zoom";

/** Text sizes Ctrl++ and Ctrl+- step through, as the browser's zoom does. */
const SV_VIEW_ZOOM_STEPS = [50, 67, 80, 90, 100, 110, 120, 133, 150, 170,
  200, 240, 300];

/** A web address in the code; trailing punctuation is trimmed off after. */
const SV_VIEW_URL = /\bhttps?:\/\/[^\s"'`<>()[\]{}\\]+/g;

/** How long the Copy button says "Copied". */
const SV_VIEW_COPIED_MS = 1500;

/** The shortcuts list: keys (not translated) and what they do. */
const SV_VIEW_SHORTCUTS = [
  ["Ctrl+F", "sourceViewer.help.find", "Find"],
  ["Enter, Shift+Enter, F3, Shift+F3", "sourceViewer.help.findNext",
    "Next or previous match"],
  ["Ctrl+G", "sourceViewer.help.goto", "Go to a line (line or line:column)"],
  ["Esc", "sourceViewer.help.close", "Close find, go to line or this list"],
  ["Alt+Z", "sourceViewer.help.wrap", "Wrap long lines"],
  ["Ctrl++, Ctrl+-, Ctrl+0", "sourceViewer.help.zoom",
    "Text size (Ctrl+wheel too)"],
  ["Ctrl+click", "sourceViewer.help.link",
    "Open a web address in a new tab"],
  ["Ctrl+A, Ctrl+C", "sourceViewer.help.copy", "Select all, copy"],
  ["?", "sourceViewer.help.help", "This list"],
];

var SvView = {
  "_baseFontSize": 0,
  "_cm": null,
  "_onPrefChange": null,
  "_prefs": null,
  "_string": null,
  // The element whose font size the text size sets.
  "_target": null,

  /**
   * @param {object} aOptions
   * @param {object|null} aOptions.cm - The CodeMirror instance, or null
   *        for the plain-text fallback.
   * @param {Element|null} aOptions.textarea - The fallback's textarea.
   * @param {function(string, string): string} aOptions.string - Localised
   *        string lookup with an English fallback.
   * @returns {void}
   */
  "init": function (aOptions) {
    this._cm = aOptions.cm;
    this._string = aOptions.string;
    this._target = this._cm ? this._cm.getWrapperElement() : aOptions.textarea;
    if (!this._target) {
      return;
    }
    this._baseFontSize = parseFloat(
        window.getComputedStyle(this._target).fontSize) || 13;
    this._prefs = new GM_PrefManager();

    if (this._cm) {
      this._setUpFolding();
      let wrap = document.getElementById("gm-sv-wrap");
      wrap.textContent = this._string("sourceViewer.wrap", "Wrap");
      wrap.title = this._string("sourceViewer.wrap.tooltip",
          "Wrap long lines (Alt+Z)");
      wrap.removeAttribute("hidden");
      wrap.addEventListener("click", this._toggleWrap.bind(this), false);
    }
    let zoom = document.getElementById("gm-sv-zoom");
    zoom.title = this._string("sourceViewer.zoom.tooltip",
        "Text size: Ctrl++ and Ctrl+- change it.  Click for 100%.");
    zoom.addEventListener("click", this._setZoom.bind(this, 100), false);
    if (this._cm) {
      this._setUpLinks();
    }
    this._setUpCopy(aOptions.textarea);
    this._setUpHelp();

    this._onPrefChange = this._apply.bind(this);
    this._prefs.watch(SV_VIEW_WRAP_PREF, this._onPrefChange);
    this._prefs.watch(SV_VIEW_ZOOM_PREF, this._onPrefChange);
    window.addEventListener("keydown", this, true);
    window.addEventListener("keyup", this, true);
    window.addEventListener("blur", this, false);
    window.addEventListener("wheel", this, true);
    window.addEventListener("unload", this, false);
    this._apply();
  },

  "handleEvent": function (aEvent) {
    switch (aEvent.type) {
      case "keydown":
        this._setLinkKey(aEvent);
        this._onKey(aEvent);
        break;
      case "keyup":
        this._setLinkKey(aEvent);
        break;
      case "blur":
        document.body.classList.remove("gm-sv-link-key");
        break;
      case "wheel":
        // Ctrl+wheel sizes the code instead of zooming the page.
        if ((aEvent.ctrlKey || aEvent.metaKey) && aEvent.deltaY) {
          aEvent.preventDefault();
          this._stepZoom((aEvent.deltaY < 0) ? 1 : -1);
        }
        break;
      case "unload":
        this._prefs.unwatch(SV_VIEW_WRAP_PREF, this._onPrefChange);
        this._prefs.unwatch(SV_VIEW_ZOOM_PREF, this._onPrefChange);
        break;
    }
  },

  "_onKey": function (aEvent) {
    let accel = (aEvent.ctrlKey || aEvent.metaKey) && !aEvent.altKey;
    let key = aEvent.key;
    if (accel && ((key == "+") || (key == "=") || (aEvent.keyCode == 107))) {
      this._stepZoom(1);
    } else if (accel && ((key == "-") || (aEvent.keyCode == 109))) {
      this._stepZoom(-1);
    } else if (accel && ((key == "0") || (aEvent.keyCode == 96))) {
      this._setZoom(100);
    } else if (this._cm && aEvent.altKey && !aEvent.ctrlKey
        && !aEvent.metaKey && !aEvent.shiftKey && (aEvent.keyCode == 90)) {
      // Alt+Z
      this._toggleWrap();
    } else if ((key == "?") && !aEvent.ctrlKey && !aEvent.metaKey
        && !aEvent.altKey && !this._isTyping(aEvent.target)) {
      this._toggleHelp();
    } else if ((aEvent.keyCode == 27) && this._helpIsOpen()) {
      this._toggleHelp();
    } else {
      return;
    }
    aEvent.preventDefault();
    aEvent.stopPropagation();
  },

  /** Whether a key goes into one of our fields (find, go to line). */
  "_isTyping": function (aTarget) {
    return !!aTarget && /^gm-sv-(find|goto)-input$/.test(aTarget.id || "");
  },

  /** Ctrl (Cmd) held: the code's links show as clickable. */
  "_setLinkKey": function (aEvent) {
    document.body.classList.toggle("gm-sv-link-key",
        !!(aEvent.ctrlKey || aEvent.metaKey));
  },

  /** Applies the remembered wrap and size (also when another viewer
   *  changes them). */
  "_apply": function () {
    let zoom = this._zoom();
    this._target.style.fontSize =
        (Math.round(this._baseFontSize * zoom) / 100) + "px";
    let label = document.getElementById("gm-sv-zoom");
    label.textContent = (zoom == 100) ? "" : zoom + "%";

    if (this._cm) {
      let wrap = !!this._prefs.getValue(SV_VIEW_WRAP_PREF, false);
      document.getElementById("gm-sv-wrap")
          .setAttribute("aria-pressed", String(wrap));
      if (this._cm.getOption("lineWrapping") != wrap) {
        this._cm.setOption("lineWrapping", wrap);
      }
      this._cm.refresh();
    }
  },

  /** @returns {number} The remembered size, one of SV_VIEW_ZOOM_STEPS. */
  "_zoom": function () {
    let zoom = this._prefs.getValue(SV_VIEW_ZOOM_PREF, 100);
    return (SV_VIEW_ZOOM_STEPS.indexOf(zoom) == -1) ? 100 : zoom;
  },

  "_stepZoom": function (aDirection) {
    let steps = SV_VIEW_ZOOM_STEPS;
    let index = steps.indexOf(this._zoom()) + aDirection;
    this._setZoom(steps[Math.max(0, Math.min(steps.length - 1, index))]);
  },

  /** Remembers a size; the pref observer applies it, here and elsewhere. */
  "_setZoom": function (aZoom) {
    this._prefs.setValue(SV_VIEW_ZOOM_PREF, aZoom);
  },

  "_toggleWrap": function () {
    this._prefs.setValue(SV_VIEW_WRAP_PREF,
        !this._prefs.getValue(SV_VIEW_WRAP_PREF, false));
  },

  /** Underlines the code's web addresses; Ctrl+click opens one. */
  "_setUpLinks": function () {
    this._cm.addOverlay({
      "token": function (aStream) {
        let url = this._nextUrl(aStream.string, aStream.pos);
        if (!url) {
          aStream.skipToEnd();
          return null;
        }
        if (url.index > aStream.pos) {
          aStream.pos = url.index;
          return null;
        }
        aStream.pos += url.text.length;
        // Class "cm-gm-url".
        return "gm-url";
      }.bind(this),
    });
    this._cm.on("mousedown", function (aCM, aEvent) {
      if ((aEvent.button != 0) || !(aEvent.ctrlKey || aEvent.metaKey)) {
        return;
      }
      let pos = aCM.coordsChar(
          {"left": aEvent.clientX, "top": aEvent.clientY}, "window");
      let line = aCM.getLine(pos.line);
      let url = this._nextUrl(line, 0);
      while (url && (url.index + url.text.length < pos.ch)) {
        url = this._nextUrl(line, url.index + url.text.length);
      }
      if (url && (url.index <= pos.ch)) {
        // CodeMirror leaves a prevented mousedown alone.
        aEvent.preventDefault();
        this._openInTab(url.text);
      }
    }.bind(this));
  },

  /**
   * The next web address in aLine at or after aFrom, without the
   * punctuation that usually ends a sentence or a list after it.
   * @returns {{index: number, text: string}|null}
   */
  "_nextUrl": function (aLine, aFrom) {
    SV_VIEW_URL.lastIndex = aFrom;
    let match = SV_VIEW_URL.exec(aLine);
    if (!match) {
      return null;
    }
    return {
      "index": match.index,
      "text": match[0].replace(/[.,;:!?*]+$/, ""),
    };
  },

  "_openInTab": function (aUrl) {
    let win = GM_util.getBrowserWindow();
    if (win) {
      win.gBrowser.selectedTab = win.gBrowser.addTab(aUrl);
    }
  },

  /** The toolbar's Copy button: the whole file onto the clipboard. */
  "_setUpCopy": function (aTextarea) {
    let button = document.getElementById("gm-sv-copy");
    let label = this._string("sourceViewer.copy", "Copy");
    button.textContent = label;
    button.title = this._string("sourceViewer.copy.tooltip",
        "Copy the whole file");
    button.removeAttribute("hidden");
    let timer = null;
    button.addEventListener("click", function () {
      Components.classes["@mozilla.org/widget/clipboardhelper;1"]
          .getService(Ci.nsIClipboardHelper)
          .copyString(this._cm ? this._cm.getValue() : aTextarea.value);
      button.textContent = this._string("sourceViewer.copied", "Copied");
      window.clearTimeout(timer);
      timer = window.setTimeout(function () {
        button.textContent = label;
      }, SV_VIEW_COPIED_MS);
    }.bind(this), false);
  },

  /** The toolbar's "?" button and the shortcuts list it opens. */
  "_setUpHelp": function () {
    let button = document.getElementById("gm-sv-help-open");
    button.title = this._string("sourceViewer.help.tooltip",
        "Keyboard shortcuts (?)");
    button.removeAttribute("hidden");
    button.addEventListener("click", this._toggleHelp.bind(this), false);

    let help = document.getElementById("gm-sv-help");
    let title = document.createElement("div");
    title.className = "gm-sv-help-title";
    title.textContent = this._string(
        "sourceViewer.help.title", "Keyboard shortcuts");
    help.appendChild(title);
    let list = document.createElement("table");
    SV_VIEW_SHORTCUTS.forEach(function (aShortcut) {
      let row = document.createElement("tr");
      let keys = document.createElement("td");
      keys.className = "gm-sv-help-keys";
      keys.textContent = aShortcut[0];
      let does = document.createElement("td");
      does.textContent = this._string(aShortcut[1], aShortcut[2]);
      row.appendChild(keys);
      row.appendChild(does);
      list.appendChild(row);
    }, this);
    help.appendChild(list);
    // A click anywhere closes it.
    help.addEventListener("click", this._toggleHelp.bind(this), false);
  },

  "_helpIsOpen": function () {
    return !document.getElementById("gm-sv-help").hasAttribute("hidden");
  },

  "_toggleHelp": function () {
    let help = document.getElementById("gm-sv-help");
    let button = document.getElementById("gm-sv-help-open");
    if (this._helpIsOpen()) {
      help.setAttribute("hidden", "hidden");
      button.setAttribute("aria-pressed", "false");
    } else {
      help.removeAttribute("hidden");
      button.setAttribute("aria-pressed", "true");
    }
  },

  "_setUpFolding": function () {
    let CodeMirror = window.CodeMirror;
    this._cm.setOption("gutters",
        ["CodeMirror-linenumbers", "CodeMirror-foldgutter"]);
    this._cm.setOption("foldOptions", {
      "rangeFinder": CodeMirror.fold.combine(
          this._userScriptBlock.bind(this), CodeMirror.fold.brace),
      "widget": "…",
    });
    this._cm.setOption("foldGutter", true);
  },

  /**
   * A fold range for the metadata block: from the end of its
   * "// ==UserScript==" line to the end of "// ==/UserScript==".
   * @returns {{from: object, to: object}|undefined}
   */
  "_userScriptBlock": function (aCM, aStart) {
    let first = aCM.getLine(aStart.line);
    if (!/^\s*\/\/\s*==UserScript==/.test(first)) {
      return undefined;
    }
    for (let i = aStart.line + 1, last = aCM.lastLine(); i <= last; i++) {
      let line = aCM.getLine(i);
      if (/^\s*\/\/\s*==\/UserScript==/.test(line)) {
        return {
          "from": {"ch": first.length, "line": aStart.line},
          "to": {"ch": line.length, "line": i},
        };
      }
    }
    return undefined;
  },
};
