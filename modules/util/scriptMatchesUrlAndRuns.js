/**
 * @file scriptMatchesUrlAndRuns.js
 * @overview Tests whether a given script should execute on a URL at a
 * particular run-at phase.
 */

const EXPORTED_SYMBOLS = ["scriptMatchesUrlAndRuns"];


/**
 * Tests whether a script should be injected for a given URL and run-at timing.
 * @param {object} aScript - The script object to evaluate.
 * @param {string} aUrl - The page URL to match against.
 * @param {string} aWhen - The current run-at phase (e.g. "document-start"); "any" matches all phases.
 * @returns {boolean} True if the script is enabled, not pending, matches the URL, and runs at the given phase.
 */
function scriptMatchesUrlAndRuns(aScript, aUrl, aWhen) {
  return !aScript.pendingExec.length
      && aScript.enabled
      && !aScript.needsUninstall
      && ((aWhen == aScript.runAt) || (aWhen == "any"))
      && aScript.matchesURL(aUrl);
}
