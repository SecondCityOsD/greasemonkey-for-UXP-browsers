if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("resource://gre/modules/Services.jsm");

// The Values tab's editor for one key: valueEditor.xul, opened modal by
// scriptPrefs.js with one argument:
//   key           the key being edited; absent when adding one.
//   raw           its stored JSON text.
//   type          its type in the Values tab: "string", "object"… or
//                 "invalid" (stored text that isn't JSON).
//   existingKeys  when adding, the keys already in use.
// OK sets resultKey and resultJson on it: the key and the JSON to store.
// Strings only, since objects made here die with this window.
//
// A string is edited as plain text, so a script's JSON kept in a string
// (4chan X keeps its settings that way) reads without \" escapes.  Edit
// as JSON is for numbers, lists and objects, or to see a string quoted.

var GM_ValueEditor = {
  "args": null,
  "bundle": null,
  // "text": the box holds a string, stored as typed; "json": JSON.
  "mode": "text",
  // Pending check of a big value (see update()).
  "timer": null,
};

/** Values longer than this are checked after a pause in typing, not on
 *  every key: parsing them each time would lag. */
GM_ValueEditor.LARGE = 100000;

GM_ValueEditor.init = function () {
  let args = window.arguments && window.arguments[0];
  if (!args) {
    window.close();
    return undefined;
  }
  GM_ValueEditor.args = args;
  try {
    GM_ValueEditor.bundle = Services.strings.createBundle(
        "chrome://greasemonkey/locale/greasemonkey.properties");
  } catch (e) {
    // The English in valueEditor.xul and below stands in.
  }

  let adding = GM_ValueEditor.isAdding();
  document.title = adding
      ? GM_ValueEditor.str("scriptPrefs.values.addTitle", "Add value")
      : GM_ValueEditor.str("scriptPrefs.values.editTitle", "Edit value")
          + " — " + args.key;
  GM_ValueEditor.localize("ve-mode-label", "value",
      "scriptPrefs.values.editor.mode", "Edit as");
  GM_ValueEditor.localize("ve-mode-text", "label",
      "scriptPrefs.values.editor.text", "Text");
  GM_ValueEditor.localize("ve-mode-text", "tooltiptext",
      "scriptPrefs.values.editor.textTip", "Saved as text, exactly as typed.");
  GM_ValueEditor.localize("ve-mode-json", "tooltiptext",
      "scriptPrefs.values.editor.jsonTip",
      "Saved as the value the JSON describes: a number, true or false, "
      + "null, a list, an object, or text in quotes.");
  GM_ValueEditor.localize("ve-format", "label",
      "scriptPrefs.values.editor.format", "Format");
  GM_ValueEditor.localize("ve-format", "tooltiptext",
      "scriptPrefs.values.editor.formatTip",
      "Lays the JSON out over indented lines.");
  GM_ValueEditor.localize("ve-compact", "label",
      "scriptPrefs.values.editor.compact", "Compact");
  GM_ValueEditor.localize("ve-compact", "tooltiptext",
      "scriptPrefs.values.editor.compactTip",
      "Puts the JSON on one line, without spaces.");

  let keyBox = document.getElementById("ve-key");
  keyBox.value = adding ? "" : args.key;
  keyBox.readOnly = !adding;

  let initial = GM_ValueEditor.initialContent(args);
  GM_ValueEditor.mode = initial.mode;
  document.getElementById("ve-mode").value = initial.mode;
  let valueBox = document.getElementById("ve-value");
  valueBox.value = initial.text;
  valueBox.selectionStart = valueBox.selectionEnd = 0;
  GM_ValueEditor.check();
  (adding ? keyBox : valueBox).focus();
};

/** Whether the editor adds a key rather than editing one. */
GM_ValueEditor.isAdding = function () {
  return typeof GM_ValueEditor.args.key != "string";
};

/** Reads a localised string, or aFallback when the locale lacks it. */
GM_ValueEditor.str = function (aKey, aFallback) {
  try {
    return GM_ValueEditor.bundle.GetStringFromName(aKey);
  } catch (e) {
    return aFallback;
  }
};

GM_ValueEditor.localize = function (aId, aAttribute, aKey, aFallback) {
  document.getElementById(aId).setAttribute(
      aAttribute, GM_ValueEditor.str(aKey, aFallback));
};

/**
 * What the editor opens with: a new key starts as empty text, a string as
 * its text, invalid stored text as that text (OK stores it as a string),
 * and anything else as JSON, lists and objects laid out over lines.
 *
 * @returns {Object} {mode, text}.
 */
GM_ValueEditor.initialContent = function (aArgs) {
  if (typeof aArgs.key != "string") {
    return {"mode": "text", "text": ""};
  }
  let raw = (aArgs.raw == null) ? "" : String(aArgs.raw);
  let parsed = GM_ValueEditor.parse(raw);
  if ((aArgs.type == "invalid") || !parsed.ok) {
    return {"mode": "text", "text": raw};
  }
  if (typeof parsed.value == "string") {
    return {"mode": "text", "text": parsed.value};
  }
  return {
    "mode": "json",
    "text": GM_ValueEditor.isContainer(parsed.value)
        ? JSON.stringify(parsed.value, null, 2) : raw,
  };
};

/**
 * @returns {Object} {ok: true, value} or {ok: false, error}, the error
 *   without the engine's "JSON.parse: " prefix.
 */
GM_ValueEditor.parse = function (aText) {
  try {
    return {"ok": true, "value": JSON.parse(aText)};
  } catch (e) {
    return {
      "ok": false,
      "error": String(e && e.message || e).replace(/^JSON\.parse:\s*/, ""),
    };
  }
};

/** A list or an object: what Format and Compact lay out. */
GM_ValueEditor.isContainer = function (aValue) {
  return (typeof aValue == "object") && (aValue !== null);
};

/**
 * The box's text in aTo mode for the value aText has in aFrom mode, so
 * switching modes keeps the value: text becomes a JSON string, and a JSON
 * string becomes its text.  Other JSON stays as typed, to be stored as
 * that text.
 */
GM_ValueEditor.convert = function (aText, aFrom, aTo) {
  if (aFrom == aTo) {
    return aText;
  }
  if (aTo == "json") {
    return JSON.stringify(aText);
  }
  let parsed = GM_ValueEditor.parse(aText);
  return (parsed.ok && (typeof parsed.value == "string"))
      ? parsed.value : aText;
};

GM_ValueEditor.switchMode = function (aMode) {
  if (aMode == GM_ValueEditor.mode) {
    return undefined;
  }
  let box = document.getElementById("ve-value");
  let text = GM_ValueEditor.convert(box.value, GM_ValueEditor.mode, aMode);
  GM_ValueEditor.mode = aMode;
  GM_ValueEditor.replaceText(box, text);
};

/** Format (aIndent 2) or Compact (0) a list or an object in the box. */
GM_ValueEditor.reformat = function (aIndent) {
  let box = document.getElementById("ve-value");
  let parsed = GM_ValueEditor.parse(box.value);
  if (!parsed.ok || !GM_ValueEditor.isContainer(parsed.value)) {
    return undefined;
  }
  GM_ValueEditor.replaceText(box,
      JSON.stringify(parsed.value, null, aIndent || 0));
};

/**
 * Replaces the box's text as an edit, so Ctrl+Z can take it back (setting
 * value would clear the undo history), then checks it.
 */
GM_ValueEditor.replaceText = function (aBox, aText) {
  try {
    aBox.select();
    aBox.editor.QueryInterface(Ci.nsIPlaintextEditor).insertText(aText);
  } catch (e) {
    aBox.value = aText;
  }
  aBox.selectionStart = aBox.selectionEnd = 0;
  GM_ValueEditor.check();
};

/** After an edit: checks a small value now and a big one after a pause. */
GM_ValueEditor.update = function () {
  window.clearTimeout(GM_ValueEditor.timer);
  if (document.getElementById("ve-value").value.length
      > GM_ValueEditor.LARGE) {
    GM_ValueEditor.timer = window.setTimeout(GM_ValueEditor.check, 150);
  } else {
    GM_ValueEditor.check();
  }
};

/**
 * Says what stops OK, if anything, and updates the buttons.  An empty new
 * key only disables OK; it needs no message.  (A script may have stored a
 * value under "", so editing that one is fine.)
 *
 * @returns {Object} {key, parsed, problem, ready}: problem is null or a
 *   message; ready is whether OK can store the value.
 */
GM_ValueEditor.check = function () {
  window.clearTimeout(GM_ValueEditor.timer);
  let key = document.getElementById("ve-key").value;
  let text = document.getElementById("ve-value").value;
  let parsed = GM_ValueEditor.parse(text);
  let problem = null;
  if (GM_ValueEditor.isAdding()
      && (GM_ValueEditor.args.existingKeys || []).indexOf(key) != -1) {
    problem = GM_ValueEditor.str("scriptPrefs.values.addKeyExists",
        "A value already exists for that key. Use Edit to change it.");
  } else if ((GM_ValueEditor.mode == "json") && !parsed.ok) {
    // A function, so a "$" in the message is taken literally.
    problem = GM_ValueEditor.str("scriptPrefs.values.invalidJson",
        "Invalid JSON: %1").replace("%1", function () {
          return parsed.error;
        });
  }

  let ready = !problem && !(GM_ValueEditor.isAdding() && !key);

  let label = document.getElementById("ve-problem");
  label.value = problem || "";
  label.setAttribute("tooltiptext", problem || "");
  document.getElementById("ve-ok").disabled = !ready;
  let container = parsed.ok && GM_ValueEditor.isContainer(parsed.value);
  document.getElementById("ve-format").disabled = !container;
  document.getElementById("ve-compact").disabled = !container;
  return {"key": key, "parsed": parsed, "problem": problem, "ready": ready};
};

/** OK: hands the key and the JSON to store back, and closes. */
GM_ValueEditor.accept = function () {
  let state = GM_ValueEditor.check();
  if (!state.ready) {
    return undefined;
  }
  let text = document.getElementById("ve-value").value;
  GM_ValueEditor.args.resultKey = state.key;
  GM_ValueEditor.args.resultJson = (GM_ValueEditor.mode == "json")
      ? JSON.stringify(state.parsed.value) : JSON.stringify(text);
  window.close();
};
