const fs = require('fs');
const data = JSON.parse(fs.readFileSync('/tmp/dz1.json', 'utf8'));
const byCode = new Map();
for (const r of data) {
  const code = r.wilaya_code;
  if (!byCode.has(code)) byCode.set(code, { code, name: r.wilaya_name_ascii, nameAr: r.wilaya_name, communes: new Map() });
  const w = byCode.get(code);
  w.communes.set(r.commune_name_ascii, { name: r.commune_name_ascii, nameAr: r.commune_name });
}
const wilayas = [...byCode.values()]
  .sort((a, b) => a.code.localeCompare(b.code))
  .map((w) => ({ ...w, communes: [...w.communes.values()].sort((a, b) => a.name.localeCompare(b.name)) }));

const esc = (s) => s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");

const header = `/**
 * Algeria administrative divisions — 58 wilayas and 1541 communes (baladiyas).
 * Data source: algeria-cities open dataset (commune names in Arabic + Latin).
 * Wilaya codes are the official two-digit ANI codes ('01'-'58').
 *
 * Used by the register form and the create-agency form address selectors.
 * Keep this file pure data — no side effects, tree-shakeable.
 */

export interface AlgeriaCommune {
  /** Latin commune name, e.g. "Bab El Oued" */
  name: string;
  /** Arabic commune name, e.g. "باب الوادي" */
  nameAr: string;
}

export interface AlgeriaWilaya {
  /** Official two-digit wilaya code, e.g. '16' for Alger */
  code: string;
  /** Latin wilaya name, e.g. "Alger" */
  name: string;
  /** Arabic wilaya name, e.g. "الجزائر" */
  nameAr: string;
  /** Communes (baladiyas) belonging to this wilaya, sorted by Latin name */
  communes: AlgeriaCommune[];
}

export const ALGERIA_WILAYAS: AlgeriaWilaya[] = [`;

let out = header;
for (const w of wilayas) {
  out += `
  {
    code: '${w.code}',
    name: '${esc(w.name)}',
    nameAr: '${esc(w.nameAr)}',
    communes: [`;
  for (const c of w.communes) {
    out += ` { name: '${esc(c.name)}', nameAr: '${esc(c.nameAr)}' },`;
  }
  out += `
    ],
  },`;
}

const footer = `
];

/** Total commune count (baladiyas) — 1541. */
export const ALGERIA_COMMUNE_COUNT = ALGERIA_WILAYAS.reduce((sum, w) => sum + w.communes.length, 0);

/** Wilaya label helper: '16 - Alger' (Latin) or '16 - الجزائر' (Arabic). */
export function wilayaLabel(w: AlgeriaWilaya, lang: string): string {
  return lang === 'ar' ? \`\${w.code} - \${w.nameAr}\` : \`\${w.code} - \${w.name}\`;
}

/** Commune label helper: Latin or Arabic name by language. */
export function communeLabel(c: AlgeriaCommune, lang: string): string {
  return lang === 'ar' ? c.nameAr : c.name;
}

/** Find a wilaya by its official code ('01'..'58', also accepts '1'..'58'). */
export function findWilayaByCode(code: string): AlgeriaWilaya | undefined {
  const normalized = code ? code.padStart(2, '0') : '';
  return ALGERIA_WILAYAS.find((w) => w.code === normalized);
}
`;

out += footer;
fs.writeFileSync('/home/z/my-project/apps/web/src/lib/algeria-locations.ts', out);
console.log('written chars:', out.length);
console.log('wilayas:', wilayas.length, 'communes total:', wilayas.reduce((s, w) => s + w.communes.length, 0));
