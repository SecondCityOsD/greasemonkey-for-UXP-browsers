/**
 * @file sourceViewer/find.js
 * @overview Find, and go to a line, in the source viewer's CodeMirror.
 *
 * CodeMirror virtualises its DOM (only the lines on screen exist), so the
 * browser's own find can't see the rest.  This bar searches the whole text
 * itself:
 *   - every match is highlighted (through a CodeMirror overlay, so only
 *     the lines on screen do any work) and the current one more strongly;
 *   - Match case, Whole word and Regular expression toggles;
 *   - a pattern that doesn't compile says so (the old bar silently
 *     searched for it as plain text);
 *   - Enter / Shift+Enter, F3 / Shift+F3 and the arrows step through the
 *     matches, starting from the cursor rather than the top.
 * Ctrl+G opens a small box that goes to a line, or line:column.
 *
 * The textarea fallback keeps the browser's own find (all of its text is
 * in the DOM), so none of this is wired without CodeMirror.  In a chrome
 * page hosted in a tab the browser can claim Ctrl+F before us, which is why
 * the toolbar has a Find button too.
 *
 * Loaded before viewer.js, in the same page scope.
 */

/** Counting stops here, so a pattern that matches everything stays quick. */
const SV_FIND_MAX_MATCHES = 10000;

/** The longest selection that pre-fills the find field. */
const SV_FIND_MAX_PREFILL = 200;

var SvFind = {
  "_capped": false,
  "_cm": null,
  // The current match's TextMarker.
  "_current": null,
  "_index": -1,
  // Every match in the whole text, as {index, length}.
  "_matches": [],
  "_overlay": null,
  // The compiled query; null without one, or when it doesn't compile.
  "_regExp": null,
  "_string": null,

  /**
   * Wires the find bar, the go-to-line box, the toolbar's Find button and
   * the shortcuts.
   * @param {object} aCM - The CodeMirror instance.
   * @param {function(string, string): string} aString - Localised string
   *        lookup with an English fallback.
   * @returns {void}
   */
  "init": function (aCM, aString) {
    this._cm = aCM;
    this._string = aString;

    let input = this._el("gm-sv-find-input");
    input.setAttribute("placeholder",
        aString("sourceViewer.find.placeholder", "Find"));
    input.addEventListener("input", this._search.bind(this), false);
    input.addEventListener("keydown", function (aEvent) {
      if (aEvent.keyCode == 13) {
        aEvent.preventDefault();
        this._step(aEvent.shiftKey ? -1 : 1);
      } else if (aEvent.keyCode == 27) {
        aEvent.preventDefault();
        this._close();
      }
    }.bind(this), false);

    this._button("gm-sv-find-case", "sourceViewer.find.case", "Match case");
    this._button("gm-sv-find-word", "sourceViewer.find.word", "Whole word");
    this._button("gm-sv-find-regex", "sourceViewer.find.regex",
        "Regular expression");
    ["gm-sv-find-case", "gm-sv-find-word", "gm-sv-find-regex"].forEach(
        function (aId) {
          let toggle = this._el(aId);
          toggle.addEventListener("click", function () {
            toggle.setAttribute("aria-pressed",
                String(!this._isPressed(aId)));
            this._search();
            input.focus();
          }.bind(this), false);
        }, this);
    this._button("gm-sv-find-prev", "sourceViewer.find.prev",
        "Previous match (Shift+Enter)").addEventListener("click",
        this._step.bind(this, -1), false);
    this._button("gm-sv-find-next", "sourceViewer.find.next",
        "Next match (Enter)").addEventListener("click",
        this._step.bind(this, 1), false);
    this._button("gm-sv-find-close", "sourceViewer.find.close",
        "Close (Esc)").addEventListener("click",
        this._close.bind(this), false);

    let open = this._el("gm-sv-find-open");
    open.textContent = aString("sourceViewer.find.open", "Find");
    open.title = aString("sourceViewer.find.open.tooltip",
        "Find (Ctrl+F).  Ctrl+G goes to a line.");
    open.removeAttribute("hidden");
    open.addEventListener("click", this._open.bind(this), false);

    let gotoLabel = this._el("gm-sv-goto-label");
    gotoLabel.textContent = aString("sourceViewer.goto.label", "Go to line:");
    let gotoInput = this._el("gm-sv-goto-input");
    gotoInput.title = aString("sourceViewer.goto.tooltip",
        "A line number, or line:column");
    gotoInput.addEventListener("input", function () {
      gotoInput.removeAttribute("aria-invalid");
    }, false);
    gotoInput.addEventListener("keydown", function (aEvent) {
      if (aEvent.keyCode == 13) {
        aEvent.preventDefault();
        this._go();
      } else if (aEvent.keyCode == 27) {
        aEvent.preventDefault();
        this._closeGoto();
      }
    }.bind(this), false);

    window.addEventListener("keydown", this._onShortcut.bind(this), true);
  },

  "_onShortcut": function (aEvent) {
    let accel = (aEvent.ctrlKey || aEvent.metaKey) && !aEvent.altKey;
    if (accel && !aEvent.shiftKey && (aEvent.keyCode == 70)) {
      // Ctrl+F
      this._open();
    } else if (accel && !aEvent.shiftKey && (aEvent.keyCode == 71)) {
      // Ctrl+G
      this._openGoto();
    } else if (!accel && !aEvent.altKey && (aEvent.keyCode == 114)) {
      // F3 / Shift+F3
      if (this._el("gm-sv-find").hasAttribute("hidden")) {
        this._open();
      }
      this._step(aEvent.shiftKey ? -1 : 1);
    } else {
      return;
    }
    aEvent.preventDefault();
    aEvent.stopPropagation();
  },

  "_open": function () {
    this._closeGoto(true);
    let input = this._el("gm-sv-find-input");
    // A short one-line selection becomes the query, as in most editors.
    let selection = this._cm.getSelection();
    if (selection && (selection.length <= SV_FIND_MAX_PREFILL)
        && !/[\r\n]/.test(selection)) {
      input.value = selection;
    }
    this._el("gm-sv-find").removeAttribute("hidden");
    input.focus();
    input.select();
    this._search();
  },

  "_close": function () {
    this._hideFind();
    this._cm.focus();
  },

  /** Hides the bar and its highlights; the query stays for next time. */
  "_hideFind": function () {
    this._el("gm-sv-find").setAttribute("hidden", "hidden");
    this._regExp = null;
    this._matches = [];
    this._index = -1;
    this._highlight();
    this._markCurrent(null);
  },

  /** Recompiles the query, finds every match and moves to the nearest. */
  "_search": function () {
    let input = this._el("gm-sv-find-input");
    this._regExp = null;
    this._matches = [];
    this._index = -1;
    this._capped = false;
    input.removeAttribute("aria-invalid");
    input.title = "";
    if (input.value) {
      try {
        this._regExp = this._compile(input.value);
      } catch (e) {
        input.setAttribute("aria-invalid", "true");
        input.title = e.message || String(e);
      }
    }

    if (this._regExp) {
      let text = this._cm.getValue();
      let match;
      let from = 0;
      while ((match = this._next(text, from))) {
        if (this._matches.length == SV_FIND_MAX_MATCHES) {
          this._capped = true;
          break;
        }
        this._matches.push(match);
        from = match.index + match.length;
      }
      // The first match at or after the cursor (or selection), so typing
      // doesn't throw the view back to the top.
      let anchor = this._cm.indexFromPos(this._cm.getCursor("from"));
      this._index = 0;
      for (let i = 0, iLen = this._matches.length; i < iLen; i++) {
        if (this._matches[i].index >= anchor) {
          this._index = i;
          break;
        }
      }
      if (!this._matches.length) {
        this._index = -1;
      }
    }
    this._highlight();
    this._show();
  },

  /**
   * @param {string} aQuery
   * @returns {RegExp} Global and multi-line (^ and $ work per line),
   *          case-insensitive unless Match case is on.
   * @throws {SyntaxError} For a regular expression that doesn't compile.
   */
  "_compile": function (aQuery) {
    let source = this._isPressed("gm-sv-find-regex")
        ? aQuery : aQuery.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(source,
        "gm" + (this._isPressed("gm-sv-find-case") ? "" : "i"));
  },

  /**
   * The next match in aText at or after aFrom.  Empty matches (a bare ^ or
   * \b) are skipped, as there is nothing to show; with Whole word on, so
   * are matches inside a longer word.
   * @returns {{index: number, length: number}|null}
   */
  "_next": function (aText, aFrom) {
    let re = this._regExp;
    let wholeWord = this._isPressed("gm-sv-find-word");
    re.lastIndex = aFrom;
    let match;
    while ((match = re.exec(aText)) !== null) {
      let length = match[0].length;
      if (length && (!wholeWord
          || this._isWholeWord(aText, match.index, length))) {
        return {"index": match.index, "length": length};
      }
      re.lastIndex = match.index + 1;
    }
    return null;
  },

  /**
   * Whether a match isn't part of a longer word: it doesn't continue a word
   * character on either side.  (Gecko 52 has no lookbehind, so this checks
   * the neighbours instead of wrapping the pattern in \b.)
   */
  "_isWholeWord": function (aText, aIndex, aLength) {
    let word = /[\w$À-￿]/;
    let first = aText.charAt(aIndex);
    let last = aText.charAt(aIndex + aLength - 1);
    return !((aIndex > 0) && word.test(first)
        && word.test(aText.charAt(aIndex - 1)))
        && !(word.test(last) && word.test(aText.charAt(aIndex + aLength)));
  },

  /** Highlights every match on screen, line by line, or clears it. */
  "_highlight": function () {
    if (this._overlay) {
      this._cm.removeOverlay(this._overlay);
      this._overlay = null;
    }
    if (!this._regExp) {
      return;
    }
    let self = this;
    this._overlay = {
      "token": function (aStream) {
        let match = self._next(aStream.string, aStream.pos);
        if (!match) {
          aStream.skipToEnd();
          return null;
        }
        if (match.index > aStream.pos) {
          aStream.pos = match.index;
          return null;
        }
        aStream.pos += match.length;
        // Class "cm-gm-find".
        return "gm-find";
      },
    };
    this._cm.addOverlay(this._overlay);
  },

  /** Selects the current match, marks it and updates the count. */
  "_show": function () {
    let count = this._el("gm-sv-find-count");
    let input = this._el("gm-sv-find-input");
    let match = this._matches[this._index];
    if (match) {
      let from = this._cm.posFromIndex(match.index);
      let to = this._cm.posFromIndex(match.index + match.length);
      this._markCurrent({"from": from, "to": to});
      this._cm.setSelection(from, to);
      this._cm.scrollIntoView({"from": from, "to": to}, 60);
    } else {
      this._markCurrent(null);
    }

    if (!input.value) {
      count.textContent = "";
    } else if (input.hasAttribute("aria-invalid")) {
      count.textContent = this._string(
          "sourceViewer.find.invalid", "Bad pattern");
    } else if (!this._matches.length) {
      count.textContent = this._string(
          "sourceViewer.find.noResults", "No results");
    } else {
      count.textContent = this._string("sourceViewer.find.count", "%1 of %2")
          .replace("%1", (this._index + 1).toLocaleString())
          .replace("%2", this._matches.length.toLocaleString()
              + (this._capped ? "+" : ""));
    }
    count.setAttribute("problem", String(input.value != ""
        && (input.hasAttribute("aria-invalid") || !this._matches.length)));
  },

  "_markCurrent": function (aRange) {
    if (this._current) {
      this._current.clear();
      this._current = null;
    }
    if (aRange) {
      this._current = this._cm.markText(aRange.from, aRange.to,
          {"className": "gm-sv-find-current"});
    }
  },

  "_step": function (aDirection) {
    let count = this._matches.length;
    if (!count) {
      return;
    }
    this._index = (this._index + aDirection + count) % count;
    this._show();
  },

  "_openGoto": function () {
    this._hideFind();
    let input = this._el("gm-sv-goto-input");
    input.value = "";
    input.removeAttribute("aria-invalid");
    input.setAttribute("placeholder", this._string(
        "sourceViewer.goto.placeholder", "1–%1")
        .replace("%1", this._cm.lineCount().toLocaleString()));
    this._el("gm-sv-goto").removeAttribute("hidden");
    input.focus();
  },

  /**
   * @param {boolean} [aKeepFocus] - Leave the focus alone (the find bar is
   *        opening instead).
   */
  "_closeGoto": function (aKeepFocus) {
    let box = this._el("gm-sv-goto");
    if (box.hasAttribute("hidden")) {
      return;
    }
    box.setAttribute("hidden", "hidden");
    if (!aKeepFocus) {
      this._cm.focus();
    }
  },

  /** Puts the cursor on "line" or "line:column" (both from 1). */
  "_go": function () {
    let input = this._el("gm-sv-goto-input");
    let target = /^\s*(\d+)\s*(?:[:,]\s*(\d+))?\s*$/.exec(input.value);
    if (!target) {
      input.setAttribute("aria-invalid", "true");
      return;
    }
    let line = Math.min(Math.max(parseInt(target[1], 10), 1),
        this._cm.lineCount()) - 1;
    let ch = target[2]
        ? Math.min(Math.max(parseInt(target[2], 10), 1) - 1,
            this._cm.getLine(line).length)
        : 0;
    this._closeGoto();
    this._cm.setCursor({"ch": ch, "line": line});
    this._cm.scrollIntoView({"ch": ch, "line": line}, 100);
  },

  /** Sets a button's tooltip; returns the button. */
  "_button": function (aId, aKey, aFallback) {
    let button = this._el(aId);
    button.title = this._string(aKey, aFallback);
    return button;
  },

  "_isPressed": function (aId) {
    return this._el(aId).getAttribute("aria-pressed") == "true";
  },

  "_el": function (aId) {
    return document.getElementById(aId);
  },
};
