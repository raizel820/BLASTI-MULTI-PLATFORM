# Initial Sync Report

> Generated: Task 13a | Phase: Parity Reports

## Overview

The Initial Sync feature enables a Desktop client to perform a full data import from the Cloud API on first login, ensuring the local SQLite database is populated with all agency data before the user interacts with the application. This is critical for Desktop's offline-first architecture — without initial sync, the local database is empty and no queue management is possible.

## Architecture Overview

```
┌──────────────┐     Cloud API      ┌──────────────┐
│  Desktop App │ ──────────────────> │  Cloud API   │
│  (Frontend)  │   GET /api/*       │  (PostgreSQL) │
└──────┬───────┘                    └──────────────┘
       │
       │ Socket.IO (progress events)
       │
       ▼
┌──────────────┐     Prisma         ┌──────────────┐
│  Local API   │ ──────────────────>│  SQLite DB   │
│  (initial-   │   db.createMany() │  (Local)     │
│   sync.js)   │                    └──────────────┘
└──────────────┘
```

**Components:**
1. **`initial-sync.js`** — Core sync engine (local API module)
2. **Local API endpoints** — Sync control API (start/abort/reset/status)
3. **`InitialSync.tsx`** — Full-screen UI with per-stage progress
4. **Auth store integration** — Auto-redirect on first login
5. **Socket.IO events** — Real-time progress to frontend

## Sync Stages (13 stages in dependency order)

Data is imported in strict dependency order to satisfy foreign key constraints:

| Stage | Name | Data Type | Mandatory | Batch Size | Dependencies |
|-------|------|-----------|-----------|------------|-------------|
| 1 | `agency` | Agency profile + settings | ✅ Yes | 1 | None |
| 2 | `users` | User accounts + staff | ✅ Yes | 500 | Agency |
| 3 | `services` | Queue services | ✅ Yes | 500 | Agency |
| 4 | `branches` | Agency branches | ✅ Yes | 500 | Agency |
| 5 | `counters` | Service counters | ✅ Yes | 500 | Branch |
| 6 | `agencyStaff` | Staff-role assignments | ✅ Yes | 500 | User, Agency |
| 7 | `queueSettings` | Queue configuration | ✅ Yes | 1 | Agency, Service |
| 8 | `reservations` | Queue entries (today + active) | ✅ Yes | 500 | Service, Counter, User |
| 9 | `reviews` | Customer reviews | No | 500 | Reservation |
| 10 | `notifications` | User notifications | No | 500 | User, Agency |
| 11 | `announcements` | Agency announcements | No | 500 | Agency |
| 12 | `transactions` | Payment transactions | No | 500 | Reservation |
| 13 | `other` | Favorites, FAQs, device regs | No | 500 | User, Agency |

### Mandatory vs Non-Mandatory

- **Mandatory stages (1-8)**: If any fails, the entire sync aborts and reports the error. These are required for basic queue operation.
- **Non-mandatory stages (9-13)**: If any fails, the stage is skipped and sync continues. These are supplementary data that can be fetched later.

## Progress Events

The sync engine emits real-time progress events via Socket.IO:

| Event | Payload | Purpose |
|-------|---------|---------|
| `SYNC_STARTED` | `{ totalStages: 13 }` | Sync has begun |
| `SYNC_STAGE_STARTED` | `{ stage, stageName }` | A stage has started |
| `SYNC_STAGE_PROGRESS` | `{ stage, stageName, loaded, total, percent }` | Batch progress within a stage |
| `SYNC_STAGE_COMPLETED` | `{ stage, stageName, recordCount, duration }` | A stage has finished |
| `SYNC_COMPLETED` | `{ totalRecords, totalDuration }` | All stages finished successfully |
| `SYNC_ERROR` | `{ stage, stageName, error, fatal }` | An error occurred |

### Progress Calculation

Each stage reports progress as `(loaded / total) * 100`. The overall progress is calculated as:

```
overallProgress = (completedStages / totalStages) * 100
stageProgress = (currentStage.loaded / currentStage.total) * (100 / totalStages)
total = overallProgress + stageProgress
```

## Resumability Mechanism

### Checkpoint Table (`_sync_meta`)

The sync engine uses a `_sync_meta` key-value table in SQLite to track progress:

| Key | Value | Purpose |
|-----|-------|---------|
| `initial_sync_status` | `pending` / `in_progress` / `completed` / `aborted` / `error` | Overall status |
| `initial_sync_started_at` | ISO timestamp | When sync started |
| `initial_sync_completed_at` | ISO timestamp | When sync completed |
| `initial_sync_stage` | Stage number (1-13) | Current stage |
| `initial_sync_checkpoint_{stage}` | JSON `{ lastOffset, batchCount }` | Per-stage resume point |

### Resume Behavior

1. On sync start, check `_sync_meta.initial_sync_status`
2. If `in_progress`: Read last checkpoint, resume from last completed batch
3. If `completed`: Skip sync entirely (already done)
4. If `aborted` or `error`: Offer to restart from beginning

### Exponential Backoff

On network failure during any stage:
- Retry after `2^attempt * 1000ms` (1s, 2s, 4s, 8s, 16s, 32s...)
- Max 6 retries per stage before reporting failure
- Mandatory stages: failure is fatal
- Non-mandatory stages: skip and continue

## UI: InitialSync Screen

The `InitialSync.tsx` page provides a full-screen sync progress interface:

### Layout
- Centered card with agency logo and title
- Overall progress bar (0-100%)
- Per-stage progress list:
  - Stage name with icon
  - Status indicator (⏳ Waiting / 🔄 In Progress / ✅ Complete / ⚠️ Skipped / ❌ Failed)
  - Individual progress bar (for current stage)
  - Record count (e.g., "1,234 / 5,678 records")
  - Duration (for completed stages)

### Interactions
- **Abort button**: Appears during sync, calls `POST /api/sync/initial-sync/abort`
- **Retry button**: Appears on error, restarts from last checkpoint
- **Continue button**: Appears after successful completion, navigates to dashboard

### Socket.IO Integration
- Connects to local API Socket.IO on mount
- Listens for all 6 event types
- Updates React state in real-time as sync progresses
- Auto-disconnects on unmount or completion

## Integration with Login Flow

### Auth Store (`stores/auth.ts`)

Two new state fields:
```typescript
needsInitialSync: boolean   // true if local DB is empty for this agency
initialSyncChecked: boolean // true if we've checked sync status this session
```

Two new methods:
```typescript
checkInitialSync(): Promise<void>   // Calls GET /api/sync/initial-status
setInitialSyncComplete(): void      // Sets needsInitialSync = false
```

### Flow

```
Login Success
     │
     ▼
checkInitialSync()
     │
     ├── needsInitialSync = true
     │        │
     │        ▼
     │   Redirect to /initial-sync
     │        │
     │        ▼
     │   InitialSync screen
     │   (progress events via Socket.IO)
     │        │
     │        ├── User clicks "Continue"
     │        │        │
     │        │        ▼
     │        │   setInitialSyncComplete()
     │        │        │
     │        │        ▼
     │        │   Navigate to /dashboard
     │        │
     │        └── User clicks "Abort"
     │                 │
     │                 ▼
     │            Logout (local DB incomplete)
     │
     └── needsInitialSync = false
              │
              ▼
         Navigate to /dashboard
```

### App.tsx Route

```tsx
<Route path="/initial-sync" element={<InitialSync />} />
```

Auto-redirect logic in the authenticated route wrapper:
```tsx
if (auth.needsInitialSync && !location.pathname.startsWith('/initial-sync')) {
  return <Navigate to="/initial-sync" replace />;
}
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/sync/initial-status` | Returns `{ needed: boolean, status: string, completedAt?: string }` |
| POST | `/api/sync/initial-sync` | Starts the sync engine; returns `{ started: true }` |
| POST | `/api/sync/initial-sync/abort` | Aborts running sync; returns `{ aborted: true }` |
| POST | `/api/sync/initial-sync/reset` | Resets sync state; returns `{ reset: true }` |

## Data Integrity

After all stages complete, the sync engine performs integrity validation:
1. **Foreign key check**: All relations reference existing records
2. **Count validation**: Imported counts match Cloud API counts
3. **Required data check**: Agency, services, and queue settings exist
4. **Sync meta update**: Status set to `completed`, timestamp recorded

## Summary

- **13 sync stages** in dependency order
- **8 mandatory stages** (agency → reservations) — must all succeed
- **5 optional stages** (reviews → other) — failures are skipped
- **Paginated fetching** (500 records/batch) for memory efficiency
- **Resumable** via `_sync_meta` checkpoints — survives app restart
- **Exponential backoff** (6 retries per stage) for network resilience
- **Real-time UI** via Socket.IO progress events
- **Login integration** — auto-redirect on first login, continue to dashboard on completion
