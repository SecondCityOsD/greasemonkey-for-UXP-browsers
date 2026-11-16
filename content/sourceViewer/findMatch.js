/**
 * @file sourceViewer/findMatch.js
 * @overview What the source viewer's find bar counts as a match.  Shared by
 *   the page (find.js highlights the lines on screen with it) and the
 *   search worker (findWorker.js finds every match in the file with it), so
 *   the two always agree.
 *
 * Loaded by sourceViewer.xhtml before find.js, and by findWorker.js with
 * importScripts().  No DOM, no chrome APIs: it runs in a worker too.
 */

var SvFindMatch = {
  /**
   * Letters of scripts with no upper / lower case (CJK, Hebrew, Arabic,
   * kana, Hangul...), as code point ranges: CodeMirror's own list
   * (nonASCIISingleCaseWordChar, CodeMirror 5, MIT licence).
   */
  "_singleCaseRanges": [
    [0x00DF, 0x00DF], [0x0587, 0x0587], [0x0590, 0x05F4], [0x0600, 0x06FF],
    [0x3040, 0x309F], [0x30A0, 0x30FF], [0x3400, 0x4DB5], [0x4E00, 0x9FCC],
    [0xAC00, 0xD7AF],
  ],

  /**
   * Whether aCh is part of a word: CodeMirror's test (ASCII letters,
   * digits and "_"; past ASCII, anything with an upper and a lower case,
   * or a letter of a single-case script), plus "$", which script
   * identifiers use.  Punctuation and spaces past ASCII (curly quotes,
   * dashes, the ellipsis, arrows, the ideographic space...) are not.
   *
   * @param {string} aCh - One character (an empty string is not a word
   *        character).
   * @returns {boolean}
   */
  "isWordChar": function (aCh) {
    if (!aCh) {
      return false;
    }
    let code = aCh.charCodeAt(0);
    if (code < 0x80) {
      return /[\w$]/.test(aCh);
    }
    if (aCh.toUpperCase() != aCh.toLowerCase()) {
      return true;
    }
    return this._singleCaseRanges.some(function (aRange) {
      return (code >= aRange[0]) && (code <= aRange[1]);
    });
  },

  /**
   * Whether a match isn't part of a longer word: it doesn't continue a word
   * character on either side.  (Gecko 52 has no lookbehind, so this checks
   * the neighbours instead of wrapping the pattern in \b.)
   *
   * @param {string} aText
   * @param {number} aIndex  - Where the match starts.
   * @param {number} aLength - Its length (not 0).
   * @returns {boolean}
   */
  "isWholeWord": function (aText, aIndex, aLength) {
    let first = aText.charAt(aIndex);
    let last = aText.charAt(aIndex + aLength - 1);
    return !((aIndex > 0) && this.isWordChar(first)
        && this.isWordChar(aText.charAt(aIndex - 1)))
        && !(this.isWordChar(last)
        && this.isWordChar(aText.charAt(aIndex + aLength)));
  },

  /**
   * The next match in aText at or after aFrom.  Empty matches (a bare ^ or
   * \b) are skipped, as there is nothing to show; with Whole word on, so
   * are matches inside a longer word.
   *
   * @param {RegExp}  aRegExp    - Global ("g"): its lastIndex is used.
   * @param {string}  aText
   * @param {number}  aFrom
   * @param {boolean} aWholeWord
   * @returns {{index: number, length: number}|null}
   */
  "next": function (aRegExp, aText, aFrom, aWholeWord) {
    aRegExp.lastIndex = aFrom;
    let match;
    while ((match = aRegExp.exec(aText)) !== null) {
      let length = match[0].length;
      if (length && (!aWholeWord
          || this.isWholeWord(aText, match.index, length))) {
        return {"index": match.index, "length": length};
      }
      aRegExp.lastIndex = match.index + 1;
    }
    return null;
  },

  /**
   * Every match in aText, in order and not overlapping, however many: a
   * file the viewer shows in CodeMirror has at most 1.5 million characters,
   * so at most that many matches (12 MB here).
   *
   * @param {RegExp}  aRegExp
   * @param {string}  aText
   * @param {boolean} aWholeWord
   * @returns {{count: number, starts: Int32Array, lengths: Int32Array}}
   *          The arrays may be longer than count.
   */
  "all": function (aRegExp, aText, aWholeWord) {
    let starts = new Int32Array(256);
    let lengths = new Int32Array(256);
    let count = 0;
    let from = 0;
    let match;
    while ((match = this.next(aRegExp, aText, from, aWholeWord))) {
      if (count == starts.length) {
        let grownStarts = new Int32Array(count * 2);
        grownStarts.set(starts);
        starts = grownStarts;
        let grownLengths = new Int32Array(count * 2);
        grownLengths.set(lengths);
        lengths = grownLengths;
      }
      starts[count] = match.index;
      lengths[count] = match.length;
      count++;
      from = match.index + match.length;
    }
    return {"count": count, "lengths": lengths, "starts": starts};
  },
};
