#!/usr/bin/env node
/* Deep scan apps/web/src for i18n missing keys.
 * Reports:
 *   1) Keys used in code via t('...') / t("...") / t(`...`) but missing from any locale file
 *   2) Keys present in en.ts but missing from ar.ts or fr.ts (and vice versa)
 *   3) Top-level locale keys defined but never used in code (low priority)
 */
const fs = require('fs');
const path = require('path');

const WEB_SRC = '/home/z/my-project/apps/web/src';
const LOCALE_DIR = '/home/z/my-project/apps/web/src/i18n';
const LOCALES = ['en', 'ar', 'fr'];

// --- 1. Walk source files -------------------------------------------------
function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// --- 2. Extract t('key'), t("key"), t(`key`) calls -----------------------
const T_LITERAL = /\bt\(\s*(['"`])([A-Za-z0-9_][A-Za-z0-9_.\-]*?)\1/g;

const usedKeys = new Map(); // key -> [{file, line}]
const files = walk(WEB_SRC);

for (const file of files) {
  if (file.includes('/i18n/')) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m;
    T_LITERAL.lastIndex = 0;
    while ((m = T_LITERAL.exec(line)) !== null) {
      const key = m[2];
      if (!key) continue;
      if (!usedKeys.has(key)) usedKeys.set(key, []);
      usedKeys.get(key).push({ file: path.relative(WEB_SRC, file), line: i + 1 });
    }
  }
  const T_MULTI = /\bt\(\s*`([A-Za-z0-9_][A-Za-z0-9_.\-]*)`\s*[,)]/g;
  let mm;
  while ((mm = T_MULTI.exec(src)) !== null) {
    const key = mm[1];
    if (!key) continue;
    const lineNum = src.slice(0, mm.index).split('\n').length;
    if (!usedKeys.has(key)) usedKeys.set(key, []);
    const existing = usedKeys.get(key);
    if (!existing.some(e => e.file === path.relative(WEB_SRC, file) && e.line === lineNum)) {
      existing.push({ file: path.relative(WEB_SRC, file), line: lineNum });
    }
  }
}

// --- 3. Extract top-level keys from each locale file ---------------------
function extractLocaleKeys(localeFile) {
  const src = fs.readFileSync(localeFile, 'utf8');
  const keys = new Set();
  // Allow leading whitespace (locale files indent keys by 2 spaces)
  const KEY_RE = /^\s*([A-Za-z0-9_]+)\s*:\s*['"`]/gm;
  const QKEY_RE = /^\s*['"`]([A-Za-z0-9_]+)['"`]\s*:\s*['"`]/gm;
  let m;
  while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  while ((m = QKEY_RE.exec(src)) !== null) keys.add(m[1]);
  return keys;
}

const localeKeys = {};
for (const loc of LOCALES) {
  localeKeys[loc] = extractLocaleKeys(path.join(LOCALE_DIR, `${loc}.ts`));
}

// --- 4. Cross-reference --------------------------------------------------
const allLocaleKeys = new Set();
for (const loc of LOCALES) for (const k of localeKeys[loc]) allLocaleKeys.add(k);

const usedKeyArr = [...usedKeys.keys()].sort();

const missingPerLocale = {};
for (const loc of LOCALES) {
  missingPerLocale[loc] = usedKeyArr.filter(k => !localeKeys[loc].has(k));
}
const missingFromAll = usedKeyArr.filter(k => !allLocaleKeys.has(k));

const enNotInAr = [...localeKeys.en].filter(k => !localeKeys.ar.has(k)).sort();
const enNotInFr = [...localeKeys.en].filter(k => !localeKeys.fr.has(k)).sort();
const arNotInEn = [...localeKeys.ar].filter(k => !localeKeys.en.has(k)).sort();
const frNotInEn = [...localeKeys.fr].filter(k => !localeKeys.en.has(k)).sort();
const arNotInFr = [...localeKeys.ar].filter(k => !localeKeys.fr.has(k)).sort();
const frNotInAr = [...localeKeys.fr].filter(k => !localeKeys.ar.has(k)).sort();

const definedButUnused = [...allLocaleKeys].filter(k => !usedKeys.has(k)).sort();

// --- 5. Report -----------------------------------------------------------
console.log('=== i18n Deep Scan Report ===\n');
console.log(`Source files scanned: ${files.length}`);
console.log(`Unique keys used via t('...'): ${usedKeyArr.length}`);
console.log(`Top-level keys in en.ts: ${localeKeys.en.size}`);
console.log(`Top-level keys in ar.ts: ${localeKeys.ar.size}`);
console.log(`Top-level keys in fr.ts: ${localeKeys.fr.size}`);
console.log('');

console.log('--- (A) Keys used in code but missing from ALL locale files ---');
if (missingFromAll.length === 0) console.log('  (none)');
else {
  for (const k of missingFromAll) {
    const locs = usedKeys.get(k);
    console.log(`  ${k}   [used ${locs.length}x, e.g. ${locs[0].file}:${locs[0].line}]`);
  }
}
console.log('');

console.log('--- (B) Keys used in code but missing from at least one locale ---');
for (const loc of LOCALES) {
  console.log(`  Missing from ${loc}.ts (${missingPerLocale[loc].length}):`);
  if (missingPerLocale[loc].length === 0) console.log('    (none)');
  else {
    for (const k of missingPerLocale[loc]) {
      const locs = usedKeys.get(k) || [];
      const sample = locs[0] ? `  [e.g. ${locs[0].file}:${locs[0].line}]` : '';
      console.log(`    ${k}${sample}`);
    }
  }
}
console.log('');

console.log('--- (C) Locale-vs-locale mismatches (drift) ---');
console.log(`  In en.ts but NOT in ar.ts (${enNotInAr.length}):`);
for (const k of enNotInAr.slice(0, 50)) console.log(`    ${k}`);
if (enNotInAr.length > 50) console.log(`    ... +${enNotInAr.length - 50} more`);
console.log(`  In en.ts but NOT in fr.ts (${enNotInFr.length}):`);
for (const k of enNotInFr.slice(0, 50)) console.log(`    ${k}`);
if (enNotInFr.length > 50) console.log(`    ... +${enNotInFr.length - 50} more`);
console.log(`  In ar.ts but NOT in en.ts (${arNotInEn.length}):`);
for (const k of arNotInEn.slice(0, 50)) console.log(`    ${k}`);
if (arNotInEn.length > 50) console.log(`    ... +${arNotInEn.length - 50} more`);
console.log(`  In fr.ts but NOT in en.ts (${frNotInEn.length}):`);
for (const k of frNotInEn.slice(0, 50)) console.log(`    ${k}`);
if (frNotInEn.length > 50) console.log(`    ... +${frNotInEn.length - 50} more`);
console.log(`  In ar.ts but NOT in fr.ts (${arNotInFr.length}):`);
for (const k of arNotInFr.slice(0, 50)) console.log(`    ${k}`);
console.log(`  In fr.ts but NOT in ar.ts (${frNotInAr.length}):`);
for (const k of frNotInAr.slice(0, 50)) console.log(`    ${k}`);
console.log('');

console.log(`--- (D) Defined-but-unused locale keys: ${definedButUnused.length} (informational, first 30) ---`);
for (const k of definedButUnused.slice(0, 30)) console.log(`  ${k}`);
if (definedButUnused.length > 30) console.log(`  ... +${definedButUnused.length - 30} more`);

// --- 6. Write machine-readable JSON for follow-up patching ---------------
const report = {
  scannedFiles: files.length,
  usedKeyCount: usedKeyArr.length,
  localeKeyCounts: { en: localeKeys.en.size, ar: localeKeys.ar.size, fr: localeKeys.fr.size },
  missingFromAll,
  missingPerLocale,
  drift: { enNotInAr, enNotInFr, arNotInEn, frNotInEn, arNotInFr, frNotInAr },
  definedButUnused,
  usedKeyLocations: Object.fromEntries(usedKeys),
};
fs.writeFileSync('/home/z/my-project/i18n-report.json', JSON.stringify(report, null, 2));
console.log('\nFull report written to /home/z/my-project/i18n-report.json');
