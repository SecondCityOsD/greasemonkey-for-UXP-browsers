/**
 * @file sourceViewer/find.js
 * @overview Find, and go to a line, in the source viewer's CodeMirror.
 *
 * CodeMirror virtualises its DOM (only the lines on screen exist), so the
 * browser's own find can't see the rest.  This bar searches the whole text
 * itself:
 *   - every match is found, however many, by a worker (findWorker.js) that
 *     is stopped after SV_FIND_TIMEOUT_MS: a regular expression can take
 *     exponential time, and on the main thread that froze the browser;
 *   - every match on screen is highlighted (through a CodeMirror overlay,
 *     once the worker has shown the pattern finishes) and the current one
 *     more strongly;
 *   - Match case, Whole word and Regular expression toggles (what counts as
 *     a match is in findMatch.js, shared with the worker);
 *   - a pattern that doesn't compile says so;
 *   - Enter / Shift+Enter, F3 / Shift+F3 and the arrows step through the
 *     matches, starting from the cursor rather than the top.
 * Ctrl+G opens a small box that goes to a line, or line:column.
 *
 * The textarea fallback keeps the browser's own find (all of its text is
 * in the DOM), so none of this is wired without CodeMirror.  In a chrome
 * page hosted in a tab the browser can claim Ctrl+F before us, which is why
 * the toolbar has a Find button too.
 *
 * Loaded after findMatch.js and before viewer.js, in the same page scope.
 */

/** The longest selection that pre-fills the find field. */
const SV_FIND_MAX_PREFILL = 200;

/** Typing waits this long (ms) for the next key before searching. */
const SV_FIND_TYPING_DELAY_MS = 100;

/** A search still running after this long (ms) is stopped. */
const SV_FIND_TIMEOUT_MS = 3000;

/** The count says "searching" once a search has taken this long (ms). */
const SV_FIND_BUSY_MS = 300;

const SV_FIND_WORKER_URL =
    "chrome://greasemonkey/content/sourceViewer/findWorker.js";

/** No matches. */
const SV_FIND_NONE = {
  "count": 0,
  "lengths": new Int32Array(0),
  "starts": new Int32Array(0),
};

var SvFind = {
  "_cm": null,
  // The current match's TextMarker.
  "_current": null,
  // Every match: {count, starts, lengths}, in order.
  "_found": SV_FIND_NONE,
  "_index": -1,
  // The search waiting for the worker: {id, request, timer, busyTimer}.
  "_pending": null,
  "_overlay": null,
  // The query the highlights are for; null until its search has finished.
  "_regExp": null,
  "_searchId": 0,
  // The text range the bar last selected, as {from, to} indexes.
  "_shown": null,
  "_string": null,
  // The last search was stopped for taking too long.
  "_tooSlow": false,
  "_typingTimer": null,
  "_wholeWord": false,
  "_worker": null,
  // Workers can't be used here: search on the main thread instead.
  "_workerless": false,

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
    input.addEventListener("input", this._typed.bind(this), false);
    input.addEventListener("keydown", function (aEvent) {
      if (aEvent.keyCode == 13) {
        aEvent.preventDefault();
        if (this._typingTimer) {
          // Typed, then Enter at once: search now.  It lands on the first
          // match from the cursor, which is the next one for a new query.
          this._search();
        } else {
          this._step(aEvent.shiftKey ? -1 : 1);
        }
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
    open.addEventListener("click", this._open.bind(this, "from"), false);

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
    window.addEventListener("unload", this._stopWorker.bind(this), false);
  },

  "_onShortcut": function (aEvent) {
    let accel = (aEvent.ctrlKey || aEvent.metaKey) && !aEvent.altKey;
    if (accel && !aEvent.shiftKey && (aEvent.keyCode == 70)) {
      // Ctrl+F
      this._open("from");
    } else if (accel && !aEvent.shiftKey && (aEvent.keyCode == 71)) {
      // Ctrl+G
      this._openGoto();
    } else if (!accel && !aEvent.altKey && (aEvent.keyCode == 114)) {
      // F3 / Shift+F3.  With the bar closed, the search itself lands on the
      // match after (before) the cursor or selection: stepping as well
      // skipped the nearest one.
      if (this._el("gm-sv-find").hasAttribute("hidden")) {
        this._open(aEvent.shiftKey ? "before" : "after");
      } else {
        this._step(aEvent.shiftKey ? -1 : 1);
      }
    } else {
      return;
    }
    aEvent.preventDefault();
    aEvent.stopPropagation();
  },

  /**
   * Shows the bar and searches.
   * @param {string} aAnchor - Where to land: see _search.
   */
  "_open": function (aAnchor) {
    this._closeGoto(true);
    let input = this._el("gm-sv-find-input");
    // A short one-line selection becomes the query, as in most editors, but
    // not the match this bar selected: that replaced a pattern with the
    // text it found.  In regex mode the text is escaped.
    let selection = this._cm.getSelection();
    if (selection && (selection.length <= SV_FIND_MAX_PREFILL)
        && !/[\r\n]/.test(selection) && !this._selectionIsShownMatch()) {
      input.value = this._isPressed("gm-sv-find-regex")
          ? this._escape(selection) : selection;
    }
    this._el("gm-sv-find").removeAttribute("hidden");
    input.focus();
    input.select();
    this._search(aAnchor);
  },

  "_close": function () {
    this._hideFind();
    this._cm.focus();
  },

  /** Hides the bar and its highlights; the query stays for next time. */
  "_hideFind": function () {
    this._el("gm-sv-find").setAttribute("hidden", "hidden");
    this._cancelSearch();
    this._regExp = null;
    this._found = SV_FIND_NONE;
    this._index = -1;
    this._tooSlow = false;
    this._highlight();
    this._markCurrent(null);
  },

  /** The field changed: search once typing pauses. */
  "_typed": function () {
    if (this._typingTimer) {
      clearTimeout(this._typingTimer);
    }
    this._typingTimer = setTimeout(
        this._search.bind(this, "from"), SV_FIND_TYPING_DELAY_MS);
  },

  /**
   * Compiles the query and has every match found; the results arrive in
   * _searched.
   * @param {string} [aAnchor="from"] - The match to land on:
   *   "from"   the first at or after the cursor (or selection start), so
   *            typing doesn't throw the view back to the top;
   *   "after"  the first at or after the selection's end (F3);
   *   "before" the last before the selection's start (Shift+F3).
   */
  "_search": function (aAnchor) {
    if (this._typingTimer) {
      clearTimeout(this._typingTimer);
      this._typingTimer = null;
    }
    this._cancelSearch();
    this._tooSlow = false;
    let input = this._el("gm-sv-find-input");
    input.removeAttribute("aria-invalid");
    input.title = "";
    let regExp = null;
    if (input.value) {
      try {
        regExp = this._compile(input.value);
      } catch (e) {
        input.setAttribute("aria-invalid", "true");
        input.title = e.message || String(e);
      }
    }
    if (!regExp) {
      this._searched(null, SV_FIND_NONE);
      return;
    }

    let request = {
      "anchor": aAnchor || "from",
      "from": this._cm.indexFromPos(this._cm.getCursor("from")),
      "regExp": regExp,
      "to": this._cm.indexFromPos(this._cm.getCursor("to")),
      "wholeWord": this._isPressed("gm-sv-find-word"),
    };
    let worker = this._getWorker();
    if (!worker) {
      this._searched(request, SvFindMatch.all(
          regExp, this._cm.getValue(), request.wholeWord));
      return;
    }
    let id = ++this._searchId;
    this._pending = {
      "busyTimer": setTimeout(this._show.bind(this), SV_FIND_BUSY_MS),
      "id": id,
      "request": request,
      "timer": setTimeout(this._timedOut.bind(this), SV_FIND_TIMEOUT_MS),
    };
    worker.postMessage({
      "flags": regExp.flags,
      "id": id,
      "source": regExp.source,
      "wholeWord": request.wholeWord,
    });
  },

  /**
   * A search's results: shows them and lands on the match the request
   * asks for.  Until they come, the previous results stay on screen.
   * @param {object|null} aRequest - null for no query, or a bad one.
   * @param {{count: number, starts: Int32Array, lengths: Int32Array}} aFound
   */
  "_searched": function (aRequest, aFound) {
    this._found = aFound;
    this._regExp = aRequest ? aRequest.regExp : null;
    this._wholeWord = aRequest ? aRequest.wholeWord : false;
    this._index = -1;
    let count = aFound.count;
    if (aRequest && count) {
      if (aRequest.anchor == "before") {
        this._index = this._firstFrom(aRequest.from) - 1;
        if (this._index < 0) {
          this._index = count - 1;
        }
      } else {
        this._index = this._firstFrom(
            (aRequest.anchor == "after") ? aRequest.to : aRequest.from);
        if (this._index == count) {
          this._index = 0;
        }
      }
    }
    this._highlight();
    this._show();
  },

  /** The index of the first match starting at or after aPos (count if none). */
  "_firstFrom": function (aPos) {
    let starts = this._found.starts;
    let low = 0;
    let high = this._found.count;
    while (low < high) {
      let middle = (low + high) >>> 1;
      if (starts[middle] < aPos) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  },

  /**
   * The search worker, started on first use with the file's text, or null
   * where workers can't run (then searches run on the main thread).
   */
  "_getWorker": function () {
    if (this._worker || this._workerless) {
      return this._worker;
    }
    if (typeof Worker == "undefined") {
      this._workerless = true;
      return null;
    }
    try {
      let worker = new Worker(SV_FIND_WORKER_URL);
      worker.onmessage = this._onWorkerMessage.bind(this);
      worker.onerror = this._onWorkerError.bind(this);
      worker.postMessage({"text": this._cm.getValue()});
      this._worker = worker;
    } catch (e) {
      this._workerless = true;
    }
    return this._worker;
  },

  "_onWorkerMessage": function (aEvent) {
    let data = aEvent.data;
    let pending = this._pending;
    if (!pending || (data.id !== pending.id)) {
      // A search that was replaced while it ran.
      return;
    }
    this._clearPending();
    this._searched(pending.request, {
      "count": data.count,
      "lengths": new Int32Array(data.lengths),
      "starts": new Int32Array(data.starts),
    });
  },

  /** The worker script itself failed: search on the main thread. */
  "_onWorkerError": function (aEvent) {
    if (aEvent && aEvent.preventDefault) {
      aEvent.preventDefault();
    }
    let pending = this._pending;
    this._clearPending();
    this._stopWorker();
    this._workerless = true;
    if (pending) {
      this._searched(pending.request, SvFindMatch.all(pending.request.regExp,
          this._cm.getValue(), pending.request.wholeWord));
    }
  },

  /** The search ran too long: stop it, and say so. */
  "_timedOut": function () {
    if (!this._pending) {
      return;
    }
    this._clearPending();
    this._stopWorker();
    this._searched(null, SV_FIND_NONE);
    this._tooSlow = true;
    let input = this._el("gm-sv-find-input");
    input.title = this._string("sourceViewer.find.tooSlow.tooltip",
        "This search took over %1 seconds, so it was stopped.")
        .replace("%1", String(SV_FIND_TIMEOUT_MS / 1000));
    this._show();
  },

  /**
   * Drops the search in progress, if any.  A worker still busy with it is
   * stopped (it may be stuck in a slow pattern) and restarted when needed.
   */
  "_cancelSearch": function () {
    if (this._pending) {
      this._clearPending();
      this._stopWorker();
    }
  },

  "_clearPending": function () {
    if (this._pending) {
      clearTimeout(this._pending.timer);
      clearTimeout(this._pending.busyTimer);
      this._pending = null;
    }
  },

  "_stopWorker": function () {
    if (this._worker) {
      this._worker.terminate();
      this._worker = null;
    }
  },

  /**
   * @param {string} aQuery
   * @returns {RegExp} Global and multi-line (^ and $ work per line),
   *          case-insensitive unless Match case is on.
   * @throws {SyntaxError} For a regular expression that doesn't compile.
   */
  "_compile": function (aQuery) {
    let source = this._isPressed("gm-sv-find-regex")
        ? aQuery : this._escape(aQuery);
    return new RegExp(source,
        "gm" + (this._isPressed("gm-sv-find-case") ? "" : "i"));
  },

  /** aText as a regular expression that matches it literally. */
  "_escape": function (aText) {
    return aText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  },

  /**
   * Highlights every match on screen, line by line, or clears it.  Set only
   * once the worker has run the whole file with the query in time, so a
   * line on screen can't be slow.
   */
  "_highlight": function () {
    if (this._overlay) {
      this._cm.removeOverlay(this._overlay);
      this._overlay = null;
    }
    if (!this._regExp || !this._found.count) {
      return;
    }
    let regExp = this._regExp;
    let wholeWord = this._wholeWord;
    this._overlay = {
      "token": function (aStream) {
        let match = SvFindMatch.next(
            regExp, aStream.string, aStream.pos, wholeWord);
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
    let total = this._found.count;
    if ((this._index >= 0) && (this._index < total)) {
      let start = this._found.starts[this._index];
      let end = start + this._found.lengths[this._index];
      let from = this._cm.posFromIndex(start);
      let to = this._cm.posFromIndex(end);
      this._markCurrent({"from": from, "to": to});
      this._cm.setSelection(from, to);
      this._cm.scrollIntoView({"from": from, "to": to}, 60);
      this._shown = {"from": start, "to": end};
    } else {
      this._markCurrent(null);
    }

    let problem = false;
    if (!input.value) {
      count.textContent = "";
    } else if (input.hasAttribute("aria-invalid")) {
      count.textContent = this._string(
          "sourceViewer.find.invalid", "Bad pattern");
      problem = true;
    } else if (this._tooSlow) {
      count.textContent = this._string(
          "sourceViewer.find.tooSlow", "Too slow");
      problem = true;
    } else if (this._pending) {
      // Still searching: the previous results stay until it's done.
      count.textContent = "…";
    } else if (!total) {
      count.textContent = this._string(
          "sourceViewer.find.noResults", "No results");
      problem = true;
    } else {
      count.textContent = this._string("sourceViewer.find.count", "%1 of %2")
          .replace("%1", (this._index + 1).toLocaleString())
          .replace("%2", total.toLocaleString());
    }
    count.setAttribute("problem", String(problem));
  },

  /** Whether the selection is the match this bar last selected. */
  "_selectionIsShownMatch": function () {
    return !!this._shown
        && (this._cm.indexFromPos(this._cm.getCursor("from"))
            == this._shown.from)
        && (this._cm.indexFromPos(this._cm.getCursor("to"))
            == this._shown.to);
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
    let count = this._found.count;
    if (!count || this._pending) {
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
