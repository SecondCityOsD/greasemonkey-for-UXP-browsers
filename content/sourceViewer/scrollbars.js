/**
 * @file sourceViewer/scrollbars.js
 * @overview Scrollbars drawn in the viewer's own colours.
 *
 * Gecko 52 can't recolour native scrollbars (it has no scrollbar-color), so
 * with the dark palette CodeMirror's native bars stayed light.  CodeMirror
 * takes a page-defined scrollbar model instead (CodeMirror.scrollbarModel,
 * chosen with the scrollbarStyle option).  This one draws each bar as a
 * plain track and thumb, coloured from the theme's variables:
 *   - dragging the thumb scrolls with it;
 *   - clicking the track scrolls a page towards the click;
 *   - the mouse wheel over a bar scrolls along that bar.
 * Everywhere else the wheel and the keyboard go through CodeMirror as
 * before.
 *
 * viewer.js registers SvScrollbars once the CodeMirror bundle has loaded.
 * Loaded before viewer.js, in the same page scope.
 */

/** Name under CodeMirror.scrollbarModel, and the scrollbarStyle value. */
const SV_SCROLLBAR_STYLE = "gm-themed";

/** Bar thickness in px; .gm-sv-scrollbar in the CSS uses the same. */
const SV_SCROLLBAR_SIZE = 14;

/** Shortest thumb in px, so a huge file still has something to grab. */
const SV_SCROLLBAR_MIN_THUMB = 24;

/**
 * One bar: a track with a thumb.
 * @constructor
 * @param {string} aAxis - "vertical" or "horizontal", as CodeMirror's
 *        scroll callback expects.
 * @param {function(number, string)} aScroll - CodeMirror's scroll callback.
 * @param {object} aCM - The CodeMirror instance (for its line height).
 */
function SvScrollbar(aAxis, aScroll, aCM) {
  this._axis = aAxis;
  this._cm = aCM;
  this._scroll = aScroll;
  this._vertical = (aAxis == "vertical");

  this._barSize = 0;
  this._clientSize = 0;
  // The drag in progress: the mouse coordinate and scroll position at its
  // start.
  this._drag = null;
  this._pos = 0;
  // How far the code scrolls: its full size less the visible part.
  this._range = 0;
  this._thumbSize = 0;

  this.node = document.createElement("div");
  this.node.className = "gm-sv-scrollbar gm-sv-scrollbar-" + aAxis;
  this.node.style.display = "none";
  this._thumb = document.createElement("div");
  this._thumb.className = "gm-sv-scrollbar-thumb";
  this.node.appendChild(this._thumb);

  this.node.addEventListener("mousedown", this, false);
  this.node.addEventListener("wheel", this, false);
}

/** @param {boolean} aShown */
SvScrollbar.prototype.show = function (aShown) {
  this.node.style.display = aShown ? "block" : "none";
};

/**
 * Sizes the thumb for content of aScrollSize seen aClientSize at a time,
 * on a track aBarSize long (all in px).
 */
SvScrollbar.prototype.resize = function (aScrollSize, aClientSize, aBarSize) {
  this._barSize = Math.max(0, aBarSize);
  this._clientSize = aClientSize;
  this._range = Math.max(0, aScrollSize - aClientSize);
  this._thumbSize = Math.min(this._barSize,
      Math.max(SV_SCROLLBAR_MIN_THUMB,
          Math.round(this._barSize * aClientSize / Math.max(1, aScrollSize))));
  this._thumb.style[this._vertical ? "height" : "width"] =
      this._thumbSize + "px";
  this.setPos(this._pos);
};

/** Moves the thumb to a scroll position (from CodeMirror, or our own). */
SvScrollbar.prototype.setPos = function (aPos) {
  this._pos = this._clamp(aPos);
  let travel = this._barSize - this._thumbSize;
  let offset = (this._range > 0)
      ? Math.round(travel * this._pos / this._range) : 0;
  this._thumb.style[this._vertical ? "top" : "left"] = offset + "px";
};

SvScrollbar.prototype.remove = function () {
  this._endDrag();
  if (this.node.parentNode) {
    this.node.parentNode.removeChild(this.node);
  }
};

SvScrollbar.prototype.handleEvent = function (aEvent) {
  switch (aEvent.type) {
    case "mousedown":
      this._onMouseDown(aEvent);
      break;
    case "mousemove":
      this._onMouseMove(aEvent);
      break;
    case "mouseup":
      this._endDrag();
      break;
    case "wheel":
      this._onWheel(aEvent);
      break;
  }
};

SvScrollbar.prototype._clamp = function (aPos) {
  return Math.max(0, Math.min(this._range, aPos));
};

SvScrollbar.prototype._coordinate = function (aEvent) {
  return this._vertical ? aEvent.clientY : aEvent.clientX;
};

/** Scrolls the code; CodeMirror reports the new position back to setPos. */
SvScrollbar.prototype._scrollTo = function (aPos) {
  let pos = this._clamp(aPos);
  if (pos != this._pos) {
    this.setPos(pos);
    this._scroll(pos, this._axis);
  }
};

SvScrollbar.prototype._onMouseDown = function (aEvent) {
  if (aEvent.button != 0) {
    return;
  }
  // No text selection while dragging.
  aEvent.preventDefault();
  if (aEvent.target == this._thumb) {
    this._drag = {"pos": this._pos, "start": this._coordinate(aEvent)};
    this._thumb.setAttribute("dragging", "true");
    window.addEventListener("mousemove", this, true);
    window.addEventListener("mouseup", this, true);
    return;
  }
  // The track: a page (less a line of overlap) towards the click.
  let thumb = this._thumb.getBoundingClientRect();
  let page = Math.max(1, this._clientSize - this._cm.defaultTextHeight());
  let before = this._coordinate(aEvent)
      < (this._vertical ? thumb.top : thumb.left);
  this._scrollTo(this._pos + (before ? -page : page));
};

SvScrollbar.prototype._onMouseMove = function (aEvent) {
  let travel = this._barSize - this._thumbSize;
  if (!this._drag || (travel <= 0)) {
    return;
  }
  aEvent.preventDefault();
  let moved = this._coordinate(aEvent) - this._drag.start;
  this._scrollTo(this._drag.pos + (moved * this._range / travel));
};

SvScrollbar.prototype._endDrag = function () {
  if (!this._drag) {
    return;
  }
  this._drag = null;
  this._thumb.removeAttribute("dragging");
  window.removeEventListener("mousemove", this, true);
  window.removeEventListener("mouseup", this, true);
};

SvScrollbar.prototype._onWheel = function (aEvent) {
  // A plain wheel over the horizontal bar scrolls it sideways.
  let delta = this._vertical
      ? aEvent.deltaY : (aEvent.deltaX || aEvent.deltaY);
  if (!delta) {
    return;
  }
  aEvent.preventDefault();
  if (aEvent.deltaMode == 1) {
    // DOM_DELTA_LINE, the usual mode on Windows.
    delta *= this._cm.defaultTextHeight();
  } else if (aEvent.deltaMode == 2) {
    // DOM_DELTA_PAGE.
    delta *= this._clientSize;
  }
  this._scrollTo(this._pos + delta);
};

/**
 * The scrollbar model CodeMirror constructs (see initScrollbars in the
 * bundle): it places both bars, reports how much room they take and
 * follows the scroll position.
 * @constructor
 * @param {function(Element)} aPlace - Puts a bar into CodeMirror's wrapper.
 * @param {function(number, string)} aScroll - Scrolls the code.
 * @param {object} aCM - The CodeMirror instance.
 */
function SvScrollbars(aPlace, aScroll, aCM) {
  this._horiz = new SvScrollbar("horizontal", aScroll, aCM);
  this._vert = new SvScrollbar("vertical", aScroll, aCM);
  aPlace(this._vert.node);
  aPlace(this._horiz.node);
}

/**
 * @param {object} aMeasure - CodeMirror's measureForScrollbars() result.
 * @returns {{right: number, bottom: number}} The room the bars take.
 */
SvScrollbars.prototype.update = function (aMeasure) {
  let size = SV_SCROLLBAR_SIZE;
  let needsH = aMeasure.scrollWidth > aMeasure.clientWidth + 1;
  let needsV = aMeasure.scrollHeight > aMeasure.clientHeight + 1;

  this._vert.show(needsV);
  if (needsV) {
    this._vert.node.style.bottom = (needsH ? size : 0) + "px";
    this._vert.resize(aMeasure.scrollHeight, aMeasure.clientHeight,
        aMeasure.viewHeight - (needsH ? size : 0));
  }
  this._horiz.show(needsH);
  if (needsH) {
    // The bar starts after the line-number gutter, like the native one.
    this._horiz.node.style.left = aMeasure.barLeft + "px";
    this._horiz.node.style.right = (needsV ? size : 0) + "px";
    this._horiz.resize(aMeasure.scrollWidth, aMeasure.clientWidth,
        aMeasure.viewWidth - aMeasure.barLeft - (needsV ? size : 0));
  }
  return {"bottom": needsH ? size : 0, "right": needsV ? size : 0};
};

SvScrollbars.prototype.setScrollLeft = function (aPos) {
  this._horiz.setPos(aPos);
};

SvScrollbars.prototype.setScrollTop = function (aPos) {
  this._vert.setPos(aPos);
};

SvScrollbars.prototype.clear = function () {
  this._horiz.remove();
  this._vert.remove();
};
