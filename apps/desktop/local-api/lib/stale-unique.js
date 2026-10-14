'use strict';

/**
 * FK-aware stale-unique-row rescue (desktop local API).
 *
 * FIELD REPORT (mandatory stage "users" failed: P2002 `email`):
 * The cloud re-seeded users — same emails, NEW ids — while the local mirror
 * (fresh install adopting an old-generation DB, or a login-created profile
 * row) still held the previous generation. The record-level rescue tried
 * `model.delete({ where: { id: staleId } })` — but the stale user row was
 * REFERENCED by locally synced children (AgencyStaff, Branch, Reservation,
 * Notification, Transaction.createdBy…), so the delete threw a foreign-key
 * error, the rescue gave up, and the P2002 rethrew → the whole mandatory
 * users stage failed and the workspace never initialized.
 *
 * The fix is ADOPT-then-delete: repoint every child row's FK from the stale
 * id to the incoming (cloud) id first — the children legitimately belong to
 * the same person under their new cloud identity — then delete the stale
 * parent. Same semantics the cloud itself would produce; no data loss.
 *
 * Table names equal Prisma model names in this schema (the raw-SQL upsert
 * fallback already relies on that), so PRAGMA foreign_key_list("<Model>")
 * enumerates every referencing table/column safely.
 */

/** All (table, from-column) pairs referencing `tableName` ([] when none). */
async function listForeignKeys(db, tableName) {
  if (!db || !tableName) return [];
  try {
    const rows = await db.$queryRawUnsafe(`PRAGMA foreign_key_list("${tableName}")`);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return []; // table missing on very old DBs — nothing references it
  }
}

/**
 * Repoint every child row of `staleId` to `newId`, then delete the stale row.
 * Throws when the final delete still fails (caller decides).
 */
async function adoptChildrenThenDelete(db, tableName, staleId, newId) {
  if (!db || !tableName || !staleId || !newId || staleId === newId) return false;
  const fks = await listForeignKeys(db, tableName);
  for (const fk of fks) {
    const childTable = fk && (fk.table || fk['table']);
    const fromCol = fk && (fk.from || fk['from']);
    if (!childTable || !fromCol) continue;
    try {
      await db.$executeRawUnsafe(
        `UPDATE "${childTable}" SET "${fromCol}" = ? WHERE "${fromCol}" = ?`,
        newId, staleId
      );
    } catch (e) {
      // A child table may enforce UNIQUE on the (fk, …) pair — repointing
      // could collide. That child keeps its old parent; the stale row may
      // then be undeletable → the caller's throw surfaces it. Non-fatal here.
      console.warn(`[StaleUnique] Could not repoint ${childTable}.${fromCol}: ${String((e && e.message) || e).substring(0, 120)}`);
    }
  }
  await db.$executeRawUnsafe(`DELETE FROM "${tableName}" WHERE id = ?`, staleId);
  return true;
}

module.exports = { listForeignKeys, adoptChildrenThenDelete };
