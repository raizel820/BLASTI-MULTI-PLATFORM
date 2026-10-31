/**
 * 0.6.38 — generate the SHARED preset-avatar static files.
 *
 * The twelve preset profile icons are drawn in ONE place
 * (apps/web/src/components/auth/preset-avatars.ts) as inline SVG data URIs.
 * This script decodes those data URIs into real .svg files and writes them
 * to the two api surfaces that serve them:
 *
 *   apps/api/static/avatars/presets/preset-<n>.svg                (cloud)
 *   apps/desktop/local-api/static/avatars/presets/preset-<n>.svg  (desktop
 *                                                    bundle — local-api/**)
 *
 * They are served through the SAME /api/upload/file/avatar/… namespace as
 * real uploads (virtual static files intercepted before the disk store), so
 * picking a preset at registration stores just the shared PATH — no upload,
 * no per-user copy, no JWT bloat, fully offline on the desktop.
 *
 * Run after changing the presets:
 *   bun scripts/generate-preset-avatar-files.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PRESET_AVATARS } from '../apps/web/src/components/auth/preset-avatars';

const OUT_DIRS = [
  join(import.meta.dir, '..', 'apps', 'api', 'static', 'avatars', 'presets'),
  join(import.meta.dir, '..', 'apps', 'desktop', 'local-api', 'static', 'avatars', 'presets'),
];

const PREFIX = 'data:image/svg+xml,';
let written = 0;

PRESET_AVATARS.forEach((uri, i) => {
  if (!uri.startsWith(PREFIX)) throw new Error(`preset ${i + 1}: unexpected data URI shape`);
  const svg = decodeURIComponent(uri.slice(PREFIX.length));
  for (const dir of OUT_DIRS) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `preset-${i + 1}.svg`), svg + '\n');
    written++;
  }
  console.log(`preset-${i + 1}.svg  (${svg.length} bytes of svg)`);
});

console.log(`done — ${written} files across ${OUT_DIRS.length} targets`);
