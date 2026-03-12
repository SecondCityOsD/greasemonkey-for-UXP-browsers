/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const EXPORTED_SYMBOLS = ["droppedUrls"];


/**
 * Extracts an array of URL strings from a drag-and-drop event's data transfer.
 * @param {DragEvent} aEvent - The drag event whose dataTransfer contains dropped items.
 * @returns {string[]} An array of URL strings extracted from the dropped items.
 */
function droppedUrls(aEvent) {
  let dataTransfer = aEvent.dataTransfer;
  let urls = [];

  // Convert every dropped item into a url.
  for (let i = 0, iLen = dataTransfer.mozItemCount; i < iLen; i++) {
    let url = dataTransfer.mozGetDataAt("text/uri-list", i);
    if (url) {
      urls.push(url);
      continue;
    }

    url = dataTransfer.mozGetDataAt("text/x-moz-url", i);
    if (url) {
      urls.push(url.split("\n")[0]);
      continue;
    }

    let file = dataTransfer.mozGetDataAt("application/x-moz-file", i);
    if (file) {
      urls.push(Services.io.newFileURI(file).spec);
      continue;
    }
  }

  return urls;
}
