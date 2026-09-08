# BLASTI Database Separation: Local SQLite ↔ Cloud PostgreSQL

## Executive Summary

**Goal:** Split the monorepo's single SQLite Prisma schema into a two-database architecture:
- **Cloud API** (`apps/api`) → **PostgreSQL** (via Prisma + `@prisma/client`)
- **Desktop local API** (`apps/desktop/local-api`) → **SQLite** (via Prisma or better-sqlite3)

**Why:** The cloud API currently uses SQLite (single-writer lock, no concurrent connections, no replication). PostgreSQL provides connection pooling, row-level locking, streaming replication, and proper `SERIAL`/`BIGSERIAL` for monotonic sync cursors. The desktop must remain SQLite for zero-config offline operation.

---

## Current State (Audit Findings)

| Finding | Detail |
|---|---|
| Schema file | `packages/db/prisma/schema.prisma` — single file, `provider = "sqlite"` |
| Cloud API DB | SQLite at `packages/db/data/custom.db` (Vercel/node) |
| Desktop local DB | SQLite at `~/.blasti/local/local.db` (Electron) |
| Models total | 38 |
| Syncable models | 18 (Agency, Service, Branch, Counter, Reservation, Notification, QueueSettings, AgencyStaff, Review, User, SmsSettings, PaymentSettings, Announcement, GlobalAnnouncement, Transaction, SubscriptionPlan, PlanFeature, Favorite, FAQ) |
| Models with `syncVersion` | 9 (Agency, AgencyStaff, Service, QueueSettings, Notification, Announcement, Review, Branch, Counter) |
| Models missing `syncVersion` | 10 (Reservation, User, SmsSettings, PaymentSettings, GlobalAnnouncement, Transaction, SubscriptionPlan, PlanFeature, Favorite, FAQ) |
| SyncChange table | ❌ Does not exist |
| SyncMutation table | ❌ Does not exist |
| Monotonic sync cursor | ❌ No sequence/serial column |
| Desktop `$transaction` | ❌ Not used in local-api |
| Ghost Delete Trap | ✅ Exists in `packages/db/index.ts` (Prisma extension) |
| Sync routes | `apps/api/src/routes/sync.ts` (pull/push via `updatedAt` timestamp) |
| Desktop sync engine | `apps/desktop/local-api/sync-service.js` (version-based incremental) |

---

## Architecture Target

```
┌──────────────────────────────┐     ┌──────────────────────────────────────┐
│  DESKTOP (Electron)          │     │  CLOUD (Vercel / Node)               │
│                              │     │                                      │
│  ┌───────────────────────┐   │     │  ┌───────────────────────────────┐   │
│  │ local-api (Hono)      │   │     │  │ api (Hono)                   │   │
│  │  ↕ PrismaClient       │   │     │  │  ↕ PrismaClient              │   │
│  └───────────┬───────────┘   │     │  └───────────┬───────────────────┘   │
│              │               │     │              │                       │
│  ┌───────────▼───────────┐   │     │  ┌───────────▼───────────────────┐   │
│  │ SQLite (local.db)     │   │     │  │ PostgreSQL (Supabase/RDS)    │   │
│  │ - All 38 models       │   │     │  │ - All 38 models              │   │
│  │ - SyncMutation[]      │   │     │  │ - SyncChange[] (INSERT-only) │   │
│  │ - _syncCursor BIGINT  │   │     │  │ - _syncCursor BIGSERIAL      │   │
│  └───────────────────────┘   │     │  └───────────────────────────────┘   │
│              │               │     │              ▲                       │
│  ┌───────────▼───────────┐   │     │              │                       │
│  │ sync-service.js       │───┼─────┼──► /api/sync/pull  (cursor-based) │
│  │ (push mutations,      │───┼─────┼──► /api/sync/push  (mutation WAL) │
│  │  pull changes)        │   │     │                                      │
│  └───────────────────────┘   │     │                                      │
└──────────────────────────────┘     └──────────────────────────────────────┘
```

---

## Phase 0: Add Missing `syncVersion` + `syncedAt` to All Syncable Models

**Goal:** Ensure every syncable model has `syncVersion Int @default(0)` and `syncedAt DateTime?` on the cloud schema, so incremental sync can track versions.

**Duration:** 1 day  
**Risk:** Low (additive-only migration)

### Files to Modify

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | Add `syncVersion Int @default(0)` + `syncedAt DateTime?` to 10 models |

### Models Needing `syncVersion` + `syncedAt`

```prisma
# Reservation — already has syncedAt, ADD syncVersion
model Reservation {
  # ... existing fields ...
  syncedAt     DateTime?    # already exists
  syncVersion  Int          @default(0)   # ADD
}

# User — ADD both
model User {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# SmsSettings — ADD both
model SmsSettings {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# PaymentSettings — ADD both
model PaymentSettings {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# GlobalAnnouncement — ADD both
model GlobalAnnouncement {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# Transaction — ADD both
model Transaction {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# SubscriptionPlan — ADD both
model SubscriptionPlan {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# PlanFeature — ADD both
model PlanFeature {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# Favorite — ADD both
model Favorite {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}

# FAQ — ADD both
model FAQ {
  # ... existing fields ...
  syncVersion  Int          @default(0)   # ADD
  syncedAt     DateTime?                  # ADD
}
```

### Verification
```bash
cd packages/db && npx prisma db push
# Then grep for all syncable models having syncVersion
```

---

## Phase 1: Add Sync Infrastructure Tables (Cloud-Side)

**Goal:** Create `SyncChange` (append-only changelog) and `SyncCursor` (monotonic sequence) tables on the cloud database. These enable cursor-based incremental pull instead of timestamp-based pull.

**Duration:** 2 days  
**Depends on:** Phase 0  
**Risk:** Medium (new tables + triggers, no data changes)

### Files to Create

| File | Purpose |
|---|---|
| `packages/db/prisma/migrations/YYYYMMDDHHMMSS_add_sync_infrastructure/migration.sql` | Migration for SyncChange + SyncCursor |
| `packages/db/src/sync-trigger.ts` | SQL trigger generator for auto-inserting into SyncChange |
| `packages/db/src/sync-cursor.ts` | Helper to advance the monotonic cursor |

### Files to Modify

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | Add `SyncChange` and `SyncCursor` models |

### Schema Additions

```prisma
/// Append-only changelog for incremental sync.
/// Every INSERT/UPDATE/DELETE on a syncable model writes a row here.
/// Clients pull changes WHERE cursor > lastCursor.
model SyncChange {
  id          Int       @id @default(autoincrement())
  cursor      Int       @unique  /// Monotonic sequence number
  modelName   String    /// e.g. "Reservation", "Agency"
  recordId    String    /// The record's @id (cuid)
  operation   String    /// "CREATE" | "UPDATE" | "DELETE"
  agencyId    String?   /// Pre-indexed for scoped pull
  createdAt   DateTime  @default(now())

  @@index([cursor])
  @@index([modelName, cursor])
  @@index([agencyId, cursor])
}

/// Monotonic cursor sequence. Single row. Updated atomically.
model SyncCursor {
  id        Int   @id @default(1)
  value     Int   @default(0)

  @@map("_sync_cursor")
}
```

### Sync Trigger Logic

For each of the 18 syncable models, create AFTER INSERT/UPDATE/DELETE triggers that atomically:
1. Advance `_sync_cursor.value` via `UPDATE _sync_cursor SET value = value + 1 RETURNING value`
2. INSERT into `SyncChange` with the new cursor value

```sql
-- Example for Reservation
CREATE OR REPLACE FUNCTION _sync_reservation_insert() RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO SyncChange (cursor, "modelName", "recordId", operation, "agencyId", "createdAt")
  SELECT v, 'Reservation', NEW.id, 'CREATE', NEW."agencyId", NOW()
  FROM (UPDATE "_sync_cursor" SET value = value + 1 RETURNING value) AS v;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER _trg_reservation_after_insert
  AFTER INSERT ON Reservation
  FOR EACH ROW EXECUTE FUNCTION _sync_reservation_insert();
```

**Note:** These triggers are PostgreSQL-specific. The local SQLite does NOT need them — the desktop pushes mutations via `SyncMutation` WAL instead.

### Files to Create — Trigger Generator

`packages/db/src/sync-trigger.ts`:
```typescript
// Generates CREATE TRIGGER SQL for all 18 syncable models
// Called by migration or by a setup script at server boot

const SYNCABLE_MODELS = [
  'Agency', 'Service', 'Branch', 'Counter', 'Reservation',
  'Notification', 'QueueSettings', 'AgencyStaff', 'Review',
  'User', 'SmsSettings', 'PaymentSettings', 'Announcement',
  'GlobalAnnouncement', 'Transaction', 'SubscriptionPlan',
  'PlanFeature', 'Favorite', 'FAQ',
]

// For each model, generate INSERT/UPDATE/DELETE trigger functions
// AgencyId extraction: model → agencyId column (or NULL for global models)
```

### Cloud API Sync Route Upgrade

| File | Change |
|---|---|
| `apps/api/src/routes/sync.ts` | Replace timestamp-based pull with cursor-based pull |

**New pull protocol:**
```typescript
// POST /api/sync/pull
// Request:  { lastCursor: number, agencyId?: string }
// Response: { changes: Record<ModelName, { created, updated, deleted }>, cursor: number }

app.post('/pull', async (c) => {
  const { lastCursor = 0, agencyId } = await c.req.json()

  const changes = await db.syncChange.findMany({
    where: {
      cursor: { gt: lastCursor },
      ...(agencyId ? { agencyId } : {}),
    },
    orderBy: { cursor: 'asc' },
    take: 5000,  // Batch limit
  })

  // Group changes by modelName and operation
  // For CREATE/UPDATE: fetch the full record
  // For DELETE: just return the recordId

  const maxCursor = changes.length > 0
    ? changes[changes.length - 1].cursor
    : lastCursor

  return { changes: groupedChanges, cursor: maxCursor }
})
```

---

## Phase 2: Add SyncMutation Table (Local-Side Desktop)

**Goal:** The desktop local SQLite needs a WAL (Write-Ahead Log) of pending mutations that haven't been pushed to the cloud yet. This replaces the in-memory pending mutations approach in the current sync-service.js.

**Duration:** 1 day  
**Depends on:** Phase 0  
**Risk:** Low (additive, local-only)

### Files to Modify

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | Add `SyncMutation` model |
| `apps/desktop/local-api/index.js` | Use `SyncMutation` for mutation WAL instead of in-memory |
| `apps/desktop/local-api/sync-service.js` | Push from `SyncMutation`, mark completed/failed |

### Schema Addition

```prisma
/// Local-only: pending mutations to push to cloud.
/// Created by local CRUD operations when offline.
/// Replayed in order during sync push phase.
model SyncMutation {
  id          String    @id @default(cuid())
  cursor      Int       @unique  /// Monotonic local sequence
  modelName   String
  recordId    String
  operation   String    /// "CREATE" | "UPDATE" | "DELETE"
  data        String    /// JSON payload of the mutation
  agencyId    String?
  status      String    @default("PENDING")  /// PENDING | PUSHED | FAILED | CONFLICT
  error       String?   /// Error message if FAILED
  retries     Int       @default(0)
  createdAt   DateTime  @default(now())
  pushedAt    DateTime?

  @@index([status, cursor])
  @@map("_sync_mutation")
}
```

### Local SQLite: Monotonic Cursor Sequence

In SQLite, there's no `BIGSERIAL`. Use a metadata table:

```sql
CREATE TABLE IF NOT EXISTS _local_sync_cursor (
  id    INTEGER PRIMARY KEY DEFAULT 1,
  value INTEGER NOT NULL DEFAULT 0
);
INSERT OR IGNORE INTO _local_sync_cursor (id, value) VALUES (1, 0);
```

### Desktop CRUD Integration

Every local write (create/update/delete on a syncable model) must also:
1. Advance `_local_sync_cursor.value`
2. INSERT into `_sync_mutation` with the mutation JSON

This replaces the in-memory `_pendingMutations` array currently used in `sync-service.js`.

### Files to Create

| File | Purpose |
|---|---|
| `apps/desktop/local-api/lib/mutation-wal.js` | Mutation WAL manager (append, mark pushed, cleanup) |

---

## Phase 3: Split Prisma Schema into Base + Provider Overlays

**Goal:** A single `schema.prisma` cannot serve both SQLite and PostgreSQL (different provider, different features like `@default(autoincrement())`, different index syntax). We need a schema that can be rendered for either provider.

**Duration:** 3 days  
**Depends on:** Phase 1, Phase 2  
**Risk:** HIGH (schema restructuring, all generated types change)

### Strategy: Prisma Multi-Config with Schema Composition

Prisma 6.x does not support native multi-provider schemas. The recommended approach is **schema composition with a build step**:

```
packages/db/
  prisma/
    schema.base.prisma       ← All 38 models, no datasource block
    overrides.sqlite.prisma  ← datasource + generator + SQLite-specific overrides
    overrides.postgresql.prisma ← datasource + generator + PostgreSQL-specific overrides
    schema.prisma            ← GENERATED (composed output, gitignored for cloud)
  prisma-local/
    schema.prisma            ← GENERATED (SQLite overlay)
```

**Build script** (`packages/db/scripts/compose-schema.ts`):
```typescript
// 1. Parse schema.base.prisma
// 2. Apply provider-specific overrides (datasource, enum handling, index syntax)
// 3. Output to packages/db/prisma/schema.prisma (for cloud PG)
// 4. Output to packages/db/prisma-local/schema.prisma (for local SQLite)
```

### Files to Create

| File | Purpose |
|---|---|
| `packages/db/prisma/schema.base.prisma` | Base schema with all 38 models (no datasource block) |
| `packages/db/prisma/overrides.sqlite.prisma` | SQLite datasource + generator + overrides |
| `packages/db/prisma/overrides.postgresql.prisma` | PostgreSQL datasource + generator + overrides |
| `packages/db/scripts/compose-schema.ts` | Schema composition<unk>composer build script |
| `packages/db/prisma-local/schema.prisma` | Generated SQLite schema (gitignored) |

### Files to Modify

| File | Change |
|---|---|
| `packages/db/package.json` | Add `compose-schema` script, separate `db:generate:cloud` / `db:generate:local` |
| `packages/db/index.ts` | Detect provider from `DATABASE_URL` prefix, export correct client |
| `.gitignore` | Add `packages/db/prisma-local/schema.prisma` |

### Key Differences Between Providers

| Feature | SQLite | PostgreSQL |
|---|---|---|
| `datasource provider` | `sqlite` | `postgresql` |
| `@default(autoincrement())` | Not supported on `Int` | Supported (for SyncChange.id, SyncChange.cursor) |
| DateTime storage | TEXT (ISO string) | TIMESTAMP |
| Boolean storage | INTEGER 0/1 | BOOLEAN |
| JSON fields | String + `@default("{}")` | Can use `Json` type |
| `@@map` table names | Not needed | Optional (snake_case convention) |
| Enum handling | String-mapped | Native ENUM or String |
| Triggers | `CREATE TRIGGER` (simple) | `CREATE FUNCTION + TRIGGER` (plpgsql) |
| Connection pooling | N/A | PgBouncer / Supavisor |

### `packages/db/index.ts` Refactor

```typescript
// Detect provider from DATABASE_URL
const isPostgres = process.env.DATABASE_URL?.startsWith('postgresql://') || 
                   process.env.DATABASE_URL?.startsWith('postgres://')

if (isPostgres) {
  // Import from the PostgreSQL-generated client
  const { PrismaClient } = await import('./generated/pg-client')
  // ... create client with PostgreSQL connection
} else {
  // Import from the SQLite-generated client
  const { PrismaClient } = await import('./generated/sqlite-client')
  // ... create client with SQLite connection (existing behavior)
}
```

### Alternative: Dual Package Approach (Simpler, Recommended)

Instead of runtime provider detection, split into two packages:

| Package | Provider | Generated Client | Used By |
|---|---|---|---|
| `@blasti/db` | PostgreSQL | `packages/db/prisma/schema.prisma` | `apps/api` (cloud) |
| `@blasti/db-local` | SQLite | `packages/db-local/prisma/schema.prisma` | `apps/desktop/local-api` |

**Files to Create:**

| File | Purpose |
|---|---|
| `packages/db-local/prisma/schema.prisma` | Copy of schema with `provider = "sqlite"` |
| `packages/db-local/index.ts` | Local DB client singleton |
| `packages/db-local/package.json` | Separate package config |

**Files to Modify:**

| File | Change |
|---|---|
| `package.json` | Add `packages/db-local` to workspaces |
| `apps/desktop/local-api/lib/db.js` | Import from `@blasti/db-local` instead of shared schema path |
| `packages/db/prisma/schema.prisma` | Change `provider = "postgresql"` |

This approach is cleaner because:
- No runtime provider detection needed
- No schema composition build step
- Each package has its own `prisma generate` output
- Cloud and local can evolve independently

---

## Phase 4: Migrate Cloud API to PostgreSQL

**Goal:** Switch `apps/api` from SQLite to PostgreSQL. This is the highest-impact change.

**Duration:** 3-5 days  
**Depends on:** Phase 3  
**Risk:** HIGH (data migration, connection pooling, query differences)

### Step 4a: Provision PostgreSQL

**Options (pick one):**
1. **Supabase** (managed Postgres + auth + realtime, free tier: 500MB)
2. **Neon** (serverless Postgres, branching, free tier: 3GB)
3. **AWS RDS Postgres** (production-grade, requires ops)
4. **Docker Postgres** (local dev only)

**Recommended for dev:** Supabase or Neon (zero-config, generous free tier)  
**Recommended for prod:** AWS RDS or Neon (connection pooling built-in)

### Step 4b: Update Schema for PostgreSQL

`packages/db/prisma/schema.prisma`:
```prisma
datasource db {
  provider  = "postgresql"
  url       = env("DATABASE_URL")
  directUrl = env("DIRECT_URL")  // For migrations (Neon/Supabase)
}

generator client {
  provider = "prisma-client-js"
}
```

### Step 4c: Handle SQLite → PostgreSQL Incompatibilities

| Issue | Fix |
|---|---|
| `DateTime` stored as TEXT | PostgreSQL stores as `TIMESTAMP(3)` — Prisma handles automatically |
| `Boolean` stored as `INTEGER` | PostgreSQL uses `BOOLEAN` — Prisma handles automatically |
| `String` with JSON defaults | Change to `Json` type where appropriate (or keep as `String`) |
| `@default(autoincrement())` on `Int` | Now works! Use for `SyncChange.id` and `SyncChange.cursor` |
| SQLite `PRAGMA` calls | Remove `setupSQLitePragmas()` call from API startup |
| Ghost Delete Trap Prisma 5/6 detection | PostgreSQL works with Prisma 6.x extensions — simplify |
| `file:` URL in `DATABASE_URL` | Change to `postgresql://user:pass@host:5432/dbname` |

### Files to Modify

| File | Change |
|---|---|
| `packages/db/prisma/schema.prisma` | `provider = "postgresql"` |
| `packages/db/index.ts` | Remove SQLite URL resolution logic, remove PRAGMA setup, add PostgreSQL connection pooling config |
| `apps/api/.env.example` | Change `DATABASE_URL` to PostgreSQL format |
| `.env.example` | Change `DATABASE_URL` to PostgreSQL format |
| `apps/api/src/index.ts` | Remove `setupSQLitePragmas()` call |
| `apps/api/src/routes/sync.ts` |.Use cursor-based pull (from Phase 1) |

### Step 4d: Data Migration (SQLite → PostgreSQL)

**Migration script:**

| File | Purpose |
|---|---|
| `scripts/migrate-sqlite-to-pg.ts` | Read all data from SQLite, write to PostgreSQL |

```typescript
// 1. Read all records from SQLite (old custom.db)
// 2. For each model, insert into PostgreSQL via Prisma
// 3. Handle ID conflicts, relation ordering (parents before children)
// 4. Set SyncChange cursor to max value (so clients don't re-pull existing data)
// 5. Verify row counts match
```

**Model insertion order (respecting foreign keys):**
1. User (no deps)
2. SubscriptionPlan → PlanFeature
3. Agency (depends on User, SubscriptionPlan)
4. Branch → Counter → AgencyStaff
5. Service → QueueSettings
6. Reservation → Transaction
7. Notification → Favorite → Review
8. SmsSettings → PaymentSettings → SmsPurchase
9. Announcement → GlobalAnnouncement → FAQ
10. All remaining independent models

### Step 4e: Connection Pooling

For serverless (Vercel), use connection pooling:

```typescript
// packages/db/index.ts
new PrismaClient({
  datasourceUrl: process.env.DATABASE_URL,
  // @ts-ignore — Prisma acceleration
  pool: {
    min: 2,
    max: 10,
  },
})
```

Or use **Prisma Accelerate** / **PgBouncer** for Vercel serverless functions.

---

## Phase 5: Upgrade Desktop Sync Engine to Cursor-Based

**Goal:** Replace the timestamp-based sync in `sync-service.js` with cursor-based sync using `SyncChange` (cloud) and `SyncMutation` (local).

**Duration:** 2 days  
**Depends on:** Phase 1, Phase 2, Phase 4  
**Risk:** Medium (rewrite of sync core logic)

### Files to Modify

| File | Change |
|---|---|
| `apps/desktop/local-api/sync-service.js` | Replace `updatedAt`-based pull with cursor-based; replace in-memory mutations with `SyncMutation` WAL |

### New Sync Protocol

```
┌─────────────┐                              ┌─────────────┐
│  DESKTOP    │                              │   CLOUD     │
│  (SQLite)   │                              │ (PostgreSQL) │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  1. POST /api/sync/pull                    │
       │     { lastCursor: 12345, agencyId }        │
       │───────────────────────────────────────────►│
       │                                            │
       │  2. Response:                              │
       │     { changes: {...}, cursor: 12890 }      │
       │◄───────────────────────────────────────────│
       │                                            │
       │  3. Apply changes to local SQLite          │
       │     (upsert creates/updates, apply deletes) │
       │     Update local _sync_meta cursor=12890   │
       │                                            │
       │  4. POST /api/sync/push                    │
       │     { mutations: [...from SyncMutation] }   │
       │───────────────────────────────────────────►│
       │                                            │
       │  5. Response:                              │
       │     { results: [{id, status, cursor}] }     │
       │◄───────────────────────────────────────────│
       │                                            │
       │  6. Mark SyncMutation rows as PUSHED       │
       │     Update local cursor to max returned     │
       │                                            │
```

### Sync Push Route Upgrade

| File | Change |
|---|---|
| `apps/api/src/routes/sync.ts` | New push endpoint that accepts mutations array, applies them transactionally, returns per-mutation results |

```typescript
// POST /api/sync/push
// Request: { mutations: SyncMutation[] }
// Response: { results: { id: string, status: "APPLIED"|"CONFLICT"|"REJECTED", cursor?: number }[] }

app.post('/push', async (c) => {
  const { mutations } = await c.req.json()

  return db.$transaction(async (tx) => {
    const results = []
    for (const mut of mutations) {
      try {
        // Apply mutation to the target model
        // SyncChange trigger auto-fires, advancing cursor
        const result = await applyMutation(tx, mut)
        results.push({ id: mut.id, status: 'APPLIED', cursor: result.cursor })
      } catch (err) {
        if (isConflictError(err)) {
          results.push({ id: mut.id, status: 'CONFLICT' })
        } else {
          results.push({ id: mut.id, status: 'REJECTED', error: err.message })
        }
      }
    }
    return { results }
  })
})
```

### Conflict Resolution (Preserved from Current Logic)

The existing `sync-service.js` already has:
- `CLOUD_WINS_MODELS`: Reservation, Transaction, SubscriptionPlan, PlanFeature, PaymentSettings
- `LAST_WRITE_WINS_MODELS`: Agency, QueueSettings, SmsSettings, Announcement, GlobalAnnouncement, FAQ

This logic should be preserved in the cloud push handler.

---

## Phase 6: Desktop `$transaction` Support

**Goal:** The desktop local-api currently doesn't use Prisma `$transaction`, which means multi-step operations (e.g., call next ticket → update QueueSettings → create Notification) are not atomic.

**Duration:** 1 day  
**Depends on:** Phase 3  
**Risk:** Low (additive, only local)

### Files to Modify

| File | Change |
|---|---|
| `apps/desktop/local-api/lib/db.js` | Add `$transaction` wrapper around PrismaClient |
| `apps/desktop/local-api/index.js` | Use `$transaction` for multi-step queue operations |

### Implementation

```javascript
// In lib/db.js, after creating localDb:
localDb.$transaction = async function (fn) {
  // Prisma SQLite supports interactive transactions
  return baseClient.$transaction(fn, {
    maxWait: 5000,
    timeout: 10000,
  })
}
```

### Queue Operations Needing Transactions

These local-api endpoints must be wrapped in `$transaction`:

| Endpoint | Operations |
|---|---|
| `POST /api/queue/call-next` | Update Reservation status → update Counter → update QueueSettings → create Notification |
| `POST /api/queue/complete` | Update Reservation → update Counter → update QueueSettings |
| `POST /api/queue/cancel` | Update Reservation → update QueueSettings |
| `POST /api/reservations` | Create Reservation → update QueueSettings.lastIssuedNumber |
| `POST /api/queue/no-show` | Update Reservation → update QueueSettings |

---

## Phase 7: Cleanup & Deprecation Removal

**Goal:** Remove deprecated files, unify the sync architecture, update documentation.

**Duration:** 1 day  
**Depends on:** Phase 5  
**Risk:** Low (cleanup only)

### Files to DELETE

| File | Reason |
|---|---|
| `apps/desktop/cloud-sync.js` | Deprecated (replaced by `local-api/sync-service.js`) |
| `apps/desktop/local-db.js` | Deprecated (replaced by `local-api/lib/db.js`) |

### Files to Modify

| File | Change |
|---|---|
| `apps/desktop/main.js` | Remove references to `cloud-sync.js` and `local-db.js` |
| `apps/desktop/preload.js` | Remove IPC handlers for deprecated modules |
| `packages/core/src/sqlite-adapter.ts` | Evaluate if still needed or if `@blasti/db-local` replaces it |
| `ARCHITECTURE.md` | Update to reflect new two-database architecture |

---

## Phase 8: Testing & Validation

**Goal:** End-to-end validation of the two-database architecture.

**Duration:** 2 days  
**Depends on:** Phase 7  
**Risk:** Low (validation only)

### Test Scenarios

| Scenario | Validation |
|---|---|
| Fresh cloud start | PostgreSQL schema applies, SyncChange triggers created |
| Existing data migration | SQLite → PostgreSQL migration preserves all 38 models |
| Desktop first sync | Empty local DB pulls all agency data from cloud |
| Offline desktop operation | Create/update/delete work locally, mutations logged in SyncMutation |
| Online sync (pull) | Cursor-based pull returns only new changes since last cursor |
| Online sync (push) | Mutations applied to cloud, SyncChange triggers fire, cursors advance |
| Conflict detection | Cloud-wins models reject stale local updates |
| Desktop reconnect after 3+ days | Full resync when `_lastCloudContactAt` > 3 days |
| Schema push on desktop | `prisma db push` works for local SQLite schema |
| Concurrent queue operations | `$transaction` prevents race conditions on local DB |

---

## Dependency Graph

```
Phase 0 (syncVersion fields)
  │
  ├──► Phase 1 (SyncChange + SyncCursor tables) ──► Phase 4 (PostgreSQL migration)
  │                                                    │
  ├──► Phase 2 (SyncMutation WAL) ──────────────────────┤
  │                                                    │
  └──► Phase 3 (Schema split) ──────────────────────────┘
                                                       │
                                            Phase 5 (Cursor-based sync)
                                                       │
                                            Phase 6 ($transaction)
                                                       │
                                            Phase 7 (Cleanup)
                                                       │
                                            Phase 8 (Testing)
```

**Parallelizable:** Phase 0 → (Phase 1 ∥ Phase 2) → Phase 3 → Phase 4 → Phase 5 → (Phase 6 ∥ Phase 7) → Phase 8

---

## Effort Estimate

| Phase | Duration | Risk | Blocker? |
|---|---|---|---|
| Phase 0: syncVersion fields | 1 day | Low | No |
| Phase 1: SyncChange + SyncCursor | 2 days | Medium | No |
| Phase 2: SyncMutation WAL | 1 day | Low | No |
| Phase 3: Schema split |F3 days | **HIGH** | Schema generation |
| Phase 4: PostgreSQL migration | 3-5 days | **HIGH** | Data migration |
| Phase 5: Cursor-based sync | 2 days | Medium | Depends on 1+2+4 |
| Phase 6: $transaction | 1 day | Low | Depends on 3 |
| Phase 7: Cleanup | 1 day | Low | Depends on 5 |
| Phase 8: Testing | 2 days | Low | Depends on all |
| **Total** | **16-18 days** | | |

---

## Quick-Start: Minimal Viable Separation (Phases 0-3 Only)

If full PostgreSQL migration is deferred, Phases 0-3 can be done independently to prepare the schema for future migration. This adds:
- `syncVersion`/`syncedAt` to all 18 syncable models
- `SyncChange` + `SyncCursor` tables
- `SyncMutation` table
- Split schema files ready for dual-provider generation

**Estimated effort:** 5-7 days  
**Benefit:** Schema is "PG-ready" — switching `provider = "postgresql"` and running `prisma migrate` becomes a 1-day task later.
