/**
 * @file processScript.js
 * @overview Per-process (not per-tab) script that manages inter-process
 *   communication for Greasemonkey.
 *
 * Frame scripts are instantiated per tab and carry higher memory overhead.
 * This module is loaded once per content process instead, keeping the
 * footprint low for stateless operations.
 *
 * Responsibilities:
 *   - Registers the installPolicy content-policy component in every child
 *     process so that local file:// .user.js navigations are intercepted.
 *   - Handles the "greasemonkey:frame-urls" IPC message, which asks the
 *     content process to enumerate the URLs of all frames in a tab.
 *
 * IMPORTANT: Do not keep persistent references to frame scripts or their
 * content here — doing so can prevent frames from being garbage-collected
 * (memory leak).
 */

"use strict";

// Frame scripts, including all their functions, block scopes etc.
// are instantiated for each tab.
// Having a single per-process script has a lower footprint
// for stateless things.
// Avoid keeping references to frame scripts or their content,
// this could leak frames!

const EXPORTED_SYMBOLS = ["addFrame"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

// Each (child) process needs to handle navigation to ".user.js" via file:// .
Cu.import("chrome://greasemonkey-modules/content/installPolicy.js");


// \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ // \\ //

/**
 * Subscribes a frame message manager to the "greasemonkey:frame-urls"
 * request/response message pair.  Called once per tab when it is created.
 *
 * @param {nsIMessageListenerManager} aFrameMM - The frame's message manager.
 */
function addFrame(aFrameMM) {
  aFrameMM.addMessageListener("greasemonkey:frame-urls", urlTree);
}

/**
 * Recursively collects the href of every frame nested inside aContentWin.
 *
 * @param {Window} aContentWin - A content window (may have child frames).
 * @returns {string[]} Flat array of URL strings for aContentWin and all
 *                     of its descendant frames.
 */
function urlsOfAllFrames(aContentWin) {
  var urls = [aContentWin.location.href];
  function collect(aContentWin) {
    urls = urls.concat(urlsOfAllFrames(aContentWin));
  }
  Array.from(aContentWin.frames).forEach(collect);

  return urls;
}

/**
 * Message handler for "greasemonkey:frame-urls".
 * Collects all frame URLs in the tab and sends them back asynchronously.
 *
 * @param {object} aMessage - The IPC message object; aMessage.target is the
 *                            frame message manager for the requesting tab.
 */
function urlTree(aMessage) {
  let frameMM = aMessage.target;
  let urls = urlsOfAllFrames(frameMM.content);
  let response = {
    "urls": urls,
  };
  frameMM.sendAsyncMessage("greasemonkey:frame-urls", response);
}
