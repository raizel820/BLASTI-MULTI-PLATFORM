# BLASTI Offline LAN Authority Design
### وضع عدم الاتصال — مصدر حقيقة واحد على الشبكة المحلية
R-21 deliverable (r21-9) · 0.6.22 design → **0.6.23 IMPLEMENTED** (user's answers applied)

> **Implementation status (0.6.23):** shipped in `apps/desktop/local-api/lib/lan-authority.js`
> (+ wiring in `local-api/index.js`, `main.js` beacon, and the shared client
> `apps/web/src/lib/lan-authority-client.ts`). Two-node E2E drill: **18/18**
> (election, join + per-device token, scope rejection, write-gate, failover,
> old-master demotion). §5 answers below are the user's confirmed decisions.

---

## 1. The requirement (user's words, restated)

> In offline mode all devices are connected to the same network. The **best-spec
> device becomes the main server** and stores the **source of truth — the real
> queue — shared with the other devices**, so devices do NOT each keep their own
> copy that they read and write in isolation.

## 2. Ground truth from the 0.6.21/0.6.22 audit (what already exists)

| Capability | Status | Where |
|---|---|---|
| Desktop hosts a real server (Node + SQLite + full local API on :3080) | ✅ exists | `apps/desktop/local-api/index.js` |
| LAN bind `0.0.0.0` in packaged builds | ✅ exists | `local-api/lib/lan-origin.js` (BLASTI_LAN_BIND), packaged defaults ON |
| UDP beacon announcing the desktop every 3s on :3081 | ✅ exists | `apps/desktop/main.js` (payload: service/name/hostname/lanIp/httpPort) |
| LAN discovery scanners (ARP/mDNS/SSDP/HTTP probe) | ✅ exists | `apps/api/src/lib/discovery/scanner.ts`, `desktop/local-api/lib/discovery-scanner.js` |
| Phone-side LAN probing of desktop :3080 | ✅ exists | `apps/mobile/src/plugin.ts:285-345`, `apps/web/src/hooks/use-lan-mode.ts` |
| WatermelonDB pull/push endpoint on :3080 that ACCEPTS foreign writes | ✅ exists | `local-api/index.js` `POST /api/sync/push` (applyPullChanges: sanitizer + LWW + FK deferral) |
| Shared session token works for LAN peers | ✅ exists | `requireAuth()` timing-safe compare vs imported cloud token (`/api/auth/import-session`) |
| Local realtime (Socket.IO) on :3080 with same room/event protocol as cloud | ✅ exists | `local-api/local-realtime.js` |
| Outbox + reconcile sync engine (15s incremental, 6h full LWW) | ✅ exists | `local-api/sync-service.js` |
| Offline write queue (IndexedDB, server-wins) in the web/mobile app | ✅ exists | `apps/web/public/blasti-offline-queue.ts` |
| **Leader election / role field / spec-score** | ❌ nothing | grep `leader/election/spec-score` = 0 hits |

**Hard constraint:** only the Electron desktop can HOST an authority (it alone
ships Node + SQLite + the local API). Phones are WebViews — a pure election
among phones cannot produce a server. Therefore election = selection among
**desktop-class nodes**; phones always follow.

## 3. Recommended design — Approach C (hybrid)

### 3.1 Roles
- **MASTER** — the one desktop-class node whose local SQLite is the source of
  truth for the whole agency while offline. Owns all queue writes, ticket
  numbering, and the local Socket.IO.
- **FOLLOWER** — every other device (desktops, phones, kiosks, TV boards).
  All reads/writes target `http://<master-lan-ip>:3080`. No local queue writes.
- **CLOUD** — when internet exists, the master's existing sync engine replays
  the outbox every 15s and pulls cloud changes; cloud remains the final
  arbiter per the registry's conflict strategies. Offline mode changes nothing
  about the cloud contract.

### 3.2 Discovery (reuse, small extension)
Extend the existing :3081 beacon payload with:
```json
{ "service": "blasti-local", "agencyId": "…", "role": "MASTER|CANDIDATE|FOLLOWER",
  "term": 7, "specScore": 42.7, "instanceId": "<durable machine id>", "httpPort": 3080 }
```
`instanceId` already exists (`device-telemetry.js` machine-id). Phones/kiosks
keep their current scanners; only the consumer logic learns to look at
`role/agencyId/term/specScore`.

### 3.3 Election among desktops (new, small)
- `specScore = cpuCount × cpuPerfIndex + totalMemGB × 2 + 1` (derived from
  `os.cpus()`/`os.totalmem()` already read in device-telemetry).
- Deterministic tie-break: higher specScore → longer uptime → lexicographic
  instanceId.
- A candidate claims mastership only after N probe windows (≈3×3s) without
  seeing a strictly-better peer; randomized jitter prevents simultaneous
  claims. Claim = flip own beacon role to MASTER + accept writes (no new
  transport).
- **All-mobile LAN (no desktop, no internet):** honest degraded mode — the
  existing offline-queue + WatermelonDB caches, with "no LAN server" surfaced
  in `offline-diagnosis-panel.tsx`. When any desktop appears, the 30s re-probe
  in `use-lan-mode.ts` adopts it automatically.

### 3.4 Join / auth
- Follower resolves the master from beacons (or `GET /api/discover`), then:
  same shared session token via `/api/auth/import-session` (exists), then all
  API calls point at the master's :3080.
- Single change required in the client: `api-client.ts getApiBaseUrl()` /
  `native-cloud-resolver.ts` / `use-lan-mode.ts` must prefer a discovered
  MASTER when the cloud is unreachable. (Today Electron pins 127.0.0.1:3080 —
  a non-master desktop must repoint to the LAN master; phones must try the
  master before the cloud.)
- Kiosks/TV boards keep the existing pairing-code flow.

### 3.5 Write path (zero new engines)
Every queue mutation (call-next, walk-in, status transitions, counter claim —
the full r21-7 route family) already exists on :3080 and is transactional and
idempotent. Followers make ZERO local queue writes: their WatermelonDB stays a
read cache fed by `POST /api/sync/pull`; any local UI write goes straight to
the master. Ticket numbering stays exclusively on the master (the offline
queue already refuses to mint numbers — gap closed by design).

### 3.6 Failover
- Followers detect master death via beacon silence (>10s) + failed health
  probes → re-election among remaining desktops, `term` increments.
- Reconciliation onto the new master = followers replay their IndexedDB
  offline-queue + WatermelonDB deltas through the master's existing
  `POST /api/sync/push` (LWW + FK deferral already implemented). Residual
  conflicts land in `_sync_conflicts` → existing conflict-resolution dialog.
- Old-master returns → sees a higher term, demotes to FOLLOWER, pulls a
  reconcile snapshot (existing `reconcileRecords()` path).

### 3.7 Split-brain stance
Two desktops that each accepted writes while partitioned reconcile by term +
LWW with the conflict log as the human backstop. This is acceptable for the
target scenario (one reception LAN, one agency); a full consensus protocol is
deliberately out of scope.

## 4. Implementation plan (when approved)

| Phase | Work | Size |
|---|---|---|
| P1 | beacon role/term/specScore fields + spec-score helper | ~1 day |
| P2 | election state machine in main.js (claim/step-down, term persistence in _sync_meta) | ~2 days |
| P3 | client base-URL preference: discovered master > cloud (api-client, native-cloud-resolver, use-lan-mode, Electron non-master repoint) | ~2 days |
| P4 | follower join UI (offline-diagnosis-panel "connected to MASTER <name>" state) + re-adopt on master change | ~1 day |
| P5 | failover drill: kill master → re-elect → reconcile; split-brain rehearsal | ~1 day |

## 5. Answers from the agency owner (user, 0.6.23 — all applied)

1. **Desktop always present?** YES — every branch always has at least one
   active desktop → desktop-anchored authority; election is the failover net.
2. **Two agencies on one LAN?** Branches may share a network, but devices only
   connect to the desktop of the branch their OPENED ACCOUNT belongs to
   (staff are branch-bound; only the owner spans all branches; tablets/kiosks
   are linked to the branch device manager) → join scope = workspace
   agencyId + branch refinement for branch-bound staff (implemented).
3. **LAN privacy:** per-device tokens → the master mints an HMAC device token
   at join (30-day TTL, registry persisted in `_sync_meta`); requireAuth
   accepts it beside the session token (implemented).
4. **Join approval UX:** AUTO-JOIN after LAN reachability + account↔branch
   scope validation — no approval step (implemented client+server).
5. **Master eviction:** BOTH better specs AND a modern OS count — specScore =
   cores×GHz + memGB×2 + OS-modernity points (Win11/Win10, Darwin 21+, kernel
   6.x), deterministic tie-break spec → uptime → instanceId (implemented).
6. **Public queue view:** unchanged (TV board / kiosk pairing flow stays).

Failover requirement (user): the master is the only source of truth while
alive; devices keep a local copy so when the master shuts down, the next-best
device becomes master (re-election term+1) and followers replay their deltas
through the new master's existing `/api/sync/push` (LWW + conflict log).

## 6. Explicitly rejected alternatives
- Full election among phones — impossible (no Node runtime in Capacitor).
- Reviving `mini-services/discovery-service` on :3010 — redundant; the :3081
  beacon + existing scanners already cover discovery.
- A new sync engine / CRDT layer — the existing outbox + pull/push + LWW +
  conflict log already provides the required guarantees at this scale.
