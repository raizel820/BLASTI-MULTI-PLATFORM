---
Task ID: 1-7
Agent: main
Task: Fix web app "data failed to load" error, consolidate initial sync, fix first-login state machine, add snapshot sequence semantics

Work Log:
- Audited entire monorepo structure (apps/web, apps/api, apps/desktop, packages)
- Discovered root cause of "data failed to load": Next.js API rewrites were removed, causing 404 for API requests when not going through Caddy gateway
- Added API rewrites back in next.config.ts to proxy /api/* and /socket.io/* to port 3003
- Found and fixed buildUrl() double-? bug: paths with existing query params were getting ?XTransformPort appended instead of &XTransformPort
- Found and fixed Bearer token auth issue: Next.js rewrites don't forward Set-Cookie headers, so httpOnly cookie auth doesn't work through the proxy
- Added module-level token cache in api-client.ts (setSessionToken/clearSessionToken) to avoid timing issue with Zustand persist
- Updated login-form.tsx to call setApiClientToken() immediately after successful login
- Updated use-app-store.ts logout to clear cached token
- Audited duplicate initial sync mechanisms: found initial-sync.js (proper) and sync-service.js's initialSync() (conflicting)
- Removed duplicate initialSync() from sync-service.js
- Fixed setAuth() in sync-service.js to not reset sync version or call _syncCycle() after login
- Added concurrency guard to initial-sync.js
- Removed syncService.initialSync() call from index.js
- Fixed first-login decision logic in loading-screen.js (NOT_INITIALIZED is not an error)
- Added sync:initial-required event in sync-service.js when agency not initialized after login
- Added snapshot sequence recording in initial-sync.js (stores initialSyncSnapshotSequence in _sync_meta)
- Added snapshot sequence as starting cursor in sync-service.js (_pullFromCloud checks for snapshotSequence)
- Added race condition check in initial-sync.js (re-checks snapshotSequence after all stages complete)

Stage Summary:
- "Data failed to load" error fixed: API rewrites + Bearer token auth working
- Initial sync consolidated to exactly ONE implementation (initial-sync.js only)
- First-login state machine: NOT_INITIALIZED → trigger initial sync → READY → incremental sync starts
- Snapshot sequence semantics: initial sync records snapshotSequence, incremental sync uses it as starting cursor
- Race condition handling: re-checks snapshotSequence after completion, emits warning if changed
- All agency dashboard API calls returning 200 with proper auth
