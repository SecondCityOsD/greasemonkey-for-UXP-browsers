// Draws the toolbar button's count (how many user scripts ran on the
// selected tab; browser.js works it out) into the bottom corner of the
// button's own icon.
//
// The platform's badge (the badged-button class) wraps the icon in an
// extra stack.  The theme's rules for a menu-button's icon then stop
// reaching it, so the icon loses its padding and frame, and the badge
// hangs over the dropdown arrow.  Painting into the image changes neither:
// the button keeps the theme's layout and the count stays on the icon.

var GM_ToolbarBadge = {
  // Painted icons as data: URIs, by icon, count, scale and direction.
  "cache": new Map(),
  // Loaded icons by URL; null for one that failed to load.
  "images": new Map(),
  // Per button, bumped by every paint() so a slow icon load can't show a
  // stale count.
  "generations": new WeakMap(),
};

GM_ToolbarBadge.HTML_NS = "http://www.w3.org/1999/xhtml";
/** Painted icons kept: tab switches mostly move between a few counts. */
GM_ToolbarBadge.CACHE_SIZE = 24;
/** The platform's own badge red, with white figures. */
GM_ToolbarBadge.FILL = "#d90000";
GM_ToolbarBadge.TEXT = "#fff";

/**
 * Shows aCount in the corner of aButton's icon, or the plain icon at 0.
 * The icon painted on is the stylesheet's, so a theme's own icon and the
 * small-icons one both work.  The count sits in the icon's bottom-right
 * corner (bottom-left in right-to-left locales, where the arrow is on the
 * left), inside the icon, so it never covers the arrow.
 *
 * @param {Element} aButton - The toolbar button.
 * @param {number} aCount - How many scripts ran; 0 for no badge.
 */
GM_ToolbarBadge.paint = function (aButton, aCount) {
  let generations = GM_ToolbarBadge.generations;
  let generation = (generations.get(aButton) || 0) + 1;
  generations.set(aButton, generation);
  // Read the stylesheet's icon with the painted one taken off.  Nothing
  // is drawn in between, so the button doesn't flicker.
  aButton.style.removeProperty("list-style-image");
  aButton.style.removeProperty("-moz-image-region");
  if (!(aCount > 0)) {
    return undefined;
  }

  let style = window.getComputedStyle(aButton, null);
  let url = /^url\("(.+)"\)$/.exec(style.getPropertyValue("list-style-image"));
  let region = GM_ToolbarBadge.parseRegion(
      style.getPropertyValue("-moz-image-region"));
  if (!url || (region === undefined)) {
    return undefined;
  }
  let source = {
    "font": style.getPropertyValue("font-family") || "sans-serif",
    "region": region,
    "rtl": style.getPropertyValue("direction") == "rtl",
    "url": url[1],
  };
  let text = (aCount > 99) ? "99+" : String(aCount);
  let scale = window.devicePixelRatio || 1;

  GM_ToolbarBadge.loadImage(source.url, function (aImage) {
    if (!aImage || (generation != generations.get(aButton))) {
      return undefined;
    }
    let key = [source.url, JSON.stringify(region), source.rtl, scale, text]
        .join("|");
    let uri = GM_ToolbarBadge.cache.get(key);
    if (uri === undefined) {
      uri = GM_ToolbarBadge.draw(aImage, source, text, scale);
      if (GM_ToolbarBadge.cache.size >= GM_ToolbarBadge.CACHE_SIZE) {
        GM_ToolbarBadge.cache.clear();
      }
      GM_ToolbarBadge.cache.set(key, uri);
    }
    if (uri) {
      aButton.style.setProperty("list-style-image", 'url("' + uri + '")', "");
      if (region) {
        // The painted image is only that part of the icon.
        aButton.style.setProperty("-moz-image-region", "auto", "");
      }
    }
  });
};

/**
 * Parses a computed -moz-image-region (a theme's icon sprite).
 *
 * @param {string} aValue - "auto", or "rect(top, right, bottom, left)".
 * @returns {?Object} null for the whole image, {left, top, width, height}
 *   for a part of it, or undefined for a value this can't read (no badge).
 */
GM_ToolbarBadge.parseRegion = function (aValue) {
  if (!aValue || (aValue == "auto")) {
    return null;
  }
  let edges = /^rect\(([\d.]+)px,\s*([\d.]+)px,\s*([\d.]+)px,\s*([\d.]+)px\)$/
      .exec(aValue);
  if (!edges) {
    return undefined;
  }
  let [top, right, bottom, left] = edges.slice(1).map(Number);
  if ((right <= left) || (bottom <= top)) {
    return undefined;
  }
  return {
    "height": bottom - top,
    "left": left,
    "top": top,
    "width": right - left,
  };
};

/**
 * Calls aCallback with the loaded image at aUrl, or null when it can't be
 * loaded.  Loaded once per URL, then answered at once.
 */
GM_ToolbarBadge.loadImage = function (aUrl, aCallback) {
  if (GM_ToolbarBadge.images.has(aUrl)) {
    aCallback(GM_ToolbarBadge.images.get(aUrl));
    return undefined;
  }
  let image = document.createElementNS(GM_ToolbarBadge.HTML_NS, "img");
  image.addEventListener("load", function () {
    GM_ToolbarBadge.images.set(aUrl, image);
    aCallback(image);
  }, false);
  image.addEventListener("error", function () {
    GM_ToolbarBadge.images.set(aUrl, null);
    aCallback(null);
  }, false);
  image.src = aUrl;
};

/**
 * Paints the icon with aText in a pill in its bottom corner.
 *
 * @param {HTMLImageElement} aImage - The loaded icon.
 * @param {Object} aSource - font, region, rtl (see paint()).
 * @param {string} aText - The figures.
 * @param {number} aScale - Device pixels per CSS pixel.
 * @returns {?string} A data: URI the size of the icon, or null.
 */
GM_ToolbarBadge.draw = function (aImage, aSource, aText, aScale) {
  let region = aSource.region;
  let width = region ? region.width : aImage.naturalWidth;
  let height = region ? region.height : aImage.naturalHeight;
  if (!width || !height) {
    return null;
  }
  let canvas = document.createElementNS(GM_ToolbarBadge.HTML_NS, "canvas");
  canvas.width = Math.round(width * aScale);
  canvas.height = Math.round(height * aScale);
  let ctx = canvas.getContext("2d");
  ctx.scale(canvas.width / width, canvas.height / height);
  if (region) {
    ctx.drawImage(aImage, region.left, region.top, width, height,
        0, 0, width, height);
  } else {
    ctx.drawImage(aImage, 0, 0, width, height);
  }

  // Figures a third of the icon tall (8px on the 24px icon), 7px at
  // least, in a pill 2px taller: a circle for one figure, wider for more.
  let fontSize = Math.max(7, Math.round(height / 3));
  ctx.font = "bold " + fontSize + "px " + aSource.font + ", sans-serif";
  let pillHeight = fontSize + 2;
  let pillWidth = Math.min(width, Math.max(pillHeight,
      Math.ceil(ctx.measureText(aText).width) + 4));
  let x = aSource.rtl ? 0 : width - pillWidth;
  let y = height - pillHeight;

  // A 1px gap cut out of the icon around the pill sets it apart on any
  // icon and toolbar colour.
  ctx.globalCompositeOperation = "destination-out";
  GM_ToolbarBadge.pillPath(ctx, x - 1, y - 1, pillWidth + 2, pillHeight + 2);
  ctx.fill();
  ctx.globalCompositeOperation = "source-over";
  GM_ToolbarBadge.pillPath(ctx, x, y, pillWidth, pillHeight);
  ctx.fillStyle = GM_ToolbarBadge.FILL;
  ctx.fill();
  // Centre the figures on their height (about 0.72 of the font size), not
  // on the font's whole line, which sits them too low.
  ctx.fillStyle = GM_ToolbarBadge.TEXT;
  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillText(aText, x + pillWidth / 2,
      y + (pillHeight + fontSize * 0.72) / 2);

  let png = canvas.toDataURL("image/png");
  if ((canvas.width == width) && (canvas.height == height)) {
    return png;
  }
  // On a high-DPI screen the bigger bitmap has to show at the icon's
  // size: an SVG of that size around it says so.
  let svg = '<svg xmlns="http://www.w3.org/2000/svg"'
      + ' xmlns:xlink="http://www.w3.org/1999/xlink"'
      + ' width="' + width + '" height="' + height + '">'
      + '<image width="' + width + '" height="' + height + '"'
      + ' xlink:href="' + png + '"/></svg>';
  return "data:image/svg+xml," + encodeURIComponent(svg);
};

/** Traces a pill (a rectangle with round ends) for fill(). */
GM_ToolbarBadge.pillPath = function (aCtx, aX, aY, aWidth, aHeight) {
  let radius = aHeight / 2;
  aCtx.beginPath();
  aCtx.moveTo(aX + radius, aY);
  aCtx.lineTo(aX + aWidth - radius, aY);
  aCtx.arc(aX + aWidth - radius, aY + radius, radius,
      -Math.PI / 2, Math.PI / 2, false);
  aCtx.lineTo(aX + radius, aY + aHeight);
  aCtx.arc(aX + radius, aY + radius, radius,
      Math.PI / 2, Math.PI * 3 / 2, false);
  aCtx.closePath();
};
