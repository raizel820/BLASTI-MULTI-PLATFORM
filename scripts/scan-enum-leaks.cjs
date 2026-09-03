#!/usr/bin/env node
/* Find places where API response fields / enum values might be rendered
 * directly as text without going through a translation map.
 *
 * Patterns to catch:
 *   (A) {reservation.status} / {queue.state} / {user.role} / {transaction.type}
 *       — renders raw enum value (WAITING, CALLED, ACTIVE, etc.)
 *   (B) {someObj.someCamelCaseField} rendered as JSX text
 *   (C) String(enumeration) or .toString() on enum values
 *   (D) Direct rendering of string fields that come from API (name, title, type, etc.)
 */
const fs = require('fs');
const path = require('path');

const WEB_SRC = '/home/z/my-project/apps/web/src';

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

const files = walk(WEB_SRC).filter(f => !f.includes('/i18n/'));
const SKIP = [/\/hooks\//, /\/lib\//, /\/db\//, /\/store\//, /\/types\//];

// Patterns where a camelCase property access is rendered as JSX text: {obj.someField}
// We want to catch {foo.barBaz} where barBaz is a camelCase property that might hold an enum value
const JSX_EXPR_RE = /\{\s*([a-zA-Z_$][\w$]*\.([a-zA-Z_$][\w$]*))\s*\}/g;
// Also catch {foo.bar.baz} chains
const JSX_CHAIN_RE = /\{\s*([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\s*\}/g;

// Common enum field names that come from API and shouldn't be rendered raw
const ENUM_FIELDS = new Set([
  'status', 'state', 'role', 'type', 'tier', 'plan', 'category', 'level',
  'priority', 'mode', 'kind', 'action', 'reason', 'source', 'channel',
  'paymentMethod', 'paymentStatus', 'subscriptionStatus', 'queueStatus',
  'reservationStatus', 'orderStatus', 'fulfillmentStatus',
]);

const findings = [];

for (const file of files) {
  if (SKIP.some(p => p.test(file))) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = path.relative(WEB_SRC, file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('//')) continue;

    // Look for {obj.field} patterns where field is a known enum field name
    let m;
    JSX_CHAIN_RE.lastIndex = 0;
    while ((m = JSX_CHAIN_RE.exec(line)) !== null) {
      const expr = m[1];
      // Get last segment
      const parts = expr.split('.');
      const last = parts[parts.length - 1];
      // Skip if the line wraps this in t() — e.g. t(reservation.status) or t(STATUS_MAP[...].label)
      // Heuristic: if there's a t( or STATUS_MAP or LABEL_MAP or CONFIG[ on the line, skip
      if (/\bt\s*\(/.test(line) && line.includes(expr)) continue;
      if (/MAP\[|CONFIG\[|LABELS\[|STATUSES\[/.test(line)) continue;
      if (ENUM_FIELDS.has(last)) {
        findings.push({
          file: rel,
          line: i + 1,
          kind: 'raw-enum-field',
          expr,
          field: last,
          context: line.trim().slice(0, 120),
        });
      }
    }
  }
}

console.log('=== Raw enum field rendering scan ===\n');
console.log(`Findings: ${findings.length}`);

const byFile = {};
for (const f of findings) {
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
}
for (const [file, items] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n--- ${file} (${items.length}) ---`);
  const seen = new Set();
  for (const it of items) {
    const k = `${it.line}:${it.expr}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  L${it.line}  {${it.expr}}   (field: ${it.field})`);
    console.log(`    ${it.context}`);
  }
}

fs.writeFileSync('/home/z/my-project/i18n-enum-leak.json', JSON.stringify(findings, null, 2));
