/**
 * @file browserIsDark.js
 * @overview Whether a browser window looks dark, for the source viewer's
 *   and Scratchpad's Auto theme.
 */

const EXPORTED_SYMBOLS = ["browserIsDark", "browserThemeToolbar"];

/**
 * @param {Document} aDoc - A browser window's document.
 * @returns {Element|null} The toolbar whose brighttext attribute says
 *   whether the theme is dark: the navigation toolbar, else any shown one.
 */
function browserThemeToolbar(aDoc) {
  return aDoc.querySelector("#nav-bar:not([collapsed=true])")
      || aDoc.querySelector("toolbar:not([collapsed=true])");
}

/**
 * The browser marks a toolbar drawn in light text (a dark complete theme,
 * or the system's dark mode) with brighttext; a lightweight theme says so
 * on the window itself.
 *
 * @param {Window} aWindow - A browser window.
 * @returns {boolean}
 */
function browserIsDark(aWindow) {
  if (!aWindow) {
    return false;
  }
  let doc = aWindow.document;
  let toolbar = browserThemeToolbar(doc);
  if (toolbar) {
    return toolbar.hasAttribute("brighttext");
  }
  return doc.documentElement.getAttribute("lwthemetextcolor") == "bright";
}
