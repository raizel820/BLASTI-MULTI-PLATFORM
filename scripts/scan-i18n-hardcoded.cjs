#!/usr/bin/env node
/* Scan for hardcoded user-facing strings that should likely be wrapped in t().
 * Focus on JSX prop values and JSX text children that contain English words.
 * Reports a sample for human review (will produce false positives — that's expected).
 */
const fs = require('fs');
const path = require('path');

const WEB_SRC = '/home/z/my-project/apps/web/src';
const LOCALE_DIR = '/home/z/my-project/apps/web/src/i18n';

// Read existing keys to filter out ones that are already wrapped
function extractLocaleKeys(localeFile) {
  const src = fs.readFileSync(localeFile, 'utf8');
  const keys = new Set();
  const KEY_RE = /^\s*([A-Za-z0-9_]+)\s*:\s*['"`]/gm;
  let m;
  while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
  return keys;
}
const enKeys = extractLocaleKeys(path.join(LOCALE_DIR, 'en.ts'));

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

// Skip non-UI files
const SKIP_PATTERNS = [
  /\/hooks\//, /\/lib\//, /\/db\//, /\/store\//, /\/types\//,
  /\/app\/layout\.tsx$/, /\/app\/loading\.tsx$/,
];

// Heuristic: English text that looks like a UI string
// - Has at least 3 alphabetic chars
// - Has a space or is title-case (multi-word)
// - Not a single technical token like "bg-red-500", "px-4", "1em", etc.
function looksLikeUIText(s) {
  if (!s) return false;
  // Strip template placeholders {var}
  const cleaned = s.replace(/\{[^}]+\}/g, '').trim();
  if (cleaned.length < 4) return false;
  if (cleaned.length > 120) return false;
  // Must have at least one alphabetic char
  if (!/[A-Za-zÀ-ÿ]/.test(cleaned)) return false;
  // Must contain a space (multi-word) OR be a recognizable single word (capitalized, > 4 chars)
  const hasSpace = /\s/.test(cleaned);
  const isCapitalized = /^[A-Z][a-z]{3,}$/.test(cleaned);
  if (!hasSpace && !isCapitalized) return false;
  // Skip pure CSS classes, technical tokens
  if (/^(bg|text|border|flex|grid|gap|p|m|w|h|rounded|shadow|font|text|items|justify|absolute|relative|fixed|sticky|block|inline|hidden|overflow|cursor|select|animate|duration|ease|delay|inset|top|right|bottom|left|z|opacity|min|max)/.test(cleaned)) return false;
  if (/^[a-z][a-zA-Z\-]*\d*$/.test(cleaned) && !hasSpace) return false; // camelCase variable
  if (/^https?:\/\//.test(cleaned)) return false;
  if (/^[0-9]/.test(cleaned)) return false; // starts with digit
  if (/^[\d\.\,\s]+$/.test(cleaned)) return false; // pure number/space
  // Skip technical tokens like "1fr", "auto", "100%", "0 0 1fr", CSS values
  if (/^(auto|none|hidden|visible|scroll|inherit|initial|unset|center|left|right|top|bottom|stretch|wrap|nowrap|column|row|fit-content|min-content|max-content)$/.test(cleaned)) return false;
  return true;
}

// Find JSX prop values: placeholder="...", title="...", description="...", label="...", aria-label="..."
// Limit to double-quoted strings (single quotes are less common in JSX)
const PROP_RE = /\b(placeholder|title|description|label|aria-label|hint|subtitle|message|tooltip)\s*=\s*"([^"]+)"/g;

// Find toast calls: toast({ title: "...", description: "..." })
const TOAST_RE = /\b(?:toast|sonnerToast|showToast)\(\s*\{[^}]*?(?:title|description|message)\s*:\s*"([^"]+)"/g;

// Find >Text< JSX children that are static English (not wrapped in {})
// Use a simple regex that catches `<Tag>Word(s)</Tag>` where content is plain text
const JSX_TEXT_RE = />\s*([A-Z][a-z]+(?:\s+[A-Za-z]+){0,8})\s*</g;

const findings = [];

for (const file of files) {
  if (SKIP_PATTERNS.some(p => p.test(file))) continue;
  const src = fs.readFileSync(file, 'utf8');
  const lines = src.split('\n');
  const rel = path.relative(WEB_SRC, file);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Prop values
    let m;
    PROP_RE.lastIndex = 0;
    while ((m = PROP_RE.exec(line)) !== null) {
      const text = m[2];
      if (!looksLikeUIText(text)) continue;
      // Skip if the line already uses t() for that text (cheap check)
      if (line.includes('t(')) continue;
      findings.push({ file: rel, line: i + 1, kind: `prop:${m[1]}`, text });
    }

    // Toast
    TOAST_RE.lastIndex = 0;
    while ((m = TOAST_RE.exec(line)) !== null) {
      const text = m[1];
      if (!looksLikeUIText(text)) continue;
      if (line.includes('t(')) continue;
      findings.push({ file: rel, line: i + 1, kind: 'toast', text });
    }

    // JSX text
    JSX_TEXT_RE.lastIndex = 0;
    while ((m = JSX_TEXT_RE.exec(line)) !== null) {
      const text = m[1].trim();
      if (!looksLikeUIText(text)) continue;
      if (line.includes('t(')) continue;
      // Skip common non-translation cases
      if (/^(Button|Card|Input|Label|Dialog|Tabs|Table|Badge|Avatar|Spinner|Loading|Form|Sheet|Select|Sheet|Tag|Spinner|Skeleton)$/.test(text)) continue;
      findings.push({ file: rel, line: i + 1, kind: 'jsx-text', text });
    }
  }
}

// Dedupe
const seen = new Set();
const deduped = findings.filter(f => {
  const key = `${f.file}:${f.line}:${f.text}`;
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
});

// Group by file
const byFile = {};
for (const f of deduped) {
  if (!byFile[f.file]) byFile[f.file] = [];
  byFile[f.file].push(f);
}

console.log(`=== Hardcoded string scan ===`);
console.log(`Total findings: ${deduped.length} (sample below — many false positives expected)`);
console.log(`Files with findings: ${Object.keys(byFile).length}\n`);

// Sort files by count descending, show top 25 files with up to 5 findings each
const sortedFiles = Object.entries(byFile).sort((a, b) => b[1].length - a[1].length);
for (const [file, items] of sortedFiles.slice(0, 30)) {
  console.log(`--- ${file} (${items.length} findings) ---`);
  for (const it of items.slice(0, 6)) {
    console.log(`  L${it.line} [${it.kind}]  ${JSON.stringify(it.text).slice(0, 100)}`);
  }
  if (items.length > 6) console.log(`  ... +${items.length - 6} more`);
}

fs.writeFileSync('/home/z/my-project/i18n-hardcoded-report.json', JSON.stringify(deduped, null, 2));
console.log(`\nFull report written to /home/z/my-project/i18n-hardcoded-report.json`);
