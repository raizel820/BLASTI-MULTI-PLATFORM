import { db } from '@blasti/db';

/**
 * Idempotent bootstrap seed — SAFE to run on every deployment start.
 *
 * Unlike seed.ts (the full-reset seed, which WIPES everything first), this
 * script only seeds a brand-new/empty database. It is what the Docker
 * deployment runs on every `docker compose up` (ops/docker-compose.yml →
 * "migrate" service): first boot seeds admin + the fresh agency account,
 * every later boot is a no-op so user data is never touched.
 *
 * To force a full reset on the server, use the WipeStorage flow in the
 * admin console or run `bun run reset:all --cloud-only` (locally).
 */
async function main() {
  const userCount = await db.user.count();
  if (userCount > 0) {
    console.log(`[seed-if-empty] Database already has ${userCount} user(s) — skipping seed (data preserved).`);
    return;
  }
  console.log('[seed-if-empty] Empty database detected — running the fresh-start seed…');
  // seed.ts only self-executes when run directly (import.meta.main); when
  // imported it exports `seed()` — AWAit it fully before disconnecting.
  // (Awaiting just the dynamic import used to race db.$disconnect() below,
  // killing the engine mid-seed → "Response from the Engine was empty".)
  const { seed } = await import('./seed');
  await seed();
}

main()
  .catch((e) => {
    console.error('[seed-if-empty] Failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
