#!/usr/bin/env node
/* Find camelCase words leaking into the UI.
 *
 * Sources of camelCase leakage:
 *   (A) Locale values that ARE camelCase (placeholder never translated — value === key or value is a JS identifier)
 *   (B) camelCase tokens in JSX text children: <div>customerName</div>
 *   (C) camelCase tokens in JSX prop values: placeholder="enterCustomerName", title="orderStatus", aria-label="toggleSidebar"
 *   (D) camelCase tokens in toast() / sonner calls: toast({ title: "reservationCancelled" })
 *   (E) camelCase tokens in Dialog/Alert/Shadcn component props: <AlertTitle>uploadFailed</AlertTitle>
 *
 * A camelCase token is: 2+ uppercase letters in a single word, length >= 4, contains at least 1 lowercase.
 * Examples: customerName, uploadFailed, reservationCancelled, toggleSidebar
 * Non-examples: CPU, TV, QR, ID, API, PDF, BLASTI, JS, CSS, HTML (acronyms — uppercase only)
 * Non-examples: bg-red-500, px-4, max-w-md (CSS classes)
 * Non-examples: Button, Card, Dialog (PascalCase — React component names)
 */
const fs = require('fs');
const path = require('path');

const WEB_SRC = '/home/z/my-project/apps/web/src';
const LOCALE_DIR = '/home/z/my-project/apps/web/src/i18n';
const LOCALES = ['en', 'ar', 'fr'];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

// Match camelCase identifiers (lowercase first letter, then uppercase letters inside).
// Must be 4+ chars, contain >= 1 uppercase besides the first letter, and contain >= 1 lowercase.
// Examples that match: customerName, uploadFailed, toggleSidebar, tvBoardNowServing
// Examples that DON'T match: CPU, TV, QR, BLASTI, Button, Card, bg-red-500, 1fr
const CAMEL_RE = /\b[a-z][a-zA-Z]*[A-Z][a-zA-Z]+\b/g;

function isCamelCase(s) {
  if (!s || s.length < 4) return false;
  // Must start with lowercase
  if (!/^[a-z]/.test(s)) return false;
  // Must contain at least one uppercase letter AFTER the first char
  if (!/[A-Z]/.test(s.slice(1))) return false;
  // Must contain at least one lowercase letter
  if (!/[a-z]/.test(s)) return false;
  // Reject if it's all-caps with a single letter prefix like "iOS"
  if (/^[a-z][A-Z]+$/.test(s)) return false;
  // Reject if it looks like a CSS unit (ends with digits and contains hyphens or is short)
  if (/\d$/.test(s) && s.length < 8) return false;
  return true;
}

function extractCamelTokens(s) {
  const out = [];
  let m;
  CAMEL_RE.lastIndex = 0;
  while ((m = CAMEL_RE.exec(s)) !== null) {
    if (isCamelCase(m[0])) out.push(m[0]);
  }
  return out;
}

// === (A) Locale values that are themselves camelCase ===
function scanLocaleValues() {
  const findings = [];
  for (const loc of LOCALES) {
    const file = path.join(LOCALE_DIR, `${loc}.ts`);
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    // Match:  keyName: 'value', OR  keyName: "value", OR  'keyName': 'value', OR multi-line `keyName:\n  'value'`
    const SINGLE = /^\s*([A-Za-z0-9_]+)\s*:\s*(['"`])(.*?)\2\s*,?\s*$/;
    const QKEY = /^\s*['"`]([A-Za-z0-9_]+)['"`]\s*:\s*(['"`])(.*?)\2\s*,?\s*$/;
    const MULTILINE_START = /^\s*([A-Za-z0-9_]+)\s*:\s*$/;
    const MULTILINE_VAL = /^\s*(['"`])(.*?)\1\s*,?\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = SINGLE.exec(line) || QKEY.exec(line);
      if (m) {
        const key = m[1] || m[2]; // for QKEY, group 1 is key, group 2 is quote, group 3 is value
        // for SINGLE: group 1 is key, group 2 is quote, group 3 is value
        // for QKEY: group 1 is key, group 2 is quote, group 3 is value
        const value = m[3];
        const tokens = extractCamelTokens(value);
        for (const tok of tokens) {
          // Skip if the token is the same as the key (key=value placeholder)
          // Skip common acronyms in allowed positions
          if (tok === 'DZD' || tok === 'BLASTI' || tok === 'QR' || tok === 'API' || tok === 'PDF' || tok === 'SMS' || tok === 'URL') continue;
          findings.push({ locale: loc, file: `${loc}.ts`, line: i + 1, kind: 'locale-value', key, token: tok, value });
        }
        continue;
      }
      // Multi-line value: key on line i, value on line i+1
      m = MULTILINE_START.exec(line);
      if (m) {
        const key = m[1];
        if (i + 1 < lines.length) {
          const vline = lines[i + 1];
          const vm = MULTILINE_VAL.exec(vline);
          if (vm) {
            const value = vm[2];
            const tokens = extractCamelTokens(value);
            for (const tok of tokens) {
              findings.push({ locale: loc, file: `${loc}.ts`, line: i + 2, kind: 'locale-value', key, token: tok, value });
            }
          }
        }
      }
    }
  }
  return findings;
}

// === (B/C/D/E) Source code camelCase leaks ===
function scanSource() {
  const findings = [];
  const files = walk(WEB_SRC).filter(f => !f.includes('/i18n/'));

  // Skip non-UI files
  const SKIP = [/\/hooks\//, /\/lib\//, /\/db\//, /\/store\//, /\/types\//];

  // Patterns:
  // 1. JSX text: >camelCase<
  // 2. Placeholder/title/label/etc: prop="camelCase text" or prop='camelCase text'
  // 3. Toast/dialog: title: "camelCase", description: "camelCase"
  // 4. <ComponentProp>camelCase</ComponentProp>
  // 5. Template literals: `camelCase ${var}` — only catch if the static portion contains camelCase

  const JSX_TEXT_RE = />\s*([A-Za-z][A-Za-z0-9_\- ]*?)\s*</g;
  // Match double-quoted string values for common UI props
  const PROP_RE = /\b(placeholder|title|description|label|aria-label|hint|subtitle|message|tooltip|alt|caption)\s*=\s*"([^"]+)"/g;
  const PROP_SINGLE_RE = /\b(placeholder|title|description|label|aria-label|hint|subtitle|message|tooltip|alt|caption)\s*=\s*'([^']+)'/g;
  // Toast and similar: { title: "...", description: "..." }
  const OBJ_LIT_RE = /\b(title|description|message|label|subtitle|hint|tooltip)\s*:\s*['"`]([^'"`]+)['"`]/g;

  for (const file of files) {
    if (SKIP.some(p => p.test(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const rel = path.relative(WEB_SRC, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Skip lines that are just t('...') — those are translations
      // We want to find RAW camelCase text in JSX, NOT t('camelCase') calls

      // (1) JSX text
      let m;
      JSX_TEXT_RE.lastIndex = 0;
      while ((m = JSX_TEXT_RE.exec(line)) !== null) {
        const text = m[1].trim();
        if (!text) continue;
        // Skip if it's all caps (component name like Button), or contains JSX braces
        if (/[{}]/.test(text)) continue;
        // Skip if the line already has t( on it (likely a translation call)
        if (line.includes('t(') && line.includes(m[1])) {
          // Could be {t('xyz')} or {t('xyz') || 'fallback'} — check
          // Only skip if the camelCase text is INSIDE the t() call
          // Heuristic: if the text contains a space, it's likely plain text not a key
          if (!text.includes(' ')) {
            // Single word camelCase on a t() line — could be the key inside t()
            // Check if it's quoted
            const quoted = new RegExp(`['"\`]${text}['"\`]`);
            if (quoted.test(line)) continue;
          }
        }
        const tokens = extractCamelTokens(text);
        for (const tok of tokens) {
          // Skip if it's a known acronym (rare in camelCase form)
          // Skip React component names if they appear standalone (PascalCase)
          findings.push({ file: rel, line: i + 1, kind: 'jsx-text', token: tok, text });
        }
      }

      // (2) Prop values (double-quoted)
      PROP_RE.lastIndex = 0;
      while ((m = PROP_RE.exec(line)) !== null) {
        const prop = m[1];
        const value = m[2];
        // Skip if line contains t() and the prop value matches the t() arg pattern
        // (e.g., placeholder={t('xyz')} — but those use {} not "" so they wouldn't match this regex)
        const tokens = extractCamelTokens(value);
        for (const tok of tokens) {
          findings.push({ file: rel, line: i + 1, kind: `prop:${prop}`, token: tok, text: value });
        }
      }

      // (2b) Prop values (single-quoted)
      PROP_SINGLE_RE.lastIndex = 0;
      while ((m = PROP_SINGLE_RE.exec(line)) !== null) {
        const prop = m[1];
        const value = m[2];
        const tokens = extractCamelTokens(value);
        for (const tok of tokens) {
          findings.push({ file: rel, line: i + 1, kind: `prop:${prop}`, token: tok, text: value });
        }
      }

      // (3) Object literal string values (toast/dialog)
      OBJ_LIT_RE.lastIndex = 0;
      while ((m = OBJ_LIT_RE.exec(line)) !== null) {
        const prop = m[1];
        const value = m[2];
        // Skip if this is inside a t() call (heuristic: line has t( )
        // Skip lines that look like the locale definition
        if (rel === `i18n/${path.basename(file)}`) continue;
        const tokens = extractCamelTokens(value);
        for (const tok of tokens) {
          // Skip if value is exactly the key (locale-style definition we already catch in (A))
          findings.push({ file: rel, line: i + 1, kind: `obj-lit:${prop}`, token: tok, text: value });
        }
      }
    }
  }
  return findings;
}

const localeFindings = scanLocaleValues();
const sourceFindings = scanSource();

console.log('=== camelCase Leak Scan ===\n');
console.log(`(A) Locale values containing camelCase tokens: ${localeFindings.length}`);
// Group by token + locale
const localeByToken = {};
for (const f of localeFindings) {
  const k = `${f.token}`;
  if (!localeByToken[k]) localeByToken[k] = { token: f.token, locales: {}, key: f.key, value: f.value };
  if (!localeByToken[k].locales[f.locale]) localeByToken[k].locales[f.locale] = [];
  localeByToken[k].locales[f.locale].push({ line: f.line, key: f.key, value: f.value });
}
const localeTokens = Object.values(localeByToken).sort((a, b) => a.token.localeCompare(b.token));
console.log(`  Unique camelCase tokens in locale VALUES: ${localeTokens.length}\n`);
for (const t of localeTokens.slice(0, 60)) {
  const locs = Object.keys(t.locales).join('/');
  console.log(`  ${t.token}  [${locs}]  key=${t.key}`);
  for (const loc of Object.keys(t.locales)) {
    for (const e of t.locales[loc]) {
      console.log(`    ${loc}.ts:L${e.line}  ${e.key} = ${JSON.stringify(e.value).slice(0, 100)}`);
    }
  }
}
if (localeTokens.length > 60) console.log(`  ... +${localeTokens.length - 60} more`);

console.log(`\n(B-E) Source code camelCase leaks: ${sourceFindings.length}`);
// Group by file
const byFile = {};
for (const f of sourceFindings) {
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
}
console.log(`  Files with leaks: ${Object.keys(byFile).length}\n`);
const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
for (const [file, items] of sortedFiles) {
  console.log(`--- ${file} (${items.length}) ---`);
  // Dedupe by token+line+kind
  const seen = new Set();
  for (const it of items) {
    const k = `${it.line}:${it.kind}:${it.token}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  L${it.line} [${it.kind}]  ${it.token}  (in: ${JSON.stringify(it.text).slice(0, 80)})`);
  }
}

fs.writeFileSync('/home/z/my-project/i18n-camel-report.json', JSON.stringify({
  localeFindings,
  sourceFindings,
  localeByToken,
}, null, 2));
console.log('\nFull report: /home/z/my-project/i18n-camel-report.json');
