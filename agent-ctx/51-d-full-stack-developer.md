# Task 51-d — full-stack-developer (desktop parity) — Work Record

## Scope
Desktop local-api parity for the Agency Location & Maps system (Task 51). Cloud contract from 51-a; web UI from 51-b. Only file code-changed: `apps/desktop/local-api/index.js`.

## Handlers / code touched (all in apps/desktop/local-api/index.js, +283 lines)
1. **Module level (top, after `let fileSync`)**
   - `mapsConfigMemoryCache` + `MAPS_CONFIG_MEMORY_TTL_MS` (30s) + `MAPS_CONFIG_META_KEY` ('maps_config_cache') + `MAPS_CLOUD_PROBE_TIMEOUT_MS` (5s)
   - `DEFAULT_MAPS_CONFIG` — exact verified 51-a cloud output (OpenFreeMap-first)
   - `stripMapsSecretsForPersist(config)` — jsApiKey → null copy for DB persistence
2. **`buildAgencyLocationUpdate(body)` (after `upsertLocalUserFromCloud`)** — cloud-exact mirror of `validations.ts` ranges/enums + `buildAgencyLocationPatch` pair semantics:
   - lat −90..90 / lng −180..180 (400 with the cloud's exact message strings); null = nullable, NOT a type error (drives explicit clear)
   - both numbers → write + `locationUpdatedAt = new Date()` (server-stamp); both null → clear WITHOUT re-stamping; half pair → 400 pair error
   - postalCode string ≤20 or null; locationVerified ∈ VERIFIED|UNVERIFIED|MANUAL; locationSource ∈ GOOGLE|OPENFREEMAP|MANUAL|DEVICE_GPS
   - returns `{ok:true,data}` (present-fields only) or `{ok:false,error}` → caller 400s
3. **PUT /api/agency/profile** — location patch merged after the field whitelist, before the empty-body 400 (location-only saves now legal); rides `withOutboxTransaction`; outbox body = raw request body (replays verbatim to cloud).
4. **PATCH /api/agency/profile** — validated BEFORE the local write AND the agency-missing cloud-forward path; outbox row carries the pair.
5. **GET /api/agency/profile** — response now includes `latitude, longitude, postalCode, locationVerified, locationSource, locationUpdatedAt` (mirrors cloud GET /profile; locationVerified falls back 'UNVERIFIED' for pre-topup rows).
6. **GET /api/config/maps** (new "APP CONFIG" section) — authMiddleware; probe `{BLASTI_CLOUD_URL}/api/config/maps` with session token (5s) unless memory cache <30s; success → full config in memory + STRIPPED copy (jsApiKey null) in `_sync_meta`; fallback on unreachable/error/non-2xx: memory cache → persisted stripped copy (restart-surviving) → DEFAULT_MAPS_CONFIG. Envelope always exactly `{success:true,data:{...}}` (8 keys). SECRETS: jsApiKey memory-only, never persisted (spec §45/§46); server keys never appear.
7. **forwardAgencies docblock** — documents that create/agency-update payloads carry the location fields verbatim to the cloud (cloud validates/stamps; v2 sync brings all 8 columns down). No code change (local create IS the cloud proxy).

## Audited, zero changes needed
- Login/register/verify `upsertLocalUserFromCloud` — fixed User-profile-only field list; Agency-only location fields cannot leak. Confirmed nothing breaks.
- ensureSchema top-up mechanism parses SCHEMA_INIT_SQL → the 8 Agency DDL columns (51-a) reach existing desktop DBs automatically. Verified on a legacy DB: stripped all 8 → ensureSchema restored all 8 with correct types (REAL/REAL/TEXT/TEXT/TEXT/DATETIME/TEXT/TEXT).

## Endpoint behavior summary (GET /api/config/maps)
- 401 without/with-invalid token (authMiddleware).
- Online: serves the cloud's current Super-Admin config verbatim (fresh probe, ≤30s memory TTL).
- Offline: last cached config (memory has jsApiKey; persisted copy has jsApiKey:null), else the OpenFreeMap default — envelope shape identical in every case, so the map widgets degrade gracefully (spec §40) instead of 404ing (51-b's "known boundary" closed).

## Test results
- `node --check apps/desktop/local-api/index.js` — PASS.
- `node tests/test-schema-migrations.js` — **8/8 PASS** (includes additive top-up coverage).
- `node tests/test-db.js` — 11/11 PASS.
- Runtime smoke (scratch harness, temp `BLASTI_LOCAL_DB_DIR`, real `startLocalApi` :3199 + fake cloud :3198; deleted after use) — **18/18 PASS**: default envelope when cloud down; proxy+cache when up; secret absent from `_sync_meta`; restart-survival of the stripped copy; PUT/PATCH pair semantics, ranges (400), enums (400), pair error (400), null-clear without re-stamp, location-only save, GET fields, outbox carry, client locationUpdatedAt ignored.
- `node tests/test-stale-generation.js` — **0/13 in-tree (PRE-EXISTING, not a 51-d regression)**: initial-sync.js lacks the Task-48 stale-generation exports the untracked test requires ("Task 48 fix re-applied" is NOT in the delivered tree). The complete fix lives in **git stash@{0}** ("WIP on main: 2d90e36", a mega-WIP with Task-5 User.wilaya/commune + Task-42-a AgencyCategory + Task-46 sanitize + Task-48 exports). Verified empirically: temporarily placing the stashed initial-sync.js → **13/13 PASS** (with 8/8 + 11/11 suites still green), then restored byte-exact (sha256) per the do-not-modify constraint. **Orchestrator remedy:** `git checkout stash@{0} -- apps/desktop/local-api/initial-sync.js` (standalone-compatible with the current tree).

## For the next agent (desktop map UI wiring)
- Local `/api/config/maps` consumes identically to the cloud route — 51-b's `use-map-config.ts` `normalizeMapsConfigPayload` tolerates the envelope as-is; desktop only needs the renderer pointed at the local base URL (it already is for `apiFetch`).
- Profile GET returns the 6 location fields flat (no envelope) exactly like the cloud; `AgencyInfo` optional types already accept them.
- Offline Electron: `/api/config/maps` never 404s → `isProviderAvailable`/map surfaces get a real config (default OpenFreeMap) instead of null → offline amber box + saved coords stay usable (spec §39/§40).
