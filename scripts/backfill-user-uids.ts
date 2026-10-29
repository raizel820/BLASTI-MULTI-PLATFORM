/**
 * BLASTI UID backfill (UID-0.6.14)
 * ────────────────────────────────
 * Standalone companion to the API's boot-time backfill: assigns an immutable
 * UID ({TYPE}-{WILAYA}-{SEQ}, e.g. "CU-16-00042") to every account that has
 * none. SUPER_ADMIN accounts are intentionally excluded. Safe to run any
 * number of times — existing UIDs are never touched and the monotonic
 * UidCounter guarantees numbers are NEVER reused, even for deleted accounts.
 *
 * The API already runs this automatically on every (re)boot
 * (apps/api/src/index.ts → ensureUserUids); this script exists for ops
 * workflows that want to run it explicitly, e.g. right after a VPS rebuild
 * or a manual db:seed, without waiting for/restarting the API:
 *
 *     bun run db:backfill-uids
 *     (or) bun scripts/backfill-user-uids.ts
 */

import { ensureUserUids } from '../apps/api/src/lib/uid-generator'

async function main() {
  const started = Date.now()
  console.log('[UID] backfill starting — assigning UIDs to accounts without one…')
  const { assigned } = await ensureUserUids()
  console.log(`[UID] backfill complete: ${assigned} account(s) got a UID in ${Date.now() - started}ms`)
  process.exit(0)
}

main().catch((err) => {
  console.error('[UID] backfill failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
