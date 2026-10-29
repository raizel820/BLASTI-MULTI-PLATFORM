/**
 * normalize-agency-categories.mjs — Task A (R-6) one-time data migration.
 *
 * Reduces legacy Agency.category values to the 4 product agency types:
 *   doctor / clinic / law office / barber  (stored as DOCTOR/CLINIC/LAW_FIRM/BARBER)
 *
 * Mapping:
 *   HOSPITAL, DENTAL_CLINIC, LABORATORY, PHARMACY, VETERINARY, OTHER → CLINIC
 *   BEAUTY_SALON                                                     → BARBER
 *   NOTARY                                                           → LAW_FIRM
 *   (BANK, GOVERNMENT, … and any other legacy value are left untouched —
 *    they render humanized with a fallback icon until the owner re-picks;
 *    forcing them into a wrong industry would corrupt production data.)
 *
 * Usage:
 *   bun run --filter @blasti/db exec scripts/normalize-agency-categories.mjs
 *   (or) DATABASE_URL=... bun packages/db/scripts/normalize-agency-categories.mjs
 *
 * Idempotent: rows already holding a target value are never touched.
 */
import { PrismaClient } from '@prisma/client';

const MAP = {
  // Health-adjacent cluster → CLINIC
  HOSPITAL: 'CLINIC',
  DENTAL_CLINIC: 'CLINIC',
  LABORATORY: 'CLINIC',
  PHARMACY: 'CLINIC',
  VETERINARY: 'CLINIC',
  OTHER: 'CLINIC',
  // Beauty cluster → BARBER
  BEAUTY_SALON: 'BARBER',
  // Legal-adjacent → LAW_FIRM
  NOTARY: 'LAW_FIRM',
};

const prisma = new PrismaClient();

async function main() {
  let total = 0;
  for (const [from, to] of Object.entries(MAP)) {
    const res = await prisma.agency.updateMany({
      where: { category: from },
      data: { category: to },
    });
    if (res.count > 0) console.log(`  ${from} → ${to}: ${res.count} agency(ies)`);
    total += res.count;
  }
  const remaining = await prisma.agency.groupBy({
    by: ['category'],
    _count: { _all: true },
  });
  console.log(`Normalized ${total} agency(ies). Category distribution now:`);
  for (const row of remaining) {
    console.log(`  ${row.category}: ${row._count._all}`);
  }
}

main()
  .catch((e) => {
    console.error('normalize-agency-categories FAILED:', e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
