#!/usr/bin/env node
/* Find duplicate top-level keys in each locale file.
 * JS object literals allow duplicate keys (last wins), but TS flags them.
 * We parse each file and report duplicates with line numbers + values.
 */
const fs = require('fs');
const path = require('path');

const LOCALE_DIR = '/home/z/my-project/apps/web/src/i18n';
const LOCALES = ['en', 'ar', 'fr'];

function findDuplicateKeys(localeFile) {
  const src = fs.readFileSync(localeFile, 'utf8');
  const lines = src.split('\n');
  // Map: key -> [{line, value}]
  const seen = new Map();
  const KEY_RE = /^(\s*)([A-Za-z0-9_]+)\s*:\s*(['"`])([\s\S]*?)\3\s*,?\s*$/;
  const QKEY_RE = /^(\s*)(['"`])([A-Za-z0-9_]+)\2\s*:\s*(['"`])([\s\S]*?)\4\s*,?\s*$/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments and blank lines
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    // Skip the closing brace
    if (trimmed === '};' || trimmed === '}') continue;

    let m = KEY_RE.exec(line);
    if (m) {
      const key = m[2];
      const value = m[4];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ line: i + 1, value });
      continue;
    }
    m = QKEY_RE.exec(line);
    if (m) {
      const key = m[3];
      const value = m[5];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ line: i + 1, value });
    }
  }

  const dupes = [];
  for (const [key, occurrences] of seen) {
    if (occurrences.length > 1) dupes.push({ key, occurrences });
  }
  dupes.sort((a, b) => a.occurrences[0].line - b.occurrences[0].line);
  return dupes;
}

const allDupes = {};
for (const loc of LOCALES) {
  const file = path.join(LOCALE_DIR, `${loc}.ts`);
  allDupes[loc] = findDuplicateKeys(file);
}

console.log('=== Duplicate Key Report ===\n');
for (const loc of LOCALES) {
  const dupes = allDupes[loc];
  console.log(`--- ${loc}.ts: ${dupes.length} duplicate keys ---`);
  for (const d of dupes) {
    console.log(`  ${d.key}  (appears ${d.occurrences.length}x)`);
    for (const o of d.occurrences) {
      console.log(`    L${o.line}: ${JSON.stringify(o.value).slice(0, 80)}`);
    }
  }
  console.log('');
}

// Check if duplicates are consistent across locales (same key set in each)
const enKeys = new Set(allDupes.en.map(d => d.key));
const arKeys = new Set(allDupes.ar.map(d => d.key));
const frKeys = new Set(allDupes.fr.map(d => d.key));

const enNotAr = [...enKeys].filter(k => !arKeys.has(k));
const enNotFr = [...enKeys].filter(k => !frKeys.has(k));
const arNotEn = [...arKeys].filter(k => !enKeys.has(k));
const frNotEn = [...frKeys].filter(k => !enKeys.has(k));
console.log('--- Cross-locale duplicate-key consistency ---');
console.log(`  en dupes not in ar dupes: ${enNotAr.length}  ${enNotAr.join(', ')}`);
console.log(`  en dupes not in fr dupes: ${enNotFr.length}  ${enNotFr.join(', ')}`);
console.log(`  ar dupes not in en dupes: ${arNotEn.length}  ${arNotEn.join(', ')}`);
console.log(`  fr dupes not in en dupes: ${frNotEn.length}  ${frNotEn.join(', ')}`);

// Write JSON
fs.writeFileSync('/home/z/my-project/i18n-dupes-report.json', JSON.stringify(allDupes, null, 2));
console.log('\nFull report written to /home/z/my-project/i18n-dupes-report.json');
