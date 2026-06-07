#!/usr/bin/env node
/**
 * check-locales.js — pre-build guard for the localisation DTDs.
 *
 * Two failure classes, both of which ship a FATAL "XML Parser Error:
 * undefined entity" to non-English users if they slip through (see issue #23):
 *
 *   1. Completeness — every entity the en-US reference defines must also be
 *      defined in the same-named DTD of every other locale.  A XUL file that
 *      references an entity the active locale doesn't define aborts parsing
 *      of the whole document.
 *   2. Well-formedness — every <!ENTITY name "value"> must close its value
 *      with the same quote followed by '>' (the common slip is an unescaped
 *      " inside a "-quoted value; use &quot; instead).
 *
 * Exit 0 = clean, exit 1 = problems (printed) or the reference can't be read.
 * Pure Node, no dependencies.  Invoked by build-xpi.ps1 and build.sh; paths
 * are resolved relative to this file so the cwd doesn't matter.
 */
'use strict';
var fs = require('fs');
var path = require('path');

var LOCALE_ROOT = path.join(__dirname, '..', 'locale');
var REF = 'en-US';

function read(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
}

function entityNames(text) {
  var names = new Set();
  var re = /<!ENTITY\s+(\S+)\s+/g;
  var m;
  while ((m = re.exec(text)) !== null) names.add(m[1]);
  return names;
}

// Returns a list of human-readable descriptions of malformed declarations.
function malformed(text) {
  var bad = [];
  var re = /<!ENTITY\s+(\S+)\s+/g;
  var m;
  while ((m = re.exec(text)) !== null) {
    var q = text[re.lastIndex];
    if (q !== '"' && q !== "'") { bad.push(m[1] + ' (value not quoted)'); continue; }
    var close = text.indexOf(q, re.lastIndex + 1);
    if (close === -1) { bad.push(m[1] + ' (unterminated value)'); continue; }
    var j = close + 1;
    while (j < text.length && /\s/.test(text[j])) j++;
    if (text[j] !== '>') bad.push(m[1] + ' (embedded ' + q + ' — escape it as &quot; / &apos;)');
  }
  return bad;
}

var refDir = path.join(LOCALE_ROOT, REF);
var dtdFiles;
try {
  dtdFiles = fs.readdirSync(refDir).filter(function (f) { return f.endsWith('.dtd'); });
} catch (e) {
  console.error('check-locales: cannot read reference locale at ' + refDir + ' (' + e.message + ')');
  process.exit(1);
}

var refNames = {};
dtdFiles.forEach(function (f) { refNames[f] = entityNames(read(path.join(refDir, f)) || ''); });

var locales = fs.readdirSync(LOCALE_ROOT).filter(function (d) {
  try { return fs.statSync(path.join(LOCALE_ROOT, d)).isDirectory(); } catch (e) { return false; }
});

var problems = [];
locales.forEach(function (loc) {
  dtdFiles.forEach(function (f) {
    var rel = 'locale/' + loc + '/' + f;
    var text = read(path.join(LOCALE_ROOT, loc, f));
    if (text === null) {
      if (loc !== REF) problems.push(rel + ': file missing');
      return;
    }
    malformed(text).forEach(function (b) { problems.push(rel + ': malformed entity ' + b); });
    if (loc === REF) return;
    var have = entityNames(text);
    var miss = [];
    refNames[f].forEach(function (n) { if (!have.has(n)) miss.push(n); });
    if (miss.length) problems.push(rel + ': missing ' + miss.length + ' entity(ies): ' + miss.join(', '));
  });
});

if (problems.length) {
  console.error('check-locales: FAILED — ' + problems.length + ' problem(s):');
  problems.forEach(function (p) { console.error('  - ' + p); });
  console.error('\nDefine the missing entities (an English fallback value is fine) or fix the');
  console.error('malformed ones, then rebuild.');
  process.exit(1);
}
console.log('check-locales: OK — ' + locales.length + ' locales x ' + dtdFiles.length
  + ' DTD file(s), all complete and well-formed.');
process.exit(0);
