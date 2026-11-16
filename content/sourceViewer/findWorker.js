/**
 * @file sourceViewer/findWorker.js
 * @overview The source viewer's find bar searches the whole file here, off
 *   the main thread.
 *
 * A regular expression can take exponential time on some text ("(\w+)*x"
 * on a long identifier, say), and nothing can interrupt it while it runs.
 * On the main thread that froze every window and tab, as UXP runs in one
 * process.  In a worker, find.js stops it (terminate()) once it has taken
 * too long, and the page stays responsive meanwhile.
 *
 * Messages in:
 *   {"text": string}  The file, once (and again after a restart).
 *   {"id": number, "source": string, "flags": string, "wholeWord": boolean}
 *                     A search.
 * Messages out:
 *   {"id", "count", "starts", "lengths"}  Every match: starts and lengths
 *                     are Int32Array buffers (transferred), count long.
 */

importScripts("findMatch.js");

var gText = "";

onmessage = function (aEvent) {
  let data = aEvent.data;
  if (typeof data.text == "string") {
    gText = data.text;
    return;
  }
  let found = SvFindMatch.all(
      new RegExp(data.source, data.flags), gText, data.wholeWord);
  postMessage({
    "count": found.count,
    "id": data.id,
    "lengths": found.lengths.buffer,
    "starts": found.starts.buffer,
  }, [found.starts.buffer, found.lengths.buffer]);
};
