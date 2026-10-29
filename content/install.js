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
Cu.import("chrome://greasemonkey-modules/content/sourceViewerTabs.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const HTML_NS = "http://www.w3.org/1999/xhtml";

// The Install button unlocks once the window has had the focus for
// installDelay ticks (default 2: 0.8 seconds).  Losing the focus starts the
// count again, so a page can't pop this window up under the cursor and
// time a click onto Install; that, not the length, is what the delay is
// for.
const TIMER_TICK_MS = 400;

var gRemoteScript = window.arguments[0].wrappedJSObject[0];
var gBrowser = window.arguments[0].wrappedJSObject[1];
var gScript = window.arguments[0].wrappedJSObject[2];

var gAcceptButton = null;
var gCurrentDelay = null;
// Dependency -> its line in the @require / @resource lists:
// {code, line, status, tooltip}; see setUpDependencies.
var gDependencyLines = new Map();
// Install was clicked while files were still downloading ("click-ahead"):
// onProgress installs once they are all in.
var gInstallQueued = false;
var gProgress = 0;
var gShowScriptButton = null;
var gTimer = null;
var gTotalDelay = new GM_PrefManager().getValue("installDelay", 2);

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
  window.addEventListener("blur", onBlur, false);
  window.addEventListener("focus", onFocus, false);
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
  setUpIcon();

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
  gRemoteScript.onDependency(onDependency);

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

// Only the window's own focus changes count, not those between its
// buttons; and a queued install isn't held up any more.
function onBlur(aEvent) {
  if ((aEvent.target == window) && !gInstallQueued) {
    pauseTimer();
  }
}

function onCancel() {
  gRemoteScript.cancel();
  window.close();
}

/**
 * A dependency's download state (RemoteScript.onDependency): its line ends
 * in "…" while it downloads, then in its size.  Once a code or text file
 * is in, clicking its line opens the downloaded copy in the source viewer.
 */
function onDependency(aRemoteScript, aEventType, aReport) {
  // Lingering download after window cancel.
  if (!document) {
    return undefined;
  }
  // The @icon isn't listed: it goes beside the name once it's in.
  if (aReport.dependency === gScript.icon) {
    if (aReport.state == "done") {
      showIcon(GM_util.getUriFromFile(aReport.file).spec);
    }
    return undefined;
  }
  let entry = gDependencyLines.get(aReport.dependency);
  if (!entry) {
    return undefined;
  }
  let status = entry.status;
  while (status.firstChild) {
    status.removeChild(status.firstChild);
  }
  if (aReport.state == "downloading") {
    status.appendChild(document.createTextNode("…"));
  } else if (aReport.state == "done") {
    if (aReport.size !== null) {
      status.appendChild(document.createTextNode(installString(
          "install.size.kb", "%1 KB")
          .replace("%1", Math.ceil(aReport.size / 1024).toLocaleString())));
    }
    if (entry.code || /^text\/|javascript|json|xml|css/i
        .test(aReport.dependency.mimetype || "")) {
      entry.line.setAttribute("viewable", "true");
      entry.line.setAttribute("tooltiptext", entry.tooltip + "\n"
          + installString("install.dependency.view", "Click to view it."));
      entry.line.addEventListener("click", function () {
        viewDependencyFile(aReport.file, aReport.dependency.downloadURL);
      }, false);
    }
  }
}

/**
 * Opens a downloaded dependency in the source viewer, in a tab of the
 * browser window, which comes to the front.  (This window keeps its
 * place, and its countdown starts again when it gets the focus back.)
 * @param {nsIFile} aFile - The downloaded copy.
 * @param {string} aUrl - Where it was downloaded from, for the toolbar.
 */
function viewDependencyFile(aFile, aUrl) {
  let browserWindow = GM_util.getBrowserWindow();
  if (!browserWindow) {
    return undefined;
  }
  GM_openSourceViewer(browserWindow.gBrowser, {
    "path": aFile.path,
    "url": aUrl,
  });
  browserWindow.focus();
}

function onFocus(aEvent) {
  if ((aEvent.target == window) && !gInstallQueued) {
    startTimer();
  }
}

function onInterval() {
  gCurrentDelay--;
  if (gCurrentDelay <= 0) {
    stopTimer();
  }
  updateLabel();
}

function onOk() {
  // Stops multiple pressing of the button.
  gAcceptButton.disabled = true;
  if (!gRemoteScript.done) {
    // Click-ahead: keep the window open and install from onProgress.
    gInstallQueued = true;
    updateLabel();
    return false;
  }
  installAndClose();
  return true;
}

function installAndClose() {
  // Closing runs cleanup(), whose last progress event must not install
  // a second time.
  gInstallQueued = false;
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
      gInstallQueued = false;
      gShowScriptButton.disabled = true;
      document.getElementById("dialog-content-box").style.display = "none";
      document.getElementById("error-content-box").style.display = "-moz-box";
      document.getElementById("error-message")
          .textContent = gRemoteScript.errorMessage;
      stopTimer();
      updateLabel(false);
      return undefined;
    }
    if (gInstallQueued) {
      installAndClose();
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

/**
 * After an unencrypted (http: or ftp:) URL, an amber "not encrypted" chip:
 * anyone on the network could change what it serves.  aRefused: the
 * download will be refused for it (requireSecureDependencies).
 *
 * @returns {boolean} Whether aUrl is unencrypted.
 */
function appendInsecureChip(aParent, aUrl, aRefused) {
  let uri = GM_util.getUriFromUrl(aUrl);
  if (!uri || ((uri.scheme != "http") && (uri.scheme != "ftp"))) {
    return false;
  }
  let chip = document.createElementNS(HTML_NS, "span");
  chip.className = "insecure-chip";
  chip.appendChild(document.createTextNode(aRefused
      ? installString("install.insecure.refused",
          "not encrypted: will be refused")
      : installString("install.insecure", "not encrypted")));
  aParent.appendChild(chip);
  return true;
}

/** The line a tooltip gets for an unencrypted URL. */
function insecureTooltip() {
  return installString("install.insecure.tooltip",
      "Sent unencrypted, so anyone on the network could change it.");
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
  source.setAttribute("tooltiptext", aUrl
      + (appendInsecureChip(source, aUrl, false)
          ? "\n" + insecureTooltip() : ""));
}

/**
 * Shows the script's @icon beside its name: a data: one at once, a
 * downloaded one when it's in (onDependency).  One that fails to load
 * stays hidden.
 */
function setUpIcon() {
  let image = document.getElementById("script-icon");
  image.addEventListener("error", function () {
    image.hidden = true;
  }, false);
  // A data: @icon isn't downloaded; nor is it in fileURL until installed.
  if (gScript.icon._dataURI) {
    showIcon(gScript.icon._dataURI);
  }
}

function showIcon(aUrl) {
  let image = document.getElementById("script-icon");
  image.setAttribute("src", aUrl);
  image.hidden = false;
}

/**
 * Lists @require or @resource dependencies in the section "<aName>" (with
 * "<aName>-label" and "<aName>-list"), one line each: the resource's name
 * (aNamed), the URL with its host in bold and a chip if it's unencrypted,
 * then its download state (see onDependency).  The tooltip has the whole
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
  let refuseInsecure = new GM_PrefManager()
      .getValue("requireSecureDependencies", false);
  let list = document.getElementById(aName + "-list");
  for (let i = 0, iLen = aDependencies.length; i < iLen; i++) {
    let dependency = aDependencies[i];
    let line = document.createElement("description");
    line.className = "dependency";
    if (aNamed) {
      line.appendChild(document.createTextNode(dependency.name + ": "));
    }
    let host = appendUrl(line, dependency.downloadURL);
    if (host && (hosts.indexOf(host) == -1)) {
      hosts.push(host);
    }
    let insecure = appendInsecureChip(
        line, dependency.downloadURL, refuseInsecure);
    let integrity = dependency._integrity;
    let tooltip = dependency.downloadURL
        + (insecure ? "\n" + insecureTooltip() : "")
        + (integrity
            ? "\n" + installString("install.integrity.pinned",
                "Checked against its pinned %1 hash.")
                .replace("%1", integrity.algo)
            : "");
    line.setAttribute("tooltiptext", tooltip);
    let status = document.createElementNS(HTML_NS, "span");
    status.className = "dependency-status";
    line.appendChild(status);
    list.appendChild(line);
    gDependencyLines.set(dependency, {
      "code": !aNamed,
      "line": line,
      "status": status,
      "tooltip": tooltip,
    });
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

// (Re)starts the countdown from the top.  With installDelay 0 there is
// nothing to count.
function startTimer() {
  stopTimer();
  gCurrentDelay = gTotalDelay;
  updateLabel();

  if (gCurrentDelay > 0) {
    gTimer = window.setInterval(onInterval, TIMER_TICK_MS);
  }
}

function stopTimer() {
  if (gTimer) {
    window.clearInterval(gTimer);
    gTimer = null;
  }
  gCurrentDelay = 0;
}

function updateLabel(aOkAllowed) {
  if (typeof aOkAllowed == "undefined") {
    aOkAllowed = true;
  }

  if (gInstallQueued) {
    gAcceptButton.label = installString("install.installing", "Installing…");
  } else if (gCurrentDelay > 0) {
    gAcceptButton.focus();
    gAcceptButton.label = gAcceptButton.baseLabel + " (" + gCurrentDelay + ")";
  } else {
    gAcceptButton.label = gAcceptButton.baseLabel;
  }

  /*
  Part 1/3 (remoteScript.js - Part 2/3 and 3/3).
  Installing before the downloads are done throws errors such as:
    NS_ERROR_FILE_IS_LOCKED: Component returned failure code:
      0x8052000e (NS_ERROR_FILE_IS_LOCKED) [nsIFile.moveTo]
      remoteScript.js:394:0
    NS_ERROR_FILE_NOT_FOUND: Component returned failure code:
      0x80520012 (NS_ERROR_FILE_NOT_FOUND) [nsIFile.lastModifiedTime]
      script.js:474:0
    TypeError: this._tempDir is null
      remoteScript.js:394:4
  So the button unlocks with the countdown, but an early click only queues
  the install (onOk); onProgress runs it once gRemoteScript.done.
  */
  let disabled = aOkAllowed
      ? ((gCurrentDelay > 0) || gInstallQueued)
      : true;
  gAcceptButton.disabled = disabled;
}

// See: closeWindow.xul.
function GM_onClose() {
  gRemoteScript.cleanup();
}
