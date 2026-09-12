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

---
Task ID: 1
Agent: main (Z.ai Code)
Task: Import https://github.com/raizel820/BLASTI-MULTI-PLATFORM.git as the main project, read all .md docs, and run the app in the sandbox

Work Log:
- Cloned BLASTI-MULTI-PLATFORM (master) to /tmp, explored monorepo (apps: web/api/desktop/mobile, packages: db/cloud-db/core)
- Read all 13 root .md docs + apps/*/README.md + agent-ctx logs (via Explore subagent): BLASTI is an Arabic-first smart queue-management SaaS for Algerian institutions (hash-based SPA in apps/web page.tsx, Hono+Socket.IO API on 3003, Prisma SQLite dev DB with @blasti/cloud-db PostgreSQL fallback to SQLite when CLOUD_DATABASE_URL unset)
- Replaced the previous Next.js scaffold in /home/z/my-project with the monorepo (rsync minus .git/out/node_modules), preserved sandbox infra (.env, Caddyfile, .zscripts, upload/download, mini-services, skills)
- Wrote root .env + apps/api/.env + apps/web/.env (absolute DATABASE_URL=file:/home/z/my-project/packages/db/data/custom.db, NEXTAUTH_SECRET, INTERNAL_SECRET, API_PROXY_URL=http://localhost:3003; CLOUD_DATABASE_URL intentionally unset for SQLite fallback)
- Hardened root package.json dev:api script to export DATABASE_URL/NEXTAUTH_SECRET/INTERNAL_SECRET/CORS_ORIGIN for the whole chain (bun only auto-loads .env from each app's cwd)
- bun install (2333 pkgs), prisma generate + db:push (42 tables), DB came pre-seeded (admin/admin123, owner1/owner123, staff1/staff123, customer1/customer123 + 4 agencies DEMO001/CLINIC001/LAB001/GOV001) — db:seed failure was duplicate-data only
- Discovered sandbox constraint: processes spawned by tool commands are reaped ~3s after the command exits; dev.sh (run by platform at session start) is the sanctioned way dev servers persist. All verification was therefore done inside single long-running commands hosting the server
- Fixed schema drift bug: API code (queue.ts:399 + agency/admin/sync routes) selects Reservation.createdAt but both Prisma schemas only had joinedAt — added `createdAt DateTime @default(now())` to Reservation in packages/db AND packages/cloud-db schemas, db:push (additive, no data loss)
- Extended apps/web/next.config.ts rewrites: added exact '/socket.io' + '/health' proxies to API_PROXY_URL (3003)
- Verified via agent-browser + curl: home page renders (Arabic RTL), login works for admin/owner1/staff1/customer1, admin dashboard (#/admin) and agency dashboard (#/agency) render with real data, customer dashboard (#/customer) shows real activity, onboarding tour modal works
- Golden path E2E via API: customer1 join queue → ticket C-007 WAITING with ETA; owner1 call-next → CALLED with calledAt; queue/status healthy; admin stats return 4 agencies/4 users; then restored C-006/C-007 to WAITING for a clean demo queue
- Realtime verified: socket.io polling handshake OK on :3003 direct and via Caddy gateway :81 with XTransformPort=3003; FULL WebSocket upgrade through the gateway proven with socket.io-client E2E test (connects, sid assigned). Note: Next.js dev rewrite does NOT proxy /socket.io on direct localhost:3000 access (Next 16 limitation) — irrelevant for users because the preview routes through the Caddy gateway where WS works; UI has polling + offline fallback anyway

Stage Summary:
- BLASTI monorepo is now the main project at /home/z/my-project and runs with plain `bun run dev` (concurrently: web :3000 + api :3003)
- Logins: admin/admin123 (super admin), owner1/owner123, staff1/staff123, customer1/customer123 — agencies DEMO001, CLINIC001, LAB001, GOV001
- Fixed: Reservation.createdAt schema drift (both schemas), dev:api env export, per-app .env files, /health + /socket.io rewrites
- 0 prisma errors / 0 5xx across all endpoints after fixes; DB at packages/db/data/custom.db (pre-seeded)
- Sandbox persistence: the platform's .zscripts/dev.sh auto-runs `bun run dev` at session start — BLASTI will come up automatically on the next session; env is fully configured for that path (root db:push uses inline absolute DATABASE_URL, unaffected by start.sh overwriting root .env)

---
Task ID: 2
Agent: main (Z.ai Code)
Task: Fix BLASTI Web dev crash — `bun run dev:web` → ChunkLoadError → browser crash; find root cause, fix dev scripts, bound client loops, add regression protection

Work Log:
- Root cause identified: root dev:web used `bun --bun run node_modules/.bin/next dev` — Next.js 16 dev server ran on Bun's JS runtime (unsupported combo). Evidence: start-server process under Bun with 1.4GB RSS runaway + .next/_events NEXT_CLI_SESSION_STOPPED after 459ms
- Fixed root package.json dev:web → `node node_modules/next/dist/bin/next dev -p 3000 -H 127.0.0.1`; added dev:web:api, dev:web:lan, clean:web, test:web:startup
- Fixed apps/web package.json dev → Node runtime + 127.0.0.1, added dev:lan + clean
- next.config.ts: rewrites return [] in NEXT_BUILD_MODE=export (fixes desktop/mobile static export builds); /socket.io rewrite destination re-appends trailing slash (Next 308-normalizes /socket.io/ → /socket.io BEFORE rewrites; engine.io only answers /socket.io/ → realtime could never connect on direct :3000 access)
- use-realtime.tsx: transports websocket-first → polling-first (WS-first hangs against Next dev forever — upgrade TCP accepted, never completed — so polling was never reached); reconnectionAttempts Infinity → 20 on web; one bounded reconnect per sessionToken change
- Deleted src/hooks/use-realtime.ts (dead duplicate shadowed by .tsx, with divergent reconnect configs — tsc checked .ts while bundler ran .tsx)
- use-discovery-service.ts: 3s scan-status poll now stops after 3 consecutive failures (was unbounded if API died mid-scan)
- connection-status.tsx: health checks honor central isApiUnreachable() 30s cooldown
- New src/components/shared/dev-debug-hud.tsx — opt-in diagnostics (?debug=1 / localStorage blasti:debug=1, Alt+Shift+D hides): API reachability, socket status, request counter, route, JS heap; mounted in all 4 page.tsx render branches, inert unless enabled and in production
- New scripts/web-startup-test.mjs + bun run test:web:startup: spawns dev:web, verifies ready/200/all chunks 200+non-empty/chunk byte stability/bounded second load/idle RSS ceiling — 8/8 passed from a clean .next with API NOT running
- start.sh aligned to Node runtime + 127.0.0.1; daemon-start.sh already safe (delegates to fixed apps/web dev script)
- Audited via 2 subagents: all 48 setInterval sites cleared-or-dormant; socket singleton ref-counted with cleanup; NO server-only packages (Prisma/cloud-db/Node builtins) in client bundle; all 31 lazy() targets exist with resolvable deps; api-client retries bounded (3, exp backoff, 4xx no-retry, 30s unreachable cooldown persisted in sessionStorage)
- Verified via agent-browser on http://127.0.0.1:3000 direct: landing renders, owner1 login → agency dashboard live, realtime CONNECTED over polling ("متصل بالخادم"), 0 page errors, 46/46 resources OK, browser heap 58.7MB, server RSS flat (Δ+1MB/40s idle); web-only mode (API down): graceful error states, bounded single retry chains, page stays interactive; request volume finite (91 req first 10s incl. dev assets; steady state stats 3/health 2/socket ~4/notifications 2 per 35s)
- Final stack restarted fresh: web (Node, 127.0.0.1:3000) + API (127.0.0.1:3003); gateway :81 → web 200 confirmed with loopback binding

Stage Summary:
- Root cause: Bun-runtime Next.js dev server (bun --bun) — chunk-serving corruption + dev-server memory runaway; amplified on Windows by 0.0.0.0 binding, WS-first socket hang, unbounded reconnect, uncoordinated pollers
- bun run dev:web is now standalone-safe: Node runtime, exactly ONE server, 127.0.0.1, no API/Electron dependency, graceful when API is down
- Realtime now works on direct dev access (was silently broken: slash-less /socket.io 404 + WS-first hang)
- Regression protection: bun run test:web:startup (8/8) + opt-in dev HUD (?debug=1)
- Full report: /home/z/my-project/WEB_DEV_CRASH_AUDIT.md
