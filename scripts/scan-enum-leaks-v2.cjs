#!/usr/bin/env node
/* Comprehensive scan for raw enum/identifier values rendered to users.
 * Catches: {obj.field} where field is an enum-like field name.
 * Also catches: {var} where var name suggests it holds an enum (less reliable).
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

const ENUM_FIELDS = new Set([
  'status', 'state', 'role', 'type', 'tier', 'plan', 'category', 'level',
  'priority', 'mode', 'kind', 'action', 'reason', 'source', 'channel',
  'paymentMethod', 'paymentStatus', 'paymentModel', 'subscriptionStatus',
  'subscriptionTier', 'queueStatus', 'reservationStatus', 'orderStatus',
  'fulfillmentStatus', 'connectionType', 'valueType', 'entityType',
  'commandType', 'deviceType', 'productType', 'userRole', 'staffRole',
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

    // {obj.field} or {obj.field.sub} rendered as JSX text
    const CHAIN_RE = /\{\s*([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)\s*\}/g;
    let m;
    while ((m = CHAIN_RE.exec(line)) !== null) {
      const expr = m[1];
      const parts = expr.split('.');
      const last = parts[parts.length - 1];
      if (!ENUM_FIELDS.has(last)) continue;
      // Skip if wrapped in t() or passed to a component as prop
      if (/\bt\s*\(/.test(line) && line.includes(expr)) continue;
      if (/MAP\[|CONFIG\[|LABELS\[|STATUSES\[|getActionBadgeColor|statusDotClass|statusBadgeClass|getActionDotColor|formatDate|formatTime|getAgencyName|getLocalizedPlanName|getLocalizedPlanDesc/i.test(line)) continue;
      // Skip if it's a prop assignment: prop={obj.field} — that's passing to a component, not rendering
      // Detect: if the { is preceded by = or : (prop or object value), skip
      const before = line.slice(0, m.index);
      if (/[=:]?\s*$/.test(before) && /[\w"']\s*=\s*$/.test(before)) continue;
      if (/\b(?:key|value|className|status|type|category|action|data-status|data-type|data-action|id|name)\s*=\s*$/.test(before)) continue;
      // Skip if it's inside an error/log string
      if (/throw new Error|console\.|error:\s*`|warn:\s*`/.test(line)) continue;
      findings.push({
        file: rel,
        line: i + 1,
        kind: 'raw-enum-field',
        expr,
        field: last,
        context: line.trim().slice(0, 140),
      });
    }
  }
}

// Dedupe
const seen = new Set();
const deduped = findings.filter(f => {
  const k = `${f.file}:${f.line}:${f.expr}`;
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

console.log(`=== Comprehensive enum leak scan ===\n`);
console.log(`Total findings: ${deduped.length}\n`);

const byFile = {};
for (const f of deduped) {
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
}
for (const [file, items] of Object.entries(byFile).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`--- ${file} (${items.length}) ---`);
  for (const it of items) {
    console.log(`  L${it.line}  {${it.expr}}   (field: ${it.field})`);
    console.log(`    ${it.context}`);
  }
}

fs.writeFileSync('/home/z/my-project/i18n-enum-leak-v2.json', JSON.stringify(deduped, null, 2));
