/**
 * @file parseScript.js
 * @overview Parses the source code of a userscript and produces a Script object.
 *
 * The parser reads the ==UserScript== metadata block (extracted by
 * extractMeta.js) and maps each @keyword to the appropriate Script property.
 * Unknown keywords (e.g. @supportURL, @antifeature) fall through
 * the switch statement silently — they do not cause a parse failure.
 *
 * Supported metadata keywords:
 *   @author, @copyright              — stored verbatim
 *   @name, @description              — stored with optional locale suffix
 *   @namespace, @version             — stored verbatim
 *   @noframes                        — boolean flag
 *   @include, @exclude               — glob patterns
 *   @match                           — strict URL match patterns (MatchPattern)
 *   @grant                           — API grants (GM_* or GM.*)
 *   @icon                            — script icon URL
 *   @require                         — additional JS files to load before script
 *   @resource                        — named binary resources
 *   @run-at                          — document-start | document-body | document-end | document-idle
 *   @downloadURL, @updateURL,
 *   @homepageURL, @installURL        — various URL metadata
 *   @homepage, @website, @source     — aliases for @homepageURL (VM-compat)
 *
 * Security note on @require / @resource:
 *   When a script is loaded from a local file://, dependency URLs must be
 *   descendants of the script's directory (enforced by checkUrls()).
 *   This can be relaxed via the fileDependencyUrlIsDescendantOfDownloadUrl pref.
 *
 * @exports parse
 */

const EXPORTED_SYMBOLS = ["parse"];

if (typeof Cc === "undefined") {
  var Cc = Components.classes;
}
if (typeof Ci === "undefined") {
  var Ci = Components.interfaces;
}
if (typeof Cu === "undefined") {
  var Cu = Components.utils;
}

Cu.import("chrome://greasemonkey-modules/content/constants.js");

Cu.import("resource://gre/modules/osfile.jsm");

Cu.import("chrome://greasemonkey-modules/content/extractMeta.js");
Cu.import("chrome://greasemonkey-modules/content/prefManager.js");
Cu.import("chrome://greasemonkey-modules/content/script.js");
Cu.import("chrome://greasemonkey-modules/content/scriptIcon.js");
Cu.import("chrome://greasemonkey-modules/content/scriptRequire.js");
Cu.import("chrome://greasemonkey-modules/content/scriptResource.js");
Cu.import("chrome://greasemonkey-modules/content/thirdParty/matchPattern.js");
Cu.import("chrome://greasemonkey-modules/content/util.js");


const META_SEPARATOR = "\0";

const SOMETHING_REGEXP = new RegExp(".+", "g");

/**
 * Parses Subresource-Integrity-style hashes from a parsed dependency URI's
 * fragment, e.g. "...lib.js#sha256=<hex>" or "#sha256=<hex>,sha512=<hex>"
 * (the Tampermonkey @require / @resource convention).  Returns the
 * strongest recognized {algo, hex} pair, or null when no usable hash is
 * present.  Hex digests only (the common UXP-era form); base64 SRI values
 * are not parsed.
 *
 * @param {nsIURI} aUri - Parsed dependency URI.
 * @returns {{algo: string, hex: string}|null}
 */
function integrityFromUri(aUri) {
  let ref = "";
  try {
    ref = (aUri && aUri.ref) ? String(aUri.ref) : "";
  } catch (e) {
    ref = "";
  }
  if (!ref) {
    return null;
  }
  let rank = { "sha256": 1, "sha384": 2, "sha512": 3 };
  let best = null;
  let parts = ref.split(/[,;]/);
  for (let i = 0; i < parts.length; i++) {
    let m = (/^\s*(sha256|sha384|sha512)[=:\-]([0-9a-fA-F]{32,})\s*$/)
        .exec(parts[i]);
    if (!m) {
      continue;
    }
    let algo = m[1].toLowerCase();
    if (!best || (rank[algo] > rank[best.algo])) {
      best = { "algo": algo, "hex": m[2].toLowerCase() };
    }
  }
  return best;
}

/**
 * Parses the source of a userscript and produces a populated Script object.
 *
 * If no ==UserScript== block is found and aFailWhenMissing is true, returns
 * null.  If aFailWhenMissing is false (the default), a Script with default
 * values is returned so that the script can still run (no metadata = match all).
 *
 * @param {string}     aSource          - Full source text of the script.
 * @param {nsIURI|null} aUri            - The URI the script was fetched from,
 *   used to resolve relative @require / @resource / URL metadata.
 *   May be null for inline/local scripts.
 * @param {boolean}    [aFailWhenMissing=false] - If true, return null when
 *   no metadata block is present.
 * @returns {Script|null} Populated Script object, or null if aFailWhenMissing
 *   is true and no metadata block was found.
 */
function parse(aSource, aUri, aFailWhenMissing) {
  var meta = extractMeta(aSource).match(SOMETHING_REGEXP);
  if (aFailWhenMissing && !meta) {
    return null;
  }

  var script = new Script();

  var scriptName = null;
  if (aUri && aUri.host && aUri.spec) {
    scriptName = aUri.spec;
    scriptName = scriptName.substring(
        0, scriptName.indexOf(GM_CONSTANTS.fileScriptExtension));
    scriptName = scriptName.substring(scriptName.lastIndexOf("/") + 1);
    script["_" + "name"] = scriptName;
    script["_" + "namespace"] = aUri.host;
    script["downloadURL"] = aUri.spec;
  }

  if (!meta) {
    setDefaults(script);
    return script;
  }

  var resourceNames = {};
  let _re = new RegExp("\\s+$", "");
  for (let i = 0, metaLine = ""; metaLine = meta[i]; i++) {
    var data;
    try {
      data = GM_util.parseMetaLine(metaLine.replace(_re, ""));
    } catch (e) {
      // Ignore invalid/unsupported meta lines.
      continue;
    }

    switch (data.keyword) {
      case "author":
      case "copyright":
        script[data.keyword] = data.value;
        break;

      case "description":
      case "name":
        let locale = data.locale;

        if (locale) {
          if (!script._locales[locale]) {
            script._locales[locale] = {};
          }
          script._locales[locale][data.keyword] = data.value;
        } else {
          if ((data.keyword == "description")
              && (script["_" + data.keyword] == "")) {
            script["_" + data.keyword] = data.value;
          }
          if ((data.keyword == "name")
            && ((script["_" + data.keyword] == GM_CONSTANTS.scriptType)
            || (script["_" + data.keyword] == scriptName))) {
            script["_" + data.keyword] = data.value;
          }
        }
        break;

      case "namespace":
      case "version":
        script["_" + data.keyword] = data.value;
        break;

      case "noframes":
      case "topLevelAwait":
      case "unwrap":
        // Boolean metadata flags: presence means true.  @unwrap is the
        // legacy GM 1.x directive that suppresses the IIFE wrapper
        // when injecting a script in page mode; consumed by
        // modules/scriptInjector.js::injectScriptIntoPage.
        script["_" + data.keyword] = true;
        break;

      case "exclude":
        script["_excludes"].push(data.value);
        break;

      case "connect":
        script["_connects"].push(data.value);
        break;
      case "exclude-match":
        try {
          let excludeMatch = new MatchPattern(data.value);
          script._excludeMatches.push(excludeMatch);
        } catch (e) {
          script.parseErrors.push(
              GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("error.parse.ignoringMatch")
                  .replace("%1", data.value).replace("%2", e)
              );
        }
        break;
      case "grant":
        script["_grants"].push(data.value);
        break;
      case "inject-into":
        script["_injectInto"] = data.value;
        break;

      case "icon":
        try {
          script[data.keyword].setMetaVal(data.value);
          script["_rawMeta"] += data.keyword + META_SEPARATOR
              + data.value + META_SEPARATOR;
        } catch (e) {
          script.parseErrors.push(e.message);
        }
        break;

      case "icon64":
        // @icon64 (Tampermonkey) is a high-DPI icon URL.  The fork keeps a
        // single icon slot, so @icon64 is used only as a fallback when no
        // @icon was supplied; an explicit @icon always wins (its case sets
        // the icon unconditionally, so order in the metadata doesn't matter).
        try {
          if (!script.icon._downloadURL && !script.icon._dataURI) {
            script.icon.setMetaVal(data.value);
          }
          script["_rawMeta"] += data.keyword + META_SEPARATOR
              + data.value + META_SEPARATOR;
        } catch (e) {
          script.parseErrors.push(e.message);
        }
        break;

      case "include":
        script["_includes"].push(data.value);
        break;

      case "homepage":
      case "website":
      case "source":
        // Aliases for @homepageURL (Violentmonkey / GreasyFork / generic
        // metadata convention).  Rewrite the keyword and fall through to
        // the shared URL-parsing block below.
        data.keyword = "homepageURL";
        // fallthrough
      case "installURL":
        // Rewrite @installURL → @downloadURL and fall through to the
        // shared URL-parsing block.  Without this `break`-less case
        // we'd duplicate the entire downloadURL/updateURL/homepageURL
        // handler.  DO NOT add a `break` here.
        if (data.keyword == "installURL") data.keyword = "downloadURL";
        // fallthrough
      case "downloadURL":
      case "homepageURL":
      case "updateURL":
        // GreasyFork sets @downloadURL/@updateURL to "none" to disable
        // auto-updates for old script versions. Treat it as unset rather
        // than resolving "none" as a relative URL against the base URI.
        if (data.value.trim().toLowerCase() === "none") {
          break;
        }
        try {
          let uri = GM_util.getUriFromUrl(data.value, aUri);
          script[data.keyword] = uri.spec;
        } catch (e) {
          // Otherwise this call would be twice.
          if (!aFailWhenMissing) {
            GM_util.logError(
                "ParseScript" + " - "
                + GM_CONSTANTS.localeStringBundle.createBundle(
                    GM_CONSTANTS.localeGreasemonkeyProperties)
                    .GetStringFromName("error.parse.failed") + ":"
                + "\n" + data.keyword + ' = "' + data.value + '"'
                + "\n" + e, false,
                (aUri && aUri.spec) ? aUri.spec : e.fileName,
                (aUri && aUri.spec) ? null : e.lineNumber);
          }
        }
        break;

      case "match":
        let match;
        try {
          match = new MatchPattern(data.value);
          script._matches.push(match);
        } catch (e) {
          script.parseErrors.push(
              GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("error.parse.ignoringMatch")
                  .replace("%1", data.value).replace("%2", e)
              );
        }
        break;

      case "require":
        try {
          let reqUri = GM_util.getUriFromUrl(data.value, aUri);
          if (aUri && aUri.spec && reqUri && reqUri.spec
              && !checkUrls(aUri, reqUri)) {
            throw GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName(
                    "error.parse.fileDependencyUrlIsDescendantOfDownloadUrl")
                .replace("%1", reqUri.spec)
                .replace("%2", aUri.spec);
          }
          let scriptRequire = new ScriptRequire(script);
          if (!reqUri || !reqUri.spec) {
            throw "";
          }
          scriptRequire._downloadURL = reqUri.spec;
          scriptRequire._integrity = integrityFromUri(reqUri);
          script["_requires"].push(scriptRequire);
          script["_rawMeta"] += data.keyword + META_SEPARATOR
              + data.value + META_SEPARATOR;
        } catch (e) {
          // Otherwise this call would be twice.
          if (!aFailWhenMissing) {
            GM_util.logError(
                "ParseScript" + " - "
                + GM_CONSTANTS.localeStringBundle.createBundle(
                    GM_CONSTANTS.localeGreasemonkeyProperties)
                    .GetStringFromName("error.parse.failed") + ":"
                + "\n" + data.keyword + ' = "' + data.value + '"'
                + "\n" + e, false,
                (aUri && aUri.spec) ? aUri.spec : e.fileName,
                (aUri && aUri.spec) ? null : e.lineNumber);
          }
          script.parseErrors.push(
              GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("error.parse.requireFailed")
                  .replace("%1", data.value)
              );
        }
        break;

      case "resource":
        let name = data.value1;
        let url = data.value2;

        if (name in resourceNames) {
          script.parseErrors.push(
              GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("error.parse.resourceDuplicate")
                  .replace("%1", name));
          break;
        }
        resourceNames[name] = true;

        try {
          let resUri = GM_util.getUriFromUrl(url, aUri);
          if (aUri && aUri.spec && resUri && resUri.spec
              && !checkUrls(aUri, resUri)) {
            throw GM_CONSTANTS.localeStringBundle.createBundle(
                GM_CONSTANTS.localeGreasemonkeyProperties)
                .GetStringFromName(
                    "error.parse.fileDependencyUrlIsDescendantOfDownloadUrl")
                .replace("%1", resUri.spec)
                .replace("%2", aUri.spec);
          }
          let scriptResource = new ScriptResource(script);
          scriptResource._name = name;
          if (!resUri || !resUri.spec) {
            throw "";
          }
          scriptResource._downloadURL = resUri.spec;
          scriptResource._integrity = integrityFromUri(resUri);
          script["_resources"].push(scriptResource);
          script["_rawMeta"] += data.keyword + META_SEPARATOR
              + name + META_SEPARATOR + resUri.spec + META_SEPARATOR;
        } catch (e) {
          // Otherwise this call would be twice.
          if (!aFailWhenMissing) {
            GM_util.logError(
                "ParseScript" + " - "
                + GM_CONSTANTS.localeStringBundle.createBundle(
                    GM_CONSTANTS.localeGreasemonkeyProperties)
                    .GetStringFromName("error.parse.failed") + ":"
                + "\n" + data.keyword + ' = "' + name + " " + url + '"'
                + "\n" + e, false,
                (aUri && aUri.spec) ? aUri.spec : e.fileName,
                (aUri && aUri.spec) ? null : e.lineNumber);
          }
          script.parseErrors.push(
              GM_CONSTANTS.localeStringBundle.createBundle(
                  GM_CONSTANTS.localeGreasemonkeyProperties)
                  .GetStringFromName("error.parse.resourceFailed")
                  .replace("%1", name).replace("%2", url)
              );
        }

        break;

      case "run-at":
        script["_runAt"] = data.value;
        break;
      case "supportURL":
        script["_supportURL"] = data.value;
        break;
      case "antifeature":
        script["_antifeatures"].push(data.value);
        break;

    }
  }

  // Homepage fallback chain — mirrors Violentmonkey's getScriptHome() +
  // inferScriptHome() behavior so scripts without an explicit @homepageURL
  // (e.g. gists) still surface a clickable homepage link in the Add-ons
  // Manager.  Order of precedence:
  //   1. @homepageURL / @homepage / @website / @source (populated above)
  //   2. URL-shaped @namespace (skip the tampermonkey.net sentinel)
  //   3. Host-rewritten install URL (github, gist, greasyfork, openuserjs)
  //   4. The install URL itself
  if (!script.homepageURL) {
    let candidate = null;
    let ns = script.namespace;
    if (ns && /^https?:\/\//i.test(ns)
        && !/^https?:\/\/tampermonkey\.net\b/i.test(ns)) {
      candidate = ns;
    } else if (aUri && aUri.spec) {
      candidate = inferHomepageFromInstallUrl(aUri.spec);
    }
    if (candidate) {
      try {
        let uri = GM_util.getUriFromUrl(candidate, aUri);
        script.homepageURL = uri.spec;
      } catch (e) {
        // Derived candidate wasn't parseable as a URI — leave homepageURL
        // empty rather than storing a malformed value.
      }
    }
  }

  setDefaults(script);
  return script;
}

/**
 * Derives a human-viewable homepage from the URL a script was installed from.
 * Mirrors Violentmonkey's inferScriptHome() host-rewriting logic so that
 * scripts installed from raw file hosts still show a sensible homepage link.
 *
 *   raw.githubusercontent.com/<user>/<repo>/...   -> github.com/<user>/<repo>
 *   gist.githubusercontent.com/<user>/<id>/...    -> gist.github.com/<user>/<id>
 *   github.com/<user>/<repo>/raw/...              -> github.com/<user>/<repo>
 *   greasyfork.org/<locale>/scripts/<slug>/code/* -> .../scripts/<slug>
 *   sleazyfork.org/<locale>/scripts/<slug>/code/* -> .../scripts/<slug>
 *   openuserjs.org/install/<user>/<slug>.user.js  -> .../scripts/<user>/<slug>
 *   anything else                                 -> the install URL as-is
 *
 * @param {string} aInstallUrl - The URL the script was downloaded from.
 * @returns {string|null} A homepage URL, or null if input is falsy.
 */
function inferHomepageFromInstallUrl(aInstallUrl) {
  if (!aInstallUrl) return null;
  let m;
  // raw.githubusercontent.com/<user>/<repo>/<branch>/...
  m = aInstallUrl.match(
      /^https?:\/\/raw\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\//i);
  if (m) return "https://github.com/" + m[1] + "/" + m[2];
  // gist.githubusercontent.com/<user>/<id>/raw/...
  m = aInstallUrl.match(
      /^https?:\/\/gist\.githubusercontent\.com\/([^\/]+)\/([^\/]+)\//i);
  if (m) return "https://gist.github.com/" + m[1] + "/" + m[2];
  // gist.github.com/<user>/<id>/raw/<sha>/<filename> — the other raw URL
  // format gists expose (via the "Raw" button on the gist page itself).
  // Strip the /raw/ suffix so the homepage points at the human-readable
  // gist page rather than the .user.js download itself.
  m = aInstallUrl.match(
      /^(https?:\/\/gist\.github\.com\/[^\/]+\/[^\/]+)\/raw(?:\/|$)/i);
  if (m) return m[1];
  // github.com/<user>/<repo>/raw/<branch>/...
  m = aInstallUrl.match(
      /^(https?:\/\/github\.com\/[^\/]+\/[^\/]+)\/raw\//i);
  if (m) return m[1];
  // update.greasyfork.org / update.sleazyfork.org /scripts/<id>/<file>.user.js
  //   This is the host that GreasyFork puts in @updateURL / @downloadURL,
  //   so it's what we see for scripts whose update URL was followed (the
  //   user-visible install button uses /code/<filename>, but the metadata
  //   directives commonly point at the update host).  Strip the "update."
  //   prefix and rewrite to the human-readable script page.
  m = aInstallUrl.match(
      /^https?:\/\/update\.(greasy|sleazy)fork\.org\/scripts\/([^\/]+)/i);
  if (m) return "https://" + m[1] + "fork.org/scripts/" + m[2];
  // greasyfork.org / sleazyfork.org [/<locale>] /scripts/<slug>[/...]
  //   Catches both the locale-prefixed install URL (en, fr, zh-CN, etc.)
  //   and the bare form.  Drops everything after /scripts/<slug> so the
  //   homepage points at the script's overview page rather than the
  //   /code/<filename> raw-source endpoint.
  m = aInstallUrl.match(
      /^https?:\/\/(greasy|sleazy)fork\.org\/(?:[^\/]+\/)?scripts\/([^\/]+)/i);
  if (m) return "https://" + m[1] + "fork.org/scripts/" + m[2];
  // openuserjs.org/install/<user>/<slug>.user.js
  m = aInstallUrl.match(
      /^https?:\/\/openuserjs\.org\/install\/([^\/]+)\/(.+?)\.user\.js$/i);
  if (m) return "https://openuserjs.org/scripts/" + m[1] + "/" + m[2];
  // Fallback: the install URL itself.
  return aInstallUrl;
}

/**
 * Applies default values to a partially-parsed Script object:
 *   - If no @updateURL was set, falls back to @downloadURL.
 *   - If @run-at is missing or invalid, defaults to "document-end".
 *   - If no @include and no @match patterns were set, adds "*" (match all).
 *
 * @param {Script} aScript - The Script object to fill in defaults for.
 */
function setDefaults(aScript) {
  if (!aScript.updateURL && aScript.downloadURL) {
    aScript.updateURL = aScript.downloadURL;
  }
  // In case of a search and replace:
  // document-body, document-end, document-idle, document-start
  if (!aScript._runAt || !aScript._runAt.match(
      new RegExp("^document-(body|end|idle|start)$", ""))) {
    aScript._runAt = "document-end";
  }
  if ((aScript._includes.length == 0) && (aScript._matches.length == 0)) {
    aScript._includes.push(GM_CONSTANTS.script.includeAll);
  }
}

/**
 * Validates that a dependency URL is safe relative to the script's source URL.
 *
 * When the "fileDependencyUrlIsDescendantOfDownloadUrl" preference is enabled
 * and both URLs are file://, checks that the dependency file is inside the
 * directory of the script file.  This prevents scripts from @require-ing
 * arbitrary files from the filesystem.
 *
 * For non-file:// URLs (http, https, etc.) the check always passes.
 *
 * @param {nsIURI} aUri    - The script's source URI.
 * @param {nsIURI} aDepUri - The dependency's URI to validate.
 * @returns {boolean} True if the dependency is allowed, false if it should
 *   be rejected.
 */
function checkUrls(aUri, aDepUri) {
  let check = GM_prefRoot.getValue(
      "fileDependencyUrlIsDescendantOfDownloadUrl");
  if (check) {
    let scheme1 = GM_CONSTANTS.ioService.extractScheme(aUri.spec);
    let scheme2 = GM_CONSTANTS.ioService.extractScheme(aDepUri.spec);
    if ((scheme1 == "file") && (scheme2 == "file")) {
      let file1 = Cc["@mozilla.org/file/local;1"]
          .createInstance(Ci.nsILocalFile);
      let file2 = Cc["@mozilla.org/file/local;1"]
          .createInstance(Ci.nsILocalFile);

      file1.initWithPath(OS.Path.dirname(OS.Path.fromFileURI(aUri.spec)));
      file2.initWithPath(OS.Path.fromFileURI(aDepUri.spec));

      return file1.contains(file2);
    }
  }

  return true;
}
