/**
 * BLASTI WatermelonDB Migrations
 *
 * Used when the schema version is bumped. Each migration step adds columns
 * or tables for an incremental schema upgrade.
 *
 * To add a new column in the future:
 *   1. Bump `schema.version` in schema.ts
 *   2. Add a new migration step here with `schema.addColumns({ ... })`
 */

import { schemaMigrations } from '@nozbe/watermelondb/Schema/migrations';

export const migrations = schemaMigrations({
  migrations: [
    {
      // Schema v2 — no changes from v1 (initial schema starts at v1, migrations start at v2)
      toVersion: 2,
      steps: [
        // Empty — future column additions will go here
      ],
    },
  ],
});
