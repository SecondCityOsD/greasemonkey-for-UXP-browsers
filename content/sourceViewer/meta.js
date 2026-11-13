/**
 * @file sourceViewer/meta.js
 * @overview The metadata header: what a script declares, above its code.
 *
 * Lists the ==UserScript== lines that decide where a script runs and what
 * it may do, grouped and labelled as in the install window:
 *   - the parser's warnings about lines it ignores;
 *   - where it runs (@match, @include) and doesn't (@exclude,
 *     @exclude-match);
 *   - @run-at and @noframes;
 *   - @grant, with a small tag on the ones that reach past the page;
 *   - @connect, flagging "*";
 *   - @require and @resource, each of which can also open in a tab;
 *   - @antifeature;
 *   - @updateURL and @downloadURL.
 * Values are shown as written (this is a source viewer: a relative URL
 * stays relative), and clicking one selects its line in the code.  An
 * http: or ftp: address gets the install window's "not encrypted" chip.
 *
 * The toolbar's Metadata button shows and hides the header.  A file
 * without a metadata block (a @require'd library) has neither.
 *
 * Loaded before viewer.js, in the same page scope.
 */

if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/util.js");

/** Values a row shows before its "+N more" button. */
const SV_META_MAX_ITEMS = 6;

/**
 * The header's rows, in order.  keywords are lower case, as _scan() stores
 * them; list rows put each value on its own line (addresses, which are
 * long), the others flow.
 */
const SV_META_ROWS = [
  {"keywords": ["match", "include"], "label": "sourceViewer.meta.runsOn" },
  {"keywords": ["exclude", "exclude-match"], "label": "sourceViewer.meta.notOn" },
  {"keywords": ["run-at", "noframes"], "label": "install.runAt" },
  {"keywords": ["grant"], "label": "install.grants" },
  {"keywords": ["connect"], "label": "install.connects" },
  {"keywords": ["require"], "label": "install.requires", "list": true },
  {"keywords": ["resource"], "label": "install.resources", "list": true },
  {"keywords": ["antifeature"], "label": "install.antifeatures", "list": true },
  {"keywords": ["updateurl", "downloadurl"], "label": "sourceViewer.meta.updates", "list": true },
];

/** Grants that reach past the page, and the tag each one gets. */
const SV_META_GRANT_TAGS = {
  "GM.cookie": "cookie",
  "GM.download": "download",
  "GM.setClipboard": "clipboard",
  "GM.xmlHttpRequest": "requests",
  "GM_cookie": "cookie",
  "GM_download": "download",
  "GM_setClipboard": "clipboard",
  "GM_xmlhttpRequest": "requests",
  "unsafeWindow": "page",
};

var SvMeta = {
  "_connects": 0,
  "_jumpTo": null,
  "_relayout": null,
  "_string": null,
  "_url": null,

  /**
   * Builds the header for a file and shows it, with the toolbar's Metadata
   * button; does nothing for a file without a metadata block.
   * @param {object} aOptions
   * @param {string} aOptions.text - The file's contents.
   * @param {Script|null} aOptions.script - The parsed script, for its
   *        parseWarnings.
   * @param {string|null} aOptions.url - Where it came from, to resolve
   *        relative addresses.
   * @param {function(number)} aOptions.jumpTo - Selects a (0-based) line.
   * @param {function()} aOptions.relayout - Called after the header opens
   *        or closes, so the code can fit the new height.
   * @param {function(string, string): string} aOptions.string - Localised
   *        string lookup.
   * @returns {void}
   */
  "init": function (aOptions) {
    let header = document.getElementById("gm-sv-meta");
    let toggle = document.getElementById("gm-sv-meta-toggle");
    let lines = this._scan(aOptions.text);
    if (!header || !toggle || !lines.length) {
      return;
    }
    this._jumpTo = aOptions.jumpTo;
    this._relayout = aOptions.relayout;
    this._string = aOptions.string;
    this._url = aOptions.url;

    this._fill(header, lines,
        (aOptions.script && aOptions.script.parseWarnings) || []);

    toggle.textContent = this._string("sourceViewer.meta.toggle");
    toggle.title = this._string("sourceViewer.meta.toggle.tooltip");
    toggle.removeAttribute("hidden");
    toggle.addEventListener("click", function () {
      this._setOpen(header.hasAttribute("hidden"));
    }.bind(this), false);
    this._setOpen(true);
  },

  /**
   * The metadata block's lines, with their (0-based) line numbers, which
   * the parser doesn't keep.  Lines split as CodeMirror splits them, so the
   * numbers match its lines.
   * @param {string} aText
   * @returns {Array<{keyword: string, value: string, line: number}>} Empty
   *          without a complete ==UserScript== block.
   */
  "_scan": function (aText) {
    let lines = aText.split(/\r\n|\r|\n/);
    let found = [];
    let inside = false;
    for (let i = 0, iLen = lines.length; i < iLen; i++) {
      if (!inside) {
        inside = /^\s*\/\/\s*==UserScript==/.test(lines[i]);
        continue;
      }
      if (/^\s*\/\/\s*==\/UserScript==/.test(lines[i])) {
        return found;
      }
      let meta = /^\s*\/\/\s*@(\S+)(?:\s+(.*?))?\s*$/.exec(lines[i]);
      if (meta) {
        found.push({
          "keyword": meta[1].toLowerCase(),
          "line": i,
          "value": meta[2] || "",
        });
      }
    }
    return [];
  },

  "_fill": function (aHeader, aLines, aWarnings) {
    while (aHeader.firstChild) {
      aHeader.removeChild(aHeader.firstChild);
    }
    this._connects = aLines.filter(function (aLine) {
      return aLine.keyword == "connect";
    }).length;

    if (aWarnings.length) {
      this._addRow(aHeader, this._string("install.warnings"),
          aWarnings.map(function (aWarning) {
            let item = document.createElement("span");
            item.className = "gm-sv-meta-item gm-sv-meta-warning";
            item.textContent = aWarning;
            return item;
          }), true);
    }

    for (let i = 0, iLen = SV_META_ROWS.length; i < iLen; i++) {
      let row = SV_META_ROWS[i];
      let items = aLines.filter(function (aLine) {
        return row.keywords.indexOf(aLine.keyword) != -1;
      }).map(this._item, this);
      if (!items.length && (row.keywords[0] == "grant")) {
        let none = document.createElement("span");
        none.className = "gm-sv-meta-item gm-sv-meta-none";
        none.textContent = this._string("sourceViewer.meta.noGrant");
        items.push(none);
      }
      if (items.length) {
        this._addRow(aHeader, this._string(row.label),
            items, !!row.list);
      }
    }
  },

  "_addRow": function (aHeader, aLabel, aItems, aList) {
    let row = document.createElement("div");
    row.className = "gm-sv-meta-row" + (aList ? " gm-sv-meta-list" : "");
    let key = document.createElement("span");
    key.className = "gm-sv-meta-key";
    key.textContent = aLabel;
    let values = document.createElement("span");
    values.className = "gm-sv-meta-values";
    row.appendChild(key);
    row.appendChild(values);

    let shown = Math.min(aItems.length, SV_META_MAX_ITEMS);
    for (let i = 0; i < shown; i++) {
      values.appendChild(aItems[i]);
    }
    if (aItems.length > shown) {
      let more = document.createElement("button");
      more.type = "button";
      more.className = "gm-sv-meta-more";
      more.textContent = this._string("sourceViewer.meta.more", [aItems.length - shown]);
      more.addEventListener("click", function () {
        values.removeChild(more);
        for (let i = shown, iLen = aItems.length; i < iLen; i++) {
          values.appendChild(aItems[i]);
        }
        this._relayout();
      }.bind(this), false);
      values.appendChild(more);
    }
    aHeader.appendChild(row);
  },

  /** One value, which selects its line when clicked (or on Enter). */
  "_item": function (aLine) {
    let item = document.createElement("span");
    item.className = "gm-sv-meta-item";
    item.setAttribute("tabindex", "0");
    item.title = this._string("sourceViewer.meta.jump", [aLine.line + 1]);
    let jump = function (aEvent) {
      if ((aEvent.type == "click") || (aEvent.key == "Enter")) {
        this._jumpTo(aLine.line);
      }
    }.bind(this);
    item.addEventListener("click", jump, false);
    item.addEventListener("keydown", jump, false);

    let value = aLine.value;
    let words = /^(\S+)\s+(.*)$/.exec(value);
    switch (aLine.keyword) {
      case "noframes":
        item.appendChild(this._text(this._string(
            "sourceViewer.meta.topFrameOnly")));
        break;
      case "grant":
        item.appendChild(this._code(value));
        if (SV_META_GRANT_TAGS.hasOwnProperty(value)) {
          this._appendGrantTag(item, SV_META_GRANT_TAGS[value]);
        }
        break;
      case "connect":
        item.appendChild(this._code(value));
        if (value == "*") {
          item.appendChild(this._chip("gm-sv-tag",
              this._string("sourceViewer.meta.anySite"),
              this._string("sourceViewer.meta.anySite.tooltip")));
        }
        break;
      case "require":
        this._appendAddress(item, value, true);
        break;
      case "resource":
        // "name address"
        if (words) {
          item.appendChild(this._code(words[1] + " "));
          this._appendAddress(item, words[2], true);
        } else {
          item.appendChild(this._code(value));
        }
        break;
      case "antifeature":
        // "type description"
        item.appendChild(this._chip("gm-sv-chip-warn",
            words ? words[1] : value, ""));
        if (words) {
          item.appendChild(this._text(" " + words[2]));
        }
        break;
      case "updateurl":
      case "downloadurl":
        item.appendChild(this._text(
            (aLine.keyword == "updateurl" ? "@updateURL" : "@downloadURL")
            + " ", "gm-sv-meta-prefix"));
        this._appendAddress(item, value, false);
        break;
      default:
        item.appendChild(this._code(value));
        break;
    }
    return item;
  },

  "_appendGrantTag": function (aItem, aTag) {
    let key = "sourceViewer.meta.tag." + aTag;
    let tooltipKey = key + ((aTag == "requests")
        ? (this._connects ? ".connect" : ".any") : "") + ".tooltip";
    aItem.appendChild(this._chip("gm-sv-tag", this._string(key), this._string(tooltipKey)));
  },

  /**
   * An address, as written, plus the "not encrypted" chip when it resolves
   * to http: or ftp:, and (aOpenable) a button opening an http(s) address
   * in a new tab.
   */
  "_appendAddress": function (aItem, aValue, aOpenable) {
    aItem.appendChild(this._code(aValue));
    // "@downloadURL none" (GreasyFork's old versions) is no address; it
    // must not resolve to ".../none" against the script's own.
    if (/^none$/i.test(aValue)) {
      return;
    }
    let uri = null;
    try {
      uri = GM_util.getUriFromUrl(aValue, this._url || undefined);
    } catch (e) {
      // Not an address we can resolve: show it, nothing more.
    }
    if (!uri) {
      return;
    }
    if ((uri.scheme == "http") || (uri.scheme == "ftp")) {
      aItem.appendChild(this._chip("gm-sv-chip-warn",
          this._string("install.insecure"),
          this._string("install.insecure.tooltip")));
    }
    if (aOpenable && ((uri.scheme == "http") || (uri.scheme == "https"))) {
      let open = document.createElement("button");
      open.type = "button";
      open.className = "gm-sv-meta-open";
      open.textContent = "↗";
      open.title = this._string("sourceViewer.meta.open");
      let spec = uri.spec;
      open.addEventListener("click", function (aEvent) {
        // Not a jump to the line as well.
        aEvent.stopPropagation();
        let win = GM_util.getBrowserWindow();
        if (win) {
          win.gBrowser.selectedTab = win.gBrowser.addTab(spec);
        }
      }, false);
      open.addEventListener("keydown", function (aEvent) {
        aEvent.stopPropagation();
      }, false);
      aItem.appendChild(open);
    }
  },

  "_chip": function (aClass, aText, aTooltip) {
    let chip = document.createElement("span");
    chip.className = aClass;
    chip.textContent = aText;
    if (aTooltip) {
      chip.title = aTooltip;
    }
    return chip;
  },

  "_code": function (aText) {
    return this._text(aText, "gm-sv-meta-code");
  },

  "_text": function (aText, aClass) {
    let span = document.createElement("span");
    if (aClass) {
      span.className = aClass;
    }
    span.textContent = aText;
    return span;
  },

  "_setOpen": function (aOpen) {
    let header = document.getElementById("gm-sv-meta");
    let toggle = document.getElementById("gm-sv-meta-toggle");
    if (aOpen) {
      header.removeAttribute("hidden");
    } else {
      header.setAttribute("hidden", "hidden");
    }
    toggle.setAttribute("aria-pressed", String(aOpen));
    this._relayout();
  },
};
