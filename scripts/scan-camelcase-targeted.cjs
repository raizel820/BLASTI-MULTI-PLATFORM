#!/usr/bin/env node
/* Targeted scanner for REAL camelCase leaks.
 *
 * Focuses on:
 *   (A) Locale entries where value === key (placeholder never translated)
 *   (B) Locale entries where value is a single camelCase token (e.g. value: "customerName")
 *   (C) JSX text that is a single camelCase token with NO t() wrapper on the same line
 *   (D) Toast/alert/error calls with raw camelCase strings (not wrapped in t())
 *   (E) camelCase in backtick template literals rendered as UI text
 *   (F) camelCase as button/heading text via <X>camelCase</X> patterns
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

// Strict camelCase: starts lowercase, has >= 1 uppercase inside, length >= 4, no spaces
function isStrictCamel(s) {
  if (!s || s.length < 4) return false;
  if (!/^[a-z][a-zA-Z0-9]+$/.test(s)) return false;
  if (!/[A-Z]/.test(s.slice(1))) return false;
  return true;
}

// === (A+B) Locale value analysis ===
function scanLocaleValues() {
  const findings = [];
  for (const loc of LOCALES) {
    const file = path.join(LOCALE_DIR, `${loc}.ts`);
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const SINGLE = /^\s*([A-Za-z0-9_]+)\s*:\s*(['"`])(.*?)\2\s*,?\s*$/;
    const QKEY = /^\s*['"`]([A-Za-z0-9_]+)['"`]\s*:\s*(['"`])(.*?)\2\s*,?\s*$/;
    const MULTILINE_START = /^\s*([A-Za-z0-9_]+)\s*:\s*$/;
    const MULTILINE_VAL = /^\s*(['"`])(.*?)\1\s*,?\s*$/;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      let m = SINGLE.exec(line) || QKEY.exec(line);
      let key, value, valueLine;
      if (m) {
        key = m[1];
        value = m[3];
        valueLine = i + 1;
      } else {
        m = MULTILINE_START.exec(line);
        if (m && i + 1 < lines.length) {
          const vm = MULTILINE_VAL.exec(lines[i + 1]);
          if (vm) {
            key = m[1];
            value = vm[2];
            valueLine = i + 2;
          }
        }
      }
      if (!key) continue;

      // (A) value === key (unfilled placeholder)
      if (value === key) {
        findings.push({ locale: loc, line: valueLine, key, value, kind: 'value-equals-key' });
        continue;
      }
      // (B) value is a single strict camelCase token (likely a copy-paste of another key)
      if (isStrictCamel(value)) {
        findings.push({ locale: loc, line: valueLine, key, value, kind: 'value-is-camelcase' });
      }
    }
  }
  return findings;
}

// === (C+D+E+F) Source code analysis ===
function scanSource() {
  const findings = [];
  const files = walk(WEB_SRC).filter(f => !f.includes('/i18n/'));
  const SKIP = [/\/hooks\//, /\/lib\//, /\/db\//, /\/store\//, /\/types\//];

  for (const file of files) {
    if (SKIP.some(p => p.test(file))) continue;
    const src = fs.readFileSync(file, 'utf8');
    const lines = src.split('\n');
    const rel = path.relative(WEB_SRC, file);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*')) continue;

      // (C) JSX text: >camelCase<  — single token, no spaces, no braces
      // Match: >someCamelWord<  (possibly with whitespace around)
      const JSX_RE = />\s*([a-z][a-zA-Z0-9]{3,})\s*</g;
      let m;
      while ((m = JSX_RE.exec(line)) !== null) {
        const tok = m[1];
        if (!isStrictCamel(tok)) continue;
        // Skip if the line has t( and the token is quoted (it's a t('tok') call)
        const quoted = new RegExp(`['"\`]${tok}['"\`]`);
        if (line.includes('t(') && quoted.test(line)) continue;
        // Skip React component sub-prop access like <Foo.bar> — but those use . not camelCase
        // Skip if it's a HTML tag name (unlikely since we required lowercase start + length 4+)
        // Common false positive: tag names like "span", "div" — but those are all-lowercase, not camelCase
        findings.push({ file: rel, line: i + 1, kind: 'jsx-text', token: tok, context: line.trim().slice(0, 120) });
      }

      // (D) Toast/alert/error: toast({ title: "camelCase", ... }) or toast("camelCase")
      // We want raw string literals (not t() calls) that are camelCase
      const TOAST_RE = /\b(?:toast|sonner|showToast|toastError|toastSuccess|toastWarning|toastInfo|alert)\s*(?:\(\s*\{[^}]*?(?:title|description|message)\s*:\s*|(\())\s*['"`]([a-z][a-zA-Z0-9]{3,})['"`]/g;
      while ((m = TOAST_RE.exec(line)) !== null) {
        const tok = m[2];
        if (!isStrictCamel(tok)) continue;
        findings.push({ file: rel, line: i + 1, kind: 'toast', token: tok, context: line.trim().slice(0, 120) });
      }
      // Also: toast("camelCase") simple form
      const TOAST_SIMPLE_RE = /\btoast\s*\(\s*['"`]([a-z][a-zA-Z0-9]{3,})['"`]/g;
      while ((m = TOAST_SIMPLE_RE.exec(line)) !== null) {
        const tok = m[1];
        if (!isStrictCamel(tok)) continue;
        findings.push({ file: rel, line: i + 1, kind: 'toast-simple', token: tok, context: line.trim().slice(0, 120) });
      }

      // (E) Template literal rendered as UI: `Hello ${camelCase}` — only catch if static portion has camelCase
      // Skip — too noisy, mostly false positives

      // (F) <Button>camelCase</Button>, <h1>camelCase</h1>, etc. — caught by (C) above

      // (G) Object literal in JSX context: <Badge>{someVar.status}</Badge> where status is a raw string
      // Skip — requires data flow analysis

      // (H) setTitle('camelCase') or document.title = 'camelCase'
      const TITLE_RE = /\b(?:document\.title\s*=\s*|setTitle\s*\(\s*)['"`]([a-z][a-zA-Z0-9]{3,})['"`]/g;
      while ((m = TITLE_RE.exec(line)) !== null) {
        const tok = m[1];
        if (!isStrictCamel(tok)) continue;
        findings.push({ file: rel, line: i + 1, kind: 'document-title', token: tok, context: line.trim().slice(0, 120) });
      }
    }
  }
  return findings;
}

const localeFindings = scanLocaleValues();
const sourceFindings = scanSource();

console.log('=== Targeted camelCase Leak Scan ===\n');

console.log(`(A+B) Locale values that ARE camelCase (unfilled placeholders): ${localeFindings.length}`);
const byLocale = {};
for (const f of localeFindings) {
  if (!byLocale[f.locale]) byLocale[f.locale] = [];
  byLocale[f.locale].push(f);
}
for (const loc of LOCALES) {
  const items = byLocale[loc] || [];
  console.log(`  ${loc}.ts: ${items.length} entries`);
  for (const f of items.slice(0, 80)) {
    console.log(`    L${f.line}  [${f.kind}]  ${f.key} = ${JSON.stringify(f.value)}`);
  }
  if (items.length > 80) console.log(`    ... +${items.length - 80} more`);
}
console.log();

console.log(`(C-H) Source code raw camelCase leaks: ${sourceFindings.length}`);
const byFile = {};
for (const f of sourceFindings) {
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
}
console.log(`  Files with leaks: ${Object.keys(byFile).length}\n`);
const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
for (const [file, items] of sortedFiles) {
  console.log(`--- ${file} (${items.length}) ---`);
  const seen = new Set();
  for (const it of items) {
    const k = `${it.line}:${it.kind}:${it.token}`;
    if (seen.has(k)) continue;
    seen.add(k);
    console.log(`  L${it.line} [${it.kind}]  ${it.token}`);
    console.log(`    ${it.context}`);
  }
}

fs.writeFileSync('/home/z/my-project/i18n-camel-targeted.json', JSON.stringify({
  localeFindings,
  sourceFindings,
}, null, 2));
console.log('\nFull report: /home/z/my-project/i18n-camel-targeted.json');
