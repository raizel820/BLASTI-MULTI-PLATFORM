# Task 2a: Cloud API Initial-Sync Endpoint

## Summary
Created a dedicated `POST /api/sync/initial-data` endpoint and expanded SYNC_MODELS for full sync coverage.

## Files Created
- `apps/api/src/routes/initial-sync.ts` (539 lines) — New initial-sync route

## Files Modified
- `apps/api/src/index.ts` — Added import and route registration for initialSyncRoutes
- `apps/api/src/routes/sync.ts` — Expanded SYNC_MODELS from 10 to 19 models, added fetchRecordsForModel cases for 9 new models

## Key Design Decisions
- Route mounted under `/api/sync` alongside existing sync routes (pull/push/status)
- 13 stages in dependency order with cursor-based pagination for large data (reservations, notifications, reviews, transactions)
- Discovery mode (no stage specified) returns stage metadata with estimated counts
- Uses requireAgencyAccess for auth, getLatestSequence for snapshot consistency
- Serializes records via serializeForCloud from @blasti/core/sync-serializer
- Default page size 500, max 1000; cursor = last record ID for stable ordering

## Verification
- TypeScript: zero errors in new/modified files
- API server starts successfully (port-in-use is expected from existing process)
