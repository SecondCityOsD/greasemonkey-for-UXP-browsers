if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const HTML_NS = "http://www.w3.org/1999/xhtml";

var gRemoteScript = window.arguments[0].wrappedJSObject[0];
var gBrowser = window.arguments[0].wrappedJSObject[1];
var gScript = window.arguments[0].wrappedJSObject[2];

var gAcceptButton = null;
var gCurrentDelay = null;
var gProgress = 0;
var gShowScriptButton = null;
var gTimer = null;
var gTotalDelay = new GM_PrefManager().getValue("installDelay", 5);

function init() {
  setUpIncludes("includes", "includes-label", "includes-description",
      gScript.includes);
  // An @exclude-match keeps the script off a page just like an @exclude.
  setUpIncludes("excludes", "excludes-label", "excludes-description",
      gScript.excludes.concat(gScript.excludeMatches.map(function (aMatch) {
        return aMatch.pattern;
      })));

  let matches = [];
  for (let i = 0, iLen = gScript.matches.length; i < iLen; i++) {
    let match = gScript.matches[i];
    matches.push(match.pattern);
  }
  setUpIncludes("matches", "matches-label", "matches-description", matches);

  gShowScriptButton = document.documentElement.getButton("extra1");
  gAcceptButton = document.documentElement.getButton("accept");
  gAcceptButton.baseLabel = gAcceptButton.label;

  startTimer();
  gShowScriptButton.disabled = true;

  let bundle = document.getElementById("gm-browser-bundle");

  document.getElementById("heading").appendChild(
      document.createTextNode(bundle.getString("greeting.msg")));

  let description = document.getElementById("script-description");
  description.appendChild(document.createElementNS(HTML_NS, "strong"));
  description.firstChild.appendChild(
      document.createTextNode(gScript.localized.name));
  if (gScript.version) {
    description.appendChild(document.createTextNode(" " + gScript.version));
  }
  description.appendChild(document.createElementNS(HTML_NS, "br"));
  description.appendChild(
      document.createTextNode(gScript.localized.description));

  // Everything else the user should see before installing: where the
  // script comes from, its declared antifeatures, metadata it had to
  // ignore, an unusual @run-at, what it may do (@grant, @connect) and the
  // code and files it loads from elsewhere.
  setUpSource("" + gRemoteScript.url);
  setUpSection("antifeatures", "install.antifeatures",
      "Antifeatures (@antifeature):", gScript.antifeatures);
  setUpSection("warnings", "install.warnings", "Warnings:",
      gScript.parseWarnings || []);
  if (gScript.runAt != "document-end") {
    setUpSection("runat", "install.runAt", "Runs at (@run-at):",
        [gScript.runAt]);
  }
  setUpSection("grants", "install.grants", "Permissions (@grant):",
      gScript.grants || []);
  setUpSection("connects", "install.connects", "Can connect to (@connect):",
      gScript.connects || []);
  setUpRequiresSummary(setUpDependencies("requires", "install.requires",
      "Code it loads (@require):", gScript.requires, false));
  setUpDependencies("resources", "install.resources",
      "Files it loads (@resource):", gScript.resources, true);

  let notice = document.getElementById("description-notice");
  let originalScriptVersion = document.getElementById(
      "original-script-version");
  let showOriginalScriptSource = document.getElementById(
      "original-script-source");

  let existingScript = GM_util.getService().config
      .getExistingScriptByScript(gScript);
  if (existingScript) {
    notice.style.display = "block";
    if (existingScript.version) {
      originalScriptVersion.setAttribute(
          "value", " (" + existingScript.version + ")");
    }
    showOriginalScriptSource.addEventListener("command", function () {
      GM_util.openInEditor(existingScript);
    });
  } else {
    notice.style.display = "none";
  }

  if (gRemoteScript.done) {
    // Download finished before we could open, fake a progress event.
    onProgress(null, null, 1);
  } else {
    // Otherwise, listen for future progress events.
    gRemoteScript.onProgress(onProgress);
  }
}

function onBlur(e) {
  stopTimer();
}

function onCancel() {
  gRemoteScript.cancel();
  window.close();
}

function onFocus(e) {
  startTimer();
}

function onInterval() {
  gCurrentDelay--;
  updateLabel();

  if (gCurrentDelay == 0) {
    stopTimer();
  }
}

function onOk() {
  // Stops multiple pressing of the button.
  gAcceptButton.disabled = true;
  gRemoteScript.install();
  window.setTimeout(window.close, 0);
}

function onProgress(aRemoteScript, aEventType, aData) {
  // Lingering download after window cancel.
  if (!document) {
    return undefined;
  }
  gProgress = Math.floor(100 * aData);
  if (gRemoteScript.done) {
    gShowScriptButton.disabled = false;

    document.getElementById("loading").style.display = "none";
    if (gRemoteScript.errorMessage) {
      gShowScriptButton.disabled = true;
      document.getElementById("dialog-content-box").style.display = "none";
      document.getElementById("error-content-box").style.display = "-moz-box";
      document.getElementById("error-message")
          .textContent = gRemoteScript.errorMessage;
      stopTimer();
      updateLabel(false);
      return undefined;
    }
  } else {
    document.getElementById("progressmeter").setAttribute("value", gProgress);
  }
  updateLabel();
}

function onShowSource() {
  gRemoteScript.showSource(gBrowser);
  window.setTimeout(window.close, 0);
}

function pauseTimer() {
  stopTimer();
  gCurrentDelay = gTotalDelay;
  updateLabel();
}

function setUpIncludes(aBox, aLabel, aDescription, aIncludes) {
  if (aIncludes.length > 0) {
    document.getElementById(aBox).style.display = "block";
    document.getElementById(aLabel).style.display = "block";
    aDescription = document.getElementById(aDescription);

    for (let i = 0, iLen = aIncludes.length; i < iLen; i++) {
      aDescription.appendChild(document.createTextNode(aIncludes[i]));
      aDescription.appendChild(document.createElementNS(HTML_NS, "br"));
    }

    aDescription.removeChild(aDescription.lastChild);
  }
}

/**
 * A string from gmBrowser.properties, or aFallback while this locale
 * doesn't have the key yet (strings added since the last locale pass).
 */
function installString(aKey, aFallback) {
  try {
    return document.getElementById("gm-browser-bundle").getString(aKey);
  } catch (e) {
    return aFallback;
  }
}

/**
 * setUpIncludes() for a section whose label is set here rather than in the
 * DTD; its elements are "<aName>", "<aName>-label" and
 * "<aName>-description".
 */
function setUpSection(aName, aLabelKey, aLabelFallback, aItems) {
  document.getElementById(aName + "-label").setAttribute("value",
      installString(aLabelKey, aLabelFallback));
  setUpIncludes(aName, aName + "-label", aName + "-description", aItems);
}

/**
 * Appends aUrl to aParent with its host in bold, so that the site stands
 * out.  The fragment, where a pinned hash lives, is left out, and a very
 * long URL (a data: one) is shortened.
 *
 * @returns {string} The URL's host (with any port), or "" if it has none.
 */
function appendUrl(aParent, aUrl) {
  const MAX_SHOWN = 200;
  let uri = GM_util.getUriFromUrl(aUrl);
  let host = "";
  try {
    host = uri.hostPort;
  } catch (e) {
    // No URI, or one without a host (data:): shown as it is below.
  }
  let rest = host ? uri.path : (uri ? uri.spec : aUrl);
  rest = rest.replace(/#.*$/, "");
  try {
    rest = decodeURI(rest);
  } catch (e) {
    // A malformed escape: keep the text encoded.
  }
  if (rest.length > MAX_SHOWN) {
    rest = rest.substring(0, MAX_SHOWN) + "…";
  }
  if (host) {
    let strong = document.createElementNS(HTML_NS, "strong");
    strong.appendChild(document.createTextNode(host));
    aParent.appendChild(document.createTextNode(uri.scheme + "://"));
    aParent.appendChild(strong);
  }
  aParent.appendChild(document.createTextNode(rest));
  return host;
}

/** "From: <url>" under the description: where the script comes from. */
function setUpSource(aUrl) {
  if (!aUrl) {
    return undefined;
  }
  let source = document.getElementById("script-source");
  source.appendChild(document.createTextNode(
      installString("install.from", "From:") + " "));
  appendUrl(source, aUrl);
  source.setAttribute("tooltiptext", aUrl);
}

/**
 * Lists @require or @resource dependencies in the section "<aName>" (with
 * "<aName>-label" and "<aName>-list"), one line each: the resource's name
 * (aNamed) and the URL with its host in bold.  The tooltip has the whole
 * URL and, for a dependency with a pinned hash, says that the download is
 * checked against it.
 *
 * @returns {string[]} The distinct hosts the dependencies come from.
 */
function setUpDependencies(
    aName, aLabelKey, aLabelFallback, aDependencies, aNamed) {
  let hosts = [];
  if (aDependencies.length == 0) {
    return hosts;
  }
  document.getElementById(aName).style.display = "block";
  document.getElementById(aName + "-label").setAttribute("value",
      installString(aLabelKey, aLabelFallback));
  let list = document.getElementById(aName + "-list");
  for (let i = 0, iLen = aDependencies.length; i < iLen; i++) {
    let dependency = aDependencies[i];
    let line = document.createElement("description");
    line.className = "dependency";
    let integrity = dependency._integrity;
    line.setAttribute("tooltiptext", dependency.downloadURL + (integrity
        ? "\n" + installString("install.integrity.pinned",
            "Checked against its pinned %1 hash.")
            .replace("%1", integrity.algo)
        : ""));
    if (aNamed) {
      line.appendChild(document.createTextNode(dependency.name + ": "));
    }
    let host = appendUrl(line, dependency.downloadURL);
    if (host && (hosts.indexOf(host) == -1)) {
      hosts.push(host);
    }
    list.appendChild(line);
  }
  return hosts;
}

/**
 * Names, above the @require list, the sites other than the script's own
 * that it runs code from: that code has all of the script's permissions.
 */
function setUpRequiresSummary(aHosts) {
  let ownHost = "";
  try {
    ownHost = GM_util.getUriFromUrl("" + gRemoteScript.url).hostPort;
  } catch (e) {
    // No host of its own (a local file): every host is another site.
  }
  let others = aHosts.filter(function (aHost) {
    return aHost != ownHost;
  });
  let summary = document.getElementById("requires-summary");
  summary.hidden = (others.length == 0);
  if (others.length) {
    summary.appendChild(document.createTextNode(installString(
        "install.requires.otherSites", "From other sites: %1")
        .replace("%1", others.join(", "))));
  }
}

function startTimer() {
  gCurrentDelay = gTotalDelay;
  updateLabel();

  gTimer = window.setInterval(onInterval, 500);
}

function stopTimer() {
  if (gTimer) {
    window.clearInterval(gTimer);
  }
  gCurrentDelay = 0;
}

function updateLabel(aOkAllowed) {
  if (typeof aOkAllowed == "undefined") {
    aOkAllowed = true;
  }

  if (gCurrentDelay > 0) {
    gAcceptButton.focus();
    gAcceptButton.label = gAcceptButton.baseLabel + " (" + gCurrentDelay + ")";
  } else {
    gAcceptButton.label = gAcceptButton.baseLabel;
  }

  /*
  Part 1/3 (remoteScript.js - Part 2/3 and 3/3).
  Sometimes - throws an errors:
    NS_ERROR_FILE_IS_LOCKED: Component returned failure code:
      0x8052000e (NS_ERROR_FILE_IS_LOCKED) [nsIFile.moveTo]
      remoteScript.js:394:0
    NS_ERROR_FILE_NOT_FOUND: Component returned failure code:
      0x80520012 (NS_ERROR_FILE_NOT_FOUND) [nsIFile.lastModifiedTime]
      script.js:474:0
    TypeError: this._tempDir is null
      remoteScript.js:394:4
  Especially if it contains many requires and resources
  and if the button "Install" is pressed too soon.
  gRemoteScript.done: This parameter also must be verified.
  */
  let disabled = aOkAllowed
      ? ((gCurrentDelay > 0) || (gProgress < 100) || !gRemoteScript.done)
      : true;
  gAcceptButton.disabled = disabled;
}

// See: closeWindow.xul.
function GM_onClose() {
  gRemoteScript.cleanup();
}
