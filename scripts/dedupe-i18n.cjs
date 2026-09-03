#!/usr/bin/env node
/* Dedupe each locale file: for each duplicate top-level key, keep ONLY the last
 * occurrence (which is what JS object-literal semantics already use in production).
 *
 * Why last-wins? Because that's the current runtime behavior. Removing earlier
 * duplicates eliminates TS1117 errors without changing ANY production behavior.
 *
 * The script preserves all comments and whitespace EXCEPT for the lines belonging
 * to the deleted duplicate entry. Section-header comments above a deleted entry
 * are kept if they don't directly belong to the entry.
 */
const fs = require('fs');
const path = require('path');

const LOCALE_DIR = '/home/z/my-project/apps/web/src/i18n';
const LOCALES = ['en', 'ar', 'fr'];

function findDuplicateKeys(src) {
  const lines = src.split('\n');
  const KEY_RE = /^(\s*)([A-Za-z0-9_]+)\s*:\s*(['"`])/;
  const QKEY_RE = /^(\s*)(['"`])([A-Za-z0-9_]+)\2\s*:\s*(['"`])/;
  const seen = new Map(); // key -> [{line, isQuoted}]
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    if (trimmed === '};' || trimmed === '}') continue;
    let m = KEY_RE.exec(line);
    if (m) {
      const key = m[2];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ line: i });
      continue;
    }
    m = QKEY_RE.exec(line);
    if (m) {
      const key = m[3];
      if (!seen.has(key)) seen.set(key, []);
      seen.get(key).push({ line: i });
    }
  }
  const dupes = [];
  for (const [key, occs] of seen) {
    if (occs.length > 1) {
      // Keep the LAST occurrence, mark earlier ones for deletion
      for (let i = 0; i < occs.length - 1; i++) dupes.push(occs[i].line);
    }
  }
  return new Set(dupes);
}

let totalRemoved = 0;
for (const loc of LOCALES) {
  const file = path.join(LOCALE_DIR, `${loc}.ts`);
  const src = fs.readFileSync(file, 'utf8');
  const linesToDelete = findDuplicateKeys(src);
  if (linesToDelete.size === 0) {
    console.log(`${loc}.ts: no duplicates`);
    continue;
  }
  const lines = src.split('\n');
  // For each line marked for deletion, also delete trailing blank lines immediately after
  // (to avoid leaving double-blank gaps). Don't delete section comments above.
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (linesToDelete.has(i)) {
      // Skip this line. Also skip one immediately-following blank line if present
      // (to avoid leaving an orphan blank where the entry used to be).
      if (i + 1 < lines.length && lines[i + 1].trim() === '' && !linesToDelete.has(i + 1)) {
        // Skip the blank line too — but only if the NEXT non-blank line is also a key or section header
        // (otherwise we might collapse intended spacing).
        // Simple rule: only skip the blank if the line after the blank is also a key/comment/closing brace.
        const nextNonBlank = lines[i + 2] || '';
        if (/^\s*(\/\/|[A-Za-z0-9_"'`]+\s*:|}|];|\*\s)/.test(nextNonBlank) || nextNonBlank.trim() === '};') {
          i++; // skip blank line
        }
      }
      continue;
    }
    out.push(lines[i]);
  }
  const newSrc = out.join('\n');
  fs.writeFileSync(file, newSrc);
  console.log(`${loc}.ts: removed ${linesToDelete.size} duplicate entries (kept last occurrence of each)`);
  totalRemoved += linesToDelete.size;
}
console.log(`\nTotal duplicate entries removed: ${totalRemoved}`);
