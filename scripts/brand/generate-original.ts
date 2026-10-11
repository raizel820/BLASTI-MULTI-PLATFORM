/**
 * BLASTI brand asset generator — ORIGINAL-LOGO edition.
 *
 * The untouched original logo (white rounded tile + teal waiting bench +
 * orange "your turn" dot) is the SINGLE SOURCE OF TRUTH. No redrawn
 * geometry anywhere — each asset is precise placement of the original
 * artwork so the app identity stays exactly as designed.
 *
 * Renders:
 *   1. Desktop (Electron): icon.png 1024 + multi-size icon.ico
 *   2. Android: ic_launcher / ic_launcher_round / adaptive foreground (all densities)
 *   3. Android splash: white splash with the original logo centered (port+land, all densities)
 *   4. Web/PWA: favicon, apple-touch-icon, logo-192, logo-512
 *   5. Intro asset: public/blasti-app-icon.png (used by AppIntroAnimation)
 */
import sharp from 'sharp';
import pngToIco from 'png-to-ico';
import { writeFileSync } from 'fs';

const ROOT = '/home/z/my-project';
const DESKTOP = `${ROOT}/apps/desktop/assets`;
const RES = `${ROOT}/apps/mobile/android/app/src/main/res`;
const WEB_PUBLIC = `${ROOT}/apps/web/public`;
/** The original logo, exactly as supplied by the owner. */
const SRC = `${ROOT}/brand/original-logo.png`;

const log = (p: string, extra = '') =>
  console.log(`✓ ${p.replace(ROOT, '')} ${extra}`);

/** Original artwork resized to a square PNG buffer (art is already 1:1). */
async function fitPng(size: number): Promise<Buffer> {
  return sharp(SRC).resize(size, size).png().toBuffer();
}

/**
 * Measure the rounded-tile bounds (fraction of canvas) by scanning for
 * non-white pixels — the tile's light border ring defines the extents.
 */
async function tileBounds(): Promise<{ minX: number; maxX: number; minY: number; maxY: number }> {
  const N = 256;
  const { data } = await sharp(SRC).resize(N, N).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  let minX = N, minY = N, maxX = -1, maxY = -1;
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const i = (y * N + x) * 3;
      if (255 - data[i] > 12 || 255 - data[i + 1] > 12 || 255 - data[i + 2] > 12) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX: minX / N, maxX: (maxX + 1) / N, minY: minY / N, maxY: (maxY + 1) / N };
}

/** Circular-cropped icon where the white tile exactly fills the mask circle. */
async function roundIcon(size: number, k: number): Promise<Buffer> {
  const masked0 = await tileFillIcon(1024, k);
  const mask = Buffer.from(
    `<svg width="1024" height="1024"><circle cx="512" cy="512" r="512" fill="#fff"/></svg>`,
  );
  const masked = await sharp(masked0)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();
  return sharp(masked).resize(size, size).png().toBuffer();
}

/**
 * Square crop where the white tile exactly fills the canvas (scale k, center
 * crop, NO mask). Same untouched artwork — tighter framing so the bench reads
 * clearly at small sizes (favicon, .ico, PWA). The tile's own rounded corners
 * remain part of the artwork.
 */
async function tileFillIcon(size: number, k: number): Promise<Buffer> {
  const big = Math.round(1024 * k);
  const base = await sharp(SRC).resize(big, big).toBuffer();
  const off = Math.round((big - 1024) / 2);
  const cropped = await sharp(base)
    .extract({ left: off, top: off, width: 1024, height: 1024 })
    .toBuffer();
  return sharp(cropped).resize(size, size).png().toBuffer();
}

// Tile bounds + scale factor shared by every tile-fill asset
const bounds = await tileBounds();
const tileW = bounds.maxX - bounds.minX;
const tileH = bounds.maxY - bounds.minY;
const k = 1 / Math.max(tileW, tileH); // scale so the tile exactly fills the canvas/mask
console.log(
  `  tile bounds: x ${bounds.minX.toFixed(3)}-${bounds.maxX.toFixed(3)}, y ${bounds.minY.toFixed(3)}-${bounds.maxY.toFixed(3)} → tile-fill scale ×${k.toFixed(3)}`,
);

// ─── 1. Desktop ───────────────────────────────────────────────────────────────
console.log('\n◆ Desktop (Electron) — original artwork, tile-fill framing');
await sharp(await tileFillIcon(1024, k)).png().toFile(`${DESKTOP}/icon.png`);
log(`${DESKTOP}/icon.png`, '(1024x1024)');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const icoBufs = await Promise.all(icoSizes.map((s) => tileFillIcon(s, k)));
const ico = await (pngToIco as unknown as (b: Buffer[]) => Promise<Buffer>)(icoBufs);
writeFileSync(`${DESKTOP}/icon.ico`, ico);
log(`${DESKTOP}/icon.ico`, `(${icoSizes.join(', ')})`);

// ─── 2. Android launchers ─────────────────────────────────────────────────────
console.log('\n◆ Android launcher icons — original artwork', );

const launcherDensities: Record<string, number> = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 };
for (const [d, size] of Object.entries(launcherDensities)) {
  const dir = `${RES}/mipmap-${d}`;
  writeFileSync(`${dir}/ic_launcher.png`, await fitPng(size));
  writeFileSync(`${dir}/ic_launcher_round.png`, await roundIcon(size, k));
  log(`${dir}/ic_launcher.png + ic_launcher_round.png`, `(${size})`);
}

// Adaptive foreground: white canvas + original scaled to keep every pixel of
// the artwork inside the 66% safe zone (tile ≈ 57% of canvas).
const fgDensities: Record<string, number> = { mdpi: 108, hdpi: 162, xhdpi: 216, xxhdpi: 324, xxxhdpi: 432 };
for (const [d, size] of Object.entries(fgDensities)) {
  const inner = Math.round(size * 0.92);
  const logo = await fitPng(inner);
  await sharp({ create: { width: size, height: size, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } } })
    .composite([{ input: logo, left: Math.round((size - inner) / 2), top: Math.round((size - inner) / 2) }])
    .png()
    .toFile(`${RES}/mipmap-${d}/ic_launcher_foreground.png`);
  log(`${RES}/mipmap-${d}/ic_launcher_foreground.png`, `(${size})`);
}

// ─── 3. Android splash ────────────────────────────────────────────────────────
console.log('\n◆ Android splash — white background + original logo centered');
const splashDensities: Record<string, { port: [number, number]; land: [number, number] }> = {
  mdpi: { port: [320, 480], land: [480, 320] },
  hdpi: { port: [480, 800], land: [800, 480] },
  xhdpi: { port: [720, 1280], land: [1280, 720] },
  xxhdpi: { port: [960, 1600], land: [1600, 960] },
  xxxhdpi: { port: [1280, 1920], land: [1920, 1280] },
};

async function splash(w: number, h: number, out: string) {
  const min = Math.min(w, h);
  const s = Math.round(min * 0.65); // tile inside is ~62% → visible tile ≈ 40% of min dim
  const logo = await fitPng(s);
  await sharp({ create: { width: w, height: h, channels: 3, background: { r: 255, g: 255, b: 255 } } })
    .composite([{ input: logo, left: Math.round((w - s) / 2), top: Math.round((h - s) / 2) - Math.round(h * 0.02) }])
    .png()
    .toFile(out);
  log(out.replace(ROOT, ''), `(${w}x${h})`);
}
await splash(480, 320, `${RES}/drawable/splash.png`);
for (const [d, { port, land }] of Object.entries(splashDensities)) {
  await splash(port[0], port[1], `${RES}/drawable-port-${d}/splash.png`);
  await splash(land[0], land[1], `${RES}/drawable-land-${d}/splash.png`);
}

// ─── 4. Web/PWA icon set ──────────────────────────────────────────────────────
console.log('\n◆ Web/PWA icons — original artwork, tile-fill framing');
writeFileSync(`${WEB_PUBLIC}/favicon.png`, await tileFillIcon(64, k)); log(`${WEB_PUBLIC}/favicon.png`, '(64)');
writeFileSync(`${WEB_PUBLIC}/apple-touch-icon.png`, await tileFillIcon(180, k)); log(`${WEB_PUBLIC}/apple-touch-icon.png`, '(180)');
writeFileSync(`${WEB_PUBLIC}/logo-192.png`, await tileFillIcon(192, k)); log(`${WEB_PUBLIC}/logo-192.png`, '(192)');
writeFileSync(`${WEB_PUBLIC}/logo-512.png`, await tileFillIcon(512, k)); log(`${WEB_PUBLIC}/logo-512.png`, '(512)');

// ─── 5. Intro animation asset ─────────────────────────────────────────────────
console.log('\n◆ Intro animation asset');
writeFileSync(`${WEB_PUBLIC}/blasti-app-icon.png`, await tileFillIcon(512, k));
log(`${WEB_PUBLIC}/blasti-app-icon.png`, '(512 — used by AppIntroAnimation)');

console.log('\n✅ All brand assets regenerated from the ORIGINAL logo');
