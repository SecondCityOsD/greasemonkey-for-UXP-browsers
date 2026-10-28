/**
 * @file sourceViewer/theme.js
 * @overview Light / dark colours for the source viewer.
 *
 * extensions.greasemonkey.sourceViewer.theme is "auto", "light" or "dark".
 * The toolbar's Auto / Light / Dark buttons set it, and every open viewer
 * follows the change.
 *
 * "auto" follows the browser's own toolbars.  It deliberately ignores
 * prefers-color-scheme: in Pale Moon that is the "Web Page Color Scheme"
 * setting, which themes don't change, so it almost never says dark.
 * Pale Moon's ToolbarIconColor (browser.js) gives each toolbar whose text
 * is light brighttext="true" (complete themes, lightweight themes and dark
 * system colours alike) and keeps it current, so a MutationObserver on the
 * navigation toolbar follows a theme switch live.  With no toolbar to read,
 * a lightweight theme's lwthemetextcolor="bright" decides; otherwise light.
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
const SV_THEME_PREF = "sourceViewer.theme";

/** The pref's values, in the order of the toolbar buttons. */
const SV_THEME_MODES = ["auto", "light", "dark"];

var SvTheme = {
  "_body": null,
  "_hostWindow": null,
  "_observer": null,
  "_onPrefChange": null,
  "_prefs": null,

  /**
   * Applies the saved mode, labels the toolbar buttons and starts following
   * the pref (and, in auto mode, the browser's theme).
   * @param {Element} aBody - Receives the theme-light / theme-dark class.
   * @param {function(string, string): string} aString - Localised string
   *        lookup with an English fallback.
   * @returns {void}
   */
  "init": function (aBody, aString) {
    this._body = aBody;
    this._prefs = new GM_PrefManager();
    this._onPrefChange = this._apply.bind(this);

    this._setUpButtons(aString);
    this._apply();

    this._prefs.watch(SV_THEME_PREF, this._onPrefChange);
    window.addEventListener("focus", this, false);
    window.addEventListener("unload", this, false);
  },

  "handleEvent": function (aEvent) {
    switch (aEvent.type) {
      case "focus":
        // A tab dragged into another window has a new host to follow.
        if ((this._mode() == "auto")
            && (this._findHostWindow() != this._hostWindow)) {
          this._apply();
        }
        break;
      case "unload":
        this._prefs.unwatch(SV_THEME_PREF, this._onPrefChange);
        this._unfollow();
        break;
    }
  },

  /** @returns {string} The saved mode; anything unknown counts as auto. */
  "_mode": function () {
    let mode = this._prefs.getValue(SV_THEME_PREF, "auto");
    return (SV_THEME_MODES.indexOf(mode) == -1) ? "auto" : mode;
  },

  "_apply": function () {
    let mode = this._mode();
    this._unfollow();
    if (mode == "auto") {
      this._follow();
    }

    let buttons = this._buttons();
    for (let i = 0, iLen = buttons.length; i < iLen; i++) {
      buttons[i].setAttribute("aria-pressed",
          String(buttons[i].getAttribute("data-mode") == mode));
    }
    this._refresh();
  },

  /** Sets the body class from the mode and, in auto, the browser. */
  "_refresh": function () {
    let mode = this._mode();
    let dark = (mode == "auto") ? this._browserIsDark() : (mode == "dark");
    this._body.classList.toggle("theme-dark", dark);
    this._body.classList.toggle("theme-light", !dark);
  },

  /** @returns {boolean} Whether the host browser window's theme is dark. */
  "_browserIsDark": function () {
    if (!this._hostWindow) {
      return false;
    }
    let doc = this._hostWindow.document;
    let toolbar = this._toolbar(doc);
    if (toolbar) {
      return toolbar.hasAttribute("brighttext");
    }
    return doc.documentElement.getAttribute("lwthemetextcolor") == "bright";
  },

  /** Watches the host window's theme markers. */
  "_follow": function () {
    this._hostWindow = this._findHostWindow();
    if (!this._hostWindow) {
      return;
    }
    let doc = this._hostWindow.document;
    this._observer = new MutationObserver(this._refresh.bind(this));
    let toolbar = this._toolbar(doc);
    if (toolbar) {
      this._observer.observe(toolbar, {
        "attributes": true,
        "attributeFilter": ["brighttext"],
      });
    }
    this._observer.observe(doc.documentElement, {
      "attributes": true,
      "attributeFilter": ["lwthemetextcolor"],
    });
  },

  "_unfollow": function () {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
    this._hostWindow = null;
  },

  /**
   * @returns {Window|null} The browser window this tab is in; else the most
   *          recent one (the viewer opened some other way).
   */
  "_findHostWindow": function () {
    try {
      let win = window.QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIWebNavigation)
          .QueryInterface(Ci.nsIDocShellTreeItem)
          .rootTreeItem
          .QueryInterface(Ci.nsIInterfaceRequestor)
          .getInterface(Ci.nsIDOMWindow);
      if (win.document.documentElement.getAttribute("windowtype")
          == "navigator:browser") {
        return win;
      }
    } catch (e) {
      // Not in a docshell tree we can walk: fall through.
    }
    return GM_util.getBrowserWindow() || null;
  },

  /** @returns {Element|null} The toolbar whose brighttext to read. */
  "_toolbar": function (aDoc) {
    return aDoc.querySelector("#nav-bar:not([collapsed=true])")
        || aDoc.querySelector("toolbar:not([collapsed=true])");
  },

  "_buttons": function () {
    let group = document.getElementById("gm-sv-theme");
    return group ? group.querySelectorAll("button[data-mode]") : [];
  },

  "_setUpButtons": function (aString) {
    let text = {
      "auto": [aString("sourceViewer.theme.auto", "Auto"),
          aString("sourceViewer.theme.auto.tooltip",
              "Follow the browser's toolbars")],
      "light": [aString("sourceViewer.theme.light", "Light"),
          aString("sourceViewer.theme.light.tooltip", "Always light")],
      "dark": [aString("sourceViewer.theme.dark", "Dark"),
          aString("sourceViewer.theme.dark.tooltip", "Always dark")],
    };
    let buttons = this._buttons();
    for (let i = 0, iLen = buttons.length; i < iLen; i++) {
      let mode = buttons[i].getAttribute("data-mode");
      buttons[i].textContent = text[mode][0];
      buttons[i].title = text[mode][1];
      buttons[i].addEventListener("click", function () {
        // The pref observer applies it here and in every other viewer.
        this._prefs.setValue(SV_THEME_PREF, mode);
      }.bind(this), false);
    }
  },
};
