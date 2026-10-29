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
 * The plain-text fallback gets the text size; it has no folding, and its
 * textarea doesn't wrap.
 *
 * Loaded before viewer.js, in the same page scope.
 */

if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");

/** Relative to extensions.greasemonkey. */
const SV_VIEW_WRAP_PREF = "sourceViewer.wrap";
const SV_VIEW_ZOOM_PREF = "sourceViewer.zoom";

/** Text sizes Ctrl++ and Ctrl+- step through, as the browser's zoom does. */
const SV_VIEW_ZOOM_STEPS = [50, 67, 80, 90, 100, 110, 120, 133, 150, 170,
  200, 240, 300];

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

    this._onPrefChange = this._apply.bind(this);
    this._prefs.watch(SV_VIEW_WRAP_PREF, this._onPrefChange);
    this._prefs.watch(SV_VIEW_ZOOM_PREF, this._onPrefChange);
    window.addEventListener("keydown", this, true);
    window.addEventListener("wheel", this, true);
    window.addEventListener("unload", this, false);
    this._apply();
  },

  "handleEvent": function (aEvent) {
    switch (aEvent.type) {
      case "keydown":
        this._onKey(aEvent);
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
    } else {
      return;
    }
    aEvent.preventDefault();
    aEvent.stopPropagation();
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
