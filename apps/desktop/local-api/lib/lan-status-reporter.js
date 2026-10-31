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

let opts = {
  getSession: null,        // () => ({ token, user } | null)
  statusSnapshot: null,    // () => lan-authority snapshot
  setPreferredMaster: null,// (instanceId|null) => Promise
  diag: null,              // (msg) => void
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
