/**
 * BLASTI MULTI — FULL PLATFORM RESET (Task 34)
 *
 *   bun run reset:all                    # everything below
 *   bun run reset:all --cloud-only       # cloud DB + seed + cloud files (no desktop)
 *   bun run reset:all --desktop-only     # desktop local data only
 *   bun run reset:all --files-only       # uploaded files only (no DB, no desktop)
 *   bun run reset:all -y                 # skip the 5s abort countdown
 *   bun run reset:all --wipe-app-binaries
 *                                        # also delete uploaded desktop app binaries
 *                                        # (kept by default — they are app files)
 *
 * ─── WHAT GETS WIPED ──────────────────────────────────────────────────────────
 * 1. Cloud database  packages/db/data/custom.db (+ -journal / -wal / -shm)
 *    → includes ALL tokens, sessions, verification codes, device registrations,
 *      sync state, transactions (everything lives in the DB).
 *    Then recreated with `prisma db push` + the fresh-start seed, which creates
 *    EXACTLY ONE account: the super admin (admin / admin123).
 * 2. Uploaded user files (images, PDFs, receipts, avatars, logos…):
 *      apps/api/uploads/<bucket>/…     buckets: avatar, logo, receipt, document, general
 *      apps/web/public/uploads/…       (legacy upload location)
 *      os.tmpdir()/blasti-app-uploads/ (legacy app-binary fallback)
 * 3. Desktop local data — BOTH the dev dir (@blasti/desktop) and the packaged
 *    dir (BLASTI) are cleaned on the current OS:
 *      Windows : %APPDATA%\@blasti\desktop  and  %APPDATA%\BLASTI
 *      macOS   : ~/Library/Application Support/… (same two subdirs)
 *      Linux   : ~/.config/@blasti/desktop  and  ~/.config/BLASTI
 *    Inside each (if present):
 *      blasti-local/          → local SQLite database (local.db + -wal/-shm)
 *      blasti-files/          → local file store
 *      blasti-auth.json       → stored session token (forces login on next launch)
 *    Plus the legacy standalone fallback ~/.blasti/local and ~/.blasti/files.
 *
 * ─── WHAT IS PRESERVED (app-needed files) ─────────────────────────────────────
 * • Web app logo/icons in apps/web/public/ (logo.svg, logo.png, logo-192.png,
 *   logo-512.png, favicon.png, apple-touch-icon.png, blasti-icon.png) — they
 *   live OUTSIDE uploads/ and are never touched.
 * • The preset/basic registration avatars are SVG data URIs generated in code
 *   (apps/web/src/components/auth/register-form.tsx) — nothing on disk to keep.
 * • apps/api/uploads/app-versions/ (uploaded desktop app binaries) unless
 *   --wipe-app-binaries is passed.
 * • Source code, .env files, prisma schema.
 *
 * ⚠️  STOP the BLASTI apps first (bun run dev and the Electron desktop app):
 *     files held open by a running process cannot be deleted (EBUSY on Windows).
 *     Afterwards: restart bun run dev, and FULLY restart the desktop app — it
 *     will show the login screen. Browser sessions are invalidated too (the
 *     accounts behind them no longer exist) — just log in again as admin.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const args = process.argv.slice(2);
const has = (flag: string) => args.includes(flag);

const CLOUD_ONLY = has('--cloud-only');
const DESKTOP_ONLY = has('--desktop-only');
const FILES_ONLY = has('--files-only');
const WIPE_APP_BINARIES = has('--wipe-app-binaries');
const ASSUME_YES = has('-y') || has('--yes');

const doCloudDb = !DESKTOP_ONLY && !FILES_ONLY;
const doCloudFiles = !DESKTOP_ONLY;
const doDesktop = !CLOUD_ONLY && !FILES_ONLY;

const DB_FILE = path.join(ROOT, 'packages', 'db', 'data', 'custom.db');
const API_UPLOADS = path.join(ROOT, 'apps', 'api', 'uploads');
const WEB_LEGACY_UPLOADS = path.join(ROOT, 'apps', 'web', 'public', 'uploads');
const TMP_LEGACY_APP_UPLOADS = path.join(os.tmpdir(), 'blasti-app-uploads');
const SCHEMA_STAMP = path.join(ROOT, 'packages', 'db', '.schema-stamp');

const failures: string[] = [];

function rm(target: string, label: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
    console.log(`   🗑  ${label}`);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
    const hint = code === 'EBUSY' || code === 'EPERM'
      ? ' — file is locked; close the running BLASTI app and re-run the command'
      : '';
    failures.push(`${label} → ${target} (${code})`);
    console.warn(`   ⚠️  ${label} — ${code}${hint}`);
  }
}

function wipeChildren(dir: string, label: string, keep: Set<string> = new Set()): void {
  if (!fs.existsSync(dir)) {
    console.log(`   –  ${label} (nothing to delete)`);
    return;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (keep.has(entry)) continue;
    rm(path.join(dir, entry), `${label}/${entry}`);
  }
}

function desktopDataDirs(): string[] {
  let base: string | undefined;
  if (process.platform === 'win32') {
    base = process.env.APPDATA; // C:\Users\<user>\AppData\Roaming
  } else if (process.platform === 'darwin') {
    base = path.join(os.homedir(), 'Library', 'Application Support');
  } else {
    base = path.join(os.homedir(), '.config');
  }
  if (!base) return [];
  return [
    path.join(base, '@blasti', 'desktop'), // dev:  electron . (package name)
    path.join(base, 'BLASTI'), // packaged: productName "BLASTI"
  ];
}

function runBunStep(stepArgs: string[], cwd: string, label: string): void {
  console.log(`\n▶ ${label} …`);
  const dbUrl = `file:${DB_FILE.replace(/\\/g, '/')}`;
  const result = Bun.spawnSync({
    cmd: [process.execPath, ...stepArgs],
    cwd,
    env: { ...process.env, DATABASE_URL: dbUrl },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  if (!result.success || result.exitCode !== 0) {
    console.error(`\n❌ "${label}" failed (exit ${result.exitCode}).`);
    console.error('   The database files were deleted but the fresh schema/seed could not be applied.');
    console.error('   Fix the error above, then run:  bun run db:push && bun run db:seed');
    process.exit(1);
  }
}

console.log('════════════════════════════════════════════════════════════');
console.log('  BLASTI MULTI — FULL RESET');
console.log('  Permanently deletes ALL databases, tokens, sessions and');
console.log('  uploaded files. Only the super-admin account is recreated.');
if (doCloudDb) console.log('  • cloud database (packages/db/data/custom.db)');
if (doCloudFiles) console.log('  • uploaded files (apps/api/uploads + apps/web/public/uploads)');
if (doDesktop) console.log('  • desktop local data (local DB + files + stored session)');
console.log('════════════════════════════════════════════════════════════');

if (!ASSUME_YES) {
  console.log('\nStarting in 5 seconds — press Ctrl+C to abort…');
  for (let i = 5; i >= 1; i--) {
    await Bun.sleep(1000);
    console.log(`   ${i}…`);
  }
}
console.log('');

// ─── 1. Cloud database ─────────────────────────────────────────────────────────
if (doCloudDb) {
  console.log('🗄  [1/3] Cloud database');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    rm(`${DB_FILE}${suffix}`, `packages/db/data/custom.db${suffix}`);
  }
  // Defensive: force dev-api.cjs to re-run `prisma db push` on next start.
  rm(SCHEMA_STAMP, 'packages/db/.schema-stamp');

  runBunStep(['run', 'db:push'], path.join(ROOT, 'packages', 'db'), 'prisma db push (recreate empty schema)');
  runBunStep(['run', 'db:seed'], path.join(ROOT, 'packages', 'db'), 'fresh-start seed (super admin only)');
}

// ─── 2. Uploaded user files ────────────────────────────────────────────────────
if (doCloudFiles) {
  console.log('\n📁 [2/3] Uploaded files (cloud)');
  wipeChildren(
    API_UPLOADS,
    'apps/api/uploads',
    WIPE_APP_BINARIES ? new Set() : new Set(['app-versions']),
  );
  rm(WEB_LEGACY_UPLOADS, 'apps/web/public/uploads (legacy uploads)');
  rm(TMP_LEGACY_APP_UPLOADS, `${TMP_LEGACY_APP_UPLOADS} (legacy app-binary fallback)`);
  if (!WIPE_APP_BINARIES) {
    console.log('   💟 kept apps/api/uploads/app-versions (app binaries — use --wipe-app-binaries to remove)');
  }
}

// ─── 3. Desktop local data ─────────────────────────────────────────────────────
if (doDesktop) {
  console.log('\n🖥  [3/3] Desktop local data');
  const dirs = desktopDataDirs();
  if (dirs.length === 0) {
    console.log('   –  could not resolve the OS app-data directory (skipped)');
  }
  let foundAny = false;
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    foundAny = true;
    console.log(`   • ${dir}`);
    rm(path.join(dir, 'blasti-local'), 'blasti-local (local database)');
    rm(path.join(dir, 'blasti-files'), 'blasti-files (local file store)');
    rm(path.join(dir, 'blasti-auth.json'), 'blasti-auth.json (stored session)');
  }
  if (!foundAny) console.log('   –  no desktop data directories found (nothing to delete)');
  rm(path.join(os.homedir(), '.blasti', 'local'), '~/.blasti/local (legacy standalone DB)');
  rm(path.join(os.homedir(), '.blasti', 'files'), '~/.blasti/files (legacy standalone files)');
}

// ─── Summary ───────────────────────────────────────────────────────────────────
console.log('\n════════════════════════════════════════════════════════════');
if (failures.length > 0) {
  console.log(`⚠️  RESET FINISHED WITH ${failures.length} LOCKED/FAILED ITEM(S):`);
  for (const f of failures) console.log(`   • ${f}`);
  console.log('   Close every BLASTI app (web dev server + Electron desktop) and');
  console.log('   re-run the command to finish the reset.');
  process.exit(1);
}
console.log('✅ RESET COMPLETE — the platform is FRESH.');
console.log('');
console.log('   👤 Only account:  admin / admin123  (admin@blasti.dz)');
console.log('');
console.log('   Next steps:');
console.log('   1. Start/restart the services:  bun run dev');
console.log('   2. FULLY restart the Electron desktop app → it shows the login screen');
console.log('   3. In browsers, old sessions are invalid — log in again as admin');
console.log('   4. Register new agency/customer accounts from scratch');
console.log('════════════════════════════════════════════════════════════');
