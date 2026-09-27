// Task 55-b verification battery (contract §2.5)
const API = 'http://localhost:3003'
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

async function req(method: string, path: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${API}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  let json: any = null
  try { json = await res.json() } catch { /* ignore */ }
  return { status: res.status, json }
}

async function login(username: string, password: string): Promise<string> {
  const r = await req('POST', '/api/auth/login', undefined, { username, password })
  if (r.status !== 200 || !r.json?.success) throw new Error(`login ${username} failed: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`)
  // token may sit at different keys — hunt it
  const token = r.json.token || r.json.data?.token || r.json.accessToken
  if (!token) throw new Error(`no token in login response keys=${Object.keys(r.json)}`)
  return token as string
}

console.log('── 1. Generate REAL owner traffic (must be recorded) ──')
const owner = await login('owner', 'owner123')
const ownerPaths = [
  '/api/agencies', '/api/agency/stats', '/api/agency/analytics/dashboard?period=30d',
  '/api/notifications', '/api/agency/profile', '/api/user/me', '/api/agency/reservations?limit=5',
  '/api/agency/services', '/api/agency/branches', '/api/settings',
]
let trafficOk = 0
for (const p of ownerPaths) {
  const r = await req('GET', p, owner).catch(() => ({ status: 0, json: null }))
  if (r.status > 0 && r.status < 500) trafficOk++
  else console.log(`   ⚠ ${p} → ${r.status}`)
  await sleep(650)
}
console.log(`   owner traffic calls completed: ${trafficOk}/${ownerPaths.length} (non-500)`)

console.log('── 2. Wait for the 5s recorder flush ──')
await sleep(6500)

console.log('── 3. Admin endpoint battery ──')
const admin = await login('admin', 'admin123')
const cases: Array<[string, string, (j: any) => string | null]> = [
  ['default 30d', '/api/admin/analytics/data-consumption', (j) => {
    const d = j.data
    if (!d?.totals || !d?.resolved) return 'missing totals/resolved'
    if (d.totals.totalBytes <= 0) return `expected totalBytes>0, got ${d.totals.totalBytes}`
    if (!d.byAgency?.length || d.byAgency[0].agencyCode !== 'MYA') return 'byAgency[0] not MYA'
    if (typeof d.meta.recordedSince !== 'string') return 'meta.recordedSince missing'
    return null
  }],
  ['period=today', '/api/admin/analytics/data-consumption?period=today', (j) => j.data?.resolved ? null : 'missing resolved'],
  ['custom valid', '/api/admin/analytics/data-consumption?period=custom&from=2026-09-01&to=2026-09-30', (j) => j.data?.resolved ? null : 'missing resolved'],
  ['custom missing from', '/api/admin/analytics/data-consumption?period=custom&to=2026-09-30', (j) => j.status === 400 ? null : `expected 400 got ${j.status}`],
  ['network=WIFI', '/api/admin/analytics/data-consumption?network=WIFI', (j) => {
    const d = j.data; const total = d.totals.totalBytes
    const wifiOnly = d.byNetwork.WIFI > 0 || total === 0
    if (d.byNetwork.MOBILE !== 0) return 'MOBILE bucket must be 0 when network=WIFI'
    return wifiOnly ? null : 'WIFI bucket empty but total > 0'
  }],
  ['network=MOBILE', '/api/admin/analytics/data-consumption?network=MOBILE', (j) => j.data?.byNetwork?.WIFI === 0 ? null : 'WIFI must be 0 when network=MOBILE'],
  ['trafficType=SYNC', '/api/admin/analytics/data-consumption?trafficType=SYNC', (j) => {
    const d = j.data
    const nonSync = Object.entries(d.byTrafficType).filter(([k, v]) => k !== 'SYNC' && (v as number) > 0)
    return nonSync.length === 0 ? null : `non-SYNC buckets non-zero: ${JSON.stringify(nonSync)}`
  }],
  ['wilaya=28', '/api/admin/analytics/data-consumption?wilaya=28', (j) => j.data?.byAgency?.[0]?.wilaya === '28' || (j.data?.byAgency?.length === 0) ? null : 'wilaya filter not applied'],
  ['category=OTHER', '/api/admin/analytics/data-consumption?category=OTHER', (j) => j.data?.resolved ? null : 'missing resolved'],
  ['agencyId filter', null, null], // filled below with MYA id
  ['bad network value', '/api/admin/analytics/data-consumption?network=5G', (j) => j.status === 400 ? null : `expected 400 got ${j.status}`],
]
let fails = 0
for (const [label, path, check] of cases) {
  if (label === 'agencyId filter') continue
  const r = await req('GET', path!, admin)
  const problem = check ? check({ status: r.status, ...r.json }) : (r.status === 200 ? null : `status ${r.status}`)
  if (problem) { fails++; console.log(`   ✗ ${label}: ${problem}`) } else console.log(`   ✓ ${label}`)
  await sleep(650)
}
// agencyId filter with the real MYA id
const def = await req('GET', '/api/admin/analytics/data-consumption', admin)
const myaId = def.json?.data?.byAgency?.[0]?.agencyId
if (myaId) {
  const r = await req('GET', `/api/admin/analytics/data-consumption?agencyId=${myaId}`, admin)
  const ok = r.json?.data?.byAgency?.length === 1 && r.json.data.byAgency[0].agencyId === myaId
  if (!ok) { fails++; console.log('   ✗ agencyId filter: expected exactly MYA row') } else console.log('   ✓ agencyId filter')
} else { fails++; console.log('   ✗ agencyId filter: could not resolve MYA id') }
await sleep(650)

console.log('── 4. Payload sanity (default window) ──')
const d = def.json.data
console.log(`   totals: up=${d.totals.uploadBytes}B down=${d.totals.downloadBytes}B total=${d.totals.totalBytes}B events=${d.totals.events}`)
console.log(`   byNetwork: ${JSON.stringify(d.byNetwork)}`)
console.log(`   byTrafficType: ${JSON.stringify(d.byTrafficType)}`)
console.log(`   averages: perAgency=${d.averages.perAgency} agencyCount=${d.averages.agencyCount} branchCount=${d.averages.branchCount} perCustomer=${d.averages.perCustomer} customerCount=${d.averages.customerCount} deviceCount=${d.averages.deviceCount}`)
console.log(`   byAgency[0]: ${JSON.stringify(d.byAgency[0])}`)
console.log(`   topCustomers: ${d.topCustomers.length} row(s)`)
console.log(`   peaks: hour=${d.peaks.hour} (${d.peaks.hourBytes}B) day=${d.peaks.day} (${d.peaks.dayBytes}B)`)
console.log(`   meta: recordedSince=${d.meta.recordedSince} excludedUnknown=${d.meta.excludedUnknownNetworkBytes}`)
console.log(`   timeseries points: ${d.timeseries.length}`)
const sumAgency = d.byAgency.reduce((a: number, r: any) => a + r.totalBytes, 0)
if (sumAgency > d.totals.totalBytes) { fails++; console.log('   ✗ ΣbyAgency > totals (impossible)') }

console.log('── 5. Permission matrix ──')
const ownerHit = await req('GET', '/api/admin/analytics/data-consumption', owner)
console.log(`   owner → ${ownerHit.status} ${ownerHit.status === 403 ? '✓' : '✗ (expected 403)'}`)
if (ownerHit.status !== 403) fails++
const anonHit = await req('GET', '/api/admin/analytics/data-consumption')
console.log(`   anon  → ${anonHit.status} ${anonHit.status === 401 ? '✓' : '✗ (expected 401)'}`)
if (anonHit.status !== 401) fails++

console.log('── 6. Health ──')
const h = await fetch(`${API}/api/health`)
console.log(`   /api/health → ${h.status}`)

console.log(fails === 0 ? '\n✅ ALL 55-b CHECKS PASSED' : `\n❌ ${fails} CHECK(S) FAILED`)
process.exit(fails === 0 ? 0 : 1)
