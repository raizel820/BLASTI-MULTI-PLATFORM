/**
 * lan-status-reporter.js — desktop → cloud branch-LAN heartbeat (r21-9).
 * ─────────────────────────────────────────────────────────────────────────────
 * Every ~30s (when a workspace session is open and a cloud URL is known) this
 * posts the lan-authority status snapshot to the cloud:
 *
 *   POST <cloud>/api/lan-topology/report   — identity, role/term/specScore,
 *       uptime and (while MASTER) the joined-device registry. The Owner
 *       Device Manager's "Branch Connections & Master PC" panel renders it.
 *
 * and pulls back the owner's MANUAL master pin:
 *
 *   GET  <cloud>/api/lan-topology/preference?agencyId=…
 *       → { preferredInstanceId } — applied via lan-authority
 *         setPreferredMaster() so the OWNER'S PICK from the web UI wins the
 *         offline election within seconds, on every branch desktop at once.
 *
 * Design constraints:
 *   - Pure Node, fire-and-forget: telemetry can NEVER break the local API.
 *   - Every call 5s-timeout, try/catch — offline is the NORMAL case here.
 *   - The local pin is NEVER cleared by a failed/absent pull — only by an
 *     explicit cloud `preferredInstanceId: null` response or a local route.
 */

const REPORT_INTERVAL_MS = 30_000
const PREFERENCE_PULL_EVERY = 3 // pull the pin every 3rd report (~90s) + on change
const REQUEST_TIMEOUT_MS = 5_000
const PREFERENCE_TTL_MS = 10 * 60 * 1000 // last-known pin is trusted 10min offline

let timer = null
let inited = false
let ticks = 0
let lastAppliedPin
let lastPinAt = 0
let lastErrorLoggedAt = 0
let lastVerdictPullAt = '' // 0.6.100 — ISO cutoff for the verdict pull

let opts = {
  getSession: null,        // () => ({ token, user } | null)
  statusSnapshot: null,    // () => lan-authority snapshot
  setPreferredMaster: null,// (instanceId|null) => Promise
  // 0.6.100 — cloud join-verdict relay + USB peripheral reporting
  applyJoinVerdicts: null, // (verdicts[]) => Promise<number>
  getPeripherals: null,    // () => [{ kind:'printer', name, cupsName, ... }]
  diag: null,              // (msg) => void
  // 0.6.113 — LOCAL-ONLY connection mode: when the Device Manager switch is
  // set to "Local only (LAN/Wi-Fi)", the cloud is NEVER part of the device
  // connection & discovery protocol — the whole report / pin / verdict cycle
  // pauses (the branch LAN topology stops being published to the cloud).
  isCloudAllowed: null,    // async () => boolean
}

function log(msg) {
  const line = '[LAN-REPORT] ' + msg
  try { console.log(line) } catch { /* ignore */ }
  try { opts.diag && opts.diag(line) } catch { /* ignore */ }
}

function cloudApiBase() {
  const base = String(process.env.BLASTI_CLOUD_URL || process.env.BLASTI_API_URL || '')
    .replace(/\/+$/, '')
  return base ? base + '/api' : ''
}

async function postJson(url, bearer, body) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + bearer },
      body: JSON.stringify(body),
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

async function getJson(url, bearer) {
  const ctl = new AbortController()
  const t = setTimeout(() => ctl.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/json', Authorization: 'Bearer ' + bearer },
      signal: ctl.signal,
    })
    if (!res.ok) return null
    return await res.json().catch(() => null)
  } catch {
    return null
  } finally {
    clearTimeout(t)
  }
}

/** One report pass — never throws. */
async function reportOnce() {
  // 0.6.113 — LOCAL-ONLY mode: the cloud must neither see nor influence the
  // branch LAN. Skip the entire cycle; the next tick re-checks, so flipping
  // the switch back to "Cloud allowed" re-enables reporting within ~30s.
  if (typeof opts.isCloudAllowed === 'function') {
    try {
      const allowed = await opts.isCloudAllowed()
      if (!allowed) return
    } catch { /* check failure → historic behaviour (report) */ }
  }
  const session = opts.getSession && opts.getSession()
  const snap = opts.statusSnapshot && opts.statusSnapshot()
  if (!session || !session.token || !snap || !snap.agencyId) return // no workspace open yet
  const base = cloudApiBase()
  if (!base) return // desktop runs against its own API only (dev) — nothing to report to

  const payload = {
    agencyId: snap.agencyId,
    branchId: snap.branchId || null,
    instanceId: snap.instanceId,
    name: snap.name,
    hostname: snap.hostname,
    ipAddress: snap.lanIp,
    lanPort: snap.lanPort,
    role: snap.role,
    term: snap.term,
    specScore: snap.specScore,
    uptimeSec: snap.uptimeSec,
    // MASTER-only: the joined-device registry (phones/tablets/kiosks/PCs).
    devices: Array.isArray(snap.devices) ? snap.devices : [],
  }
  // 0.6.100 — PENDING join requests ride the SAME devices array as
  // kind-tagged entries (no schema change): the Device Manager renders them
  // in the tree and posts verdicts back via /lan-topology/join-verdict.
  if (Array.isArray(snap.joinRequests) && snap.joinRequests.length > 0) {
    for (const jr of snap.joinRequests.slice(0, 20)) {
      payload.devices.push({ kind: 'pending-join', ...jr })
    }
  }
  // 0.6.100 — USB peripherals (printers) attached to THIS machine are
  // reported so ANY branch device's discovery can list + register them.
  if (typeof opts.getPeripherals === 'function') {
    try {
      const peripherals = opts.getPeripherals()
      if (Array.isArray(peripherals)) {
        for (const p of peripherals.slice(0, 12)) {
          if (!p || typeof p !== 'object') continue
          // Explicit field list — a bare spread would let p.kind clobber the
          // 'peripheral' tag the cloud sanitizer routes on.
          payload.devices.push({
            kind: 'peripheral',
            pkind: typeof p.kind === 'string' ? p.kind : 'printer',
            name: typeof p.name === 'string' ? p.name : '',
            cupsName: typeof p.cupsName === 'string' ? p.cupsName : undefined,
            cupsUri: typeof p.cupsUri === 'string' ? p.cupsUri : undefined,
            usbVendorId: typeof p.usbVendorId === 'string' ? p.usbVendorId : undefined,
            usbProductId: typeof p.usbProductId === 'string' ? p.usbProductId : undefined,
            state: typeof p.state === 'string' ? p.state : undefined,
          })
        }
      }
    } catch { /* non-fatal */ }
  }
  const data = await postJson(base + '/lan-topology/report', session.token, payload)
  if (!data || data.success !== true) {
    // Log failures at most once a minute — offline is normal, don't spam.
    if (Date.now() - lastErrorLoggedAt > 60_000) {
      lastErrorLoggedAt = Date.now()
      log(`report skipped (cloud unreachable or rejected) role=${snap.role} term=${snap.term}`)
    }
    return
  }

  ticks += 1
  const duePull = ticks % PREFERENCE_PULL_EVERY === 1
  // 0.6.100 — join verdicts are pulled EVERY report (~30s): the owner's
  // Accept/Reject from the web Device Manager must reach this master fast.
  if (typeof opts.applyJoinVerdicts === 'function') {
    try {
      const vRes = await getJson(base + '/lan-topology/join-verdicts?agencyId=' + encodeURIComponent(snap.agencyId) + '&since=' + encodeURIComponent(lastVerdictPullAt || ''), session.token)
      lastVerdictPullAt = new Date().toISOString()
      if (vRes && vRes.success === true && Array.isArray(vRes.verdicts) && vRes.verdicts.length > 0) {
        await opts.applyJoinVerdicts(vRes.verdicts)
      }
    } catch { /* offline — normal */ }
  }
  // Pull the owner's manual pick: right after the first successful report,
  // then every ~90s, or when this node's report says the pin targets someone
  // else (isPreferredMaster=false while our local pin says ME — drift).
  const localSaysMe = !!snap.preferredMasterInstanceId && snap.preferredMasterInstanceId === snap.instanceId
  const cloudSaysOther = data.isPreferredMaster === false && localSaysMe
  if (duePull || cloudSaysOther || Date.now() - lastPinAt > PREFERENCE_TTL_MS) {
    const pref = await getJson(base + '/lan-topology/preference?agencyId=' + encodeURIComponent(snap.agencyId), session.token)
    if (pref && pref.success === true) {
      const pin = typeof pref.preferredInstanceId === 'string' && pref.preferredInstanceId ? pref.preferredInstanceId : null
      if (pin !== lastAppliedPin || pin !== snap.preferredMasterInstanceId) {
        lastAppliedPin = pin
        lastPinAt = Date.now()
        log(`owner master pin from cloud: ${pin ? pin.slice(0, 12) + '…' : '∅ (automatic)'}`)
        try { await opts.setPreferredMaster(pin) } catch { /* election module guards itself */ }
      } else {
        lastPinAt = Date.now() // unchanged — refresh the trust window
      }
    }
  }
}

/** Start the reporter (idempotent). */
function startLanStatusReporter(startOpts) {
  if (inited) return
  inited = true
  opts = { ...opts, ...(startOpts || {}) }
  log(`started (every ${REPORT_INTERVAL_MS / 1000}s → ${cloudApiBase() || 'no cloud URL — idle'})`)
  timer = setInterval(() => { reportOnce().catch(() => {}) }, REPORT_INTERVAL_MS)
  if (timer.unref) timer.unref()
  // First report ~10s after boot (after the API is listening).
  const first = setTimeout(() => { reportOnce().catch(() => {}) }, 10_000)
  if (first.unref) first.unref()
}

function stopLanStatusReporter() {
  if (timer) { clearInterval(timer); timer = null }
  inited = false
  log('stopped')
}

module.exports = { startLanStatusReporter, stopLanStatusReporter }
