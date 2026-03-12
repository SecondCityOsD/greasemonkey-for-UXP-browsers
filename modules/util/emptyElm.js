/**
 * @file emptyElm.js
 * @overview Removes all child nodes from a DOM element.
 */

const EXPORTED_SYMBOLS = ["emptyElm"];


/**
 * Removes all child nodes from a DOM element.
 * @param {Element} aElm - The DOM element to empty.
 * @returns {void}
 */
function emptyElm(aElm) {
  while (aElm.firstChild) {
    aElm.removeChild(aElm.firstChild);
  }
}
