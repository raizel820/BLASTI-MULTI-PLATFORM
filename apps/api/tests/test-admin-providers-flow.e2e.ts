/**
 * E2E: admin provider save + REAL-gateway test calls (invalid keys → expected
 * documented errors), plus webhook-urls endpoint.
 * Run: bun run tests/test-admin-providers-flow.e2e.ts  (from apps/api)
 */
import { db } from '@blasti/db'

const API = 'http://127.0.0.1:3003'

async function main() {
  const results: string[] = []
  const ok = (name: string, pass: boolean, extra = '') =>
    results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)

  // 1. Login as admin
  const login = await fetch(`${API}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'admin123' }),
  })
  const loginJson = await login.json() as { token?: string; success?: boolean; accessToken?: string; data?: { token?: string } }
  const token = loginJson.token ?? loginJson.accessToken ?? loginJson.data?.token
  ok('admin login', Boolean(token), `status=${login.status}`)
  if (!token) { console.log(results.join('\n')); process.exit(1) }
  const auth = { Authorization: `Bearer ${token}` }

  // 2. Save SMS config with an INVALID key (real gateway will 401)
  const put1 = await fetch(`${API}/api/admin/providers/SMS`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, apiKey: 'esms_test_invalid_key_e2e', senderId: '', apiUrl: '' }),
  })
  const put1Json = await put1.json() as { success: boolean }
  ok('PUT SMS config saved', put1.status === 200 && put1Json.success, `status=${put1.status}`)

  // 3. Test connection (no recipient) — real GET /balance with bad key
  const t1 = await fetch(`${API}/api/admin/providers/SMS/test`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  })
  const t1Json = await t1.json() as { success: boolean; error?: string }
  ok('SMS test reaches REAL gateway', t1.status === 200, `status=${t1.status}`)
  ok('SMS test reports invalid key (real 401)', t1Json.success === false && /invalid API key|401/i.test(t1Json.error ?? ''), `error=${t1Json.error}`)

  // 4. WhatsApp config with invalid token
  const put2 = await fetch(`${API}/api/admin/providers/WHATSAPP`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, apiKey: 'EAAG_invalid_e2e', phoneNumberId: '123456789012345', accountId: '', apiUrl: '' }),
  })
  ok('PUT WHATSAPP config saved', put2.status === 200 && (await put2.json()).success, `status=${put2.status}`)
  const t2 = await fetch(`${API}/api/admin/providers/WHATSAPP/test`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}',
  })
  const t2Json = await t2.json() as { success: boolean; error?: string }
  ok('WhatsApp test reaches REAL Graph API', t2.status === 200, `status=${t2.status}`)
  ok('WhatsApp test reports invalid token', t2Json.success === false && /token|190|Graph/i.test(t2Json.error ?? ''), `error=${t2Json.error}`)

  // 5. webhook-urls endpoint
  const wu = await fetch(`${API}/api/admin/providers/webhook-urls`, { headers: auth })
  const wuJson = await wu.json() as { success: boolean; sms?: { url: string }; whatsapp?: { url: string } }
  ok('webhook-urls endpoint', wu.status === 200 && wuJson.success && /\/api\/webhooks\/esms$/.test(wuJson.sms?.url ?? ''), `sms=${wuJson.sms?.url}`)

  // 6. GET configs — masked key present
  const cfg = await fetch(`${API}/api/admin/providers`, { headers: auth })
  const cfgJson = await cfg.json() as { success: boolean; channels?: Array<{ channel: string; hasApiKey: boolean; enabled: boolean }> }
  const smsCfg = cfgJson.channels?.find(c => c.channel === 'SMS')
  ok('GET /admin/providers masked config', cfg.status === 200 && cfgJson.success && smsCfg?.hasApiKey === true)

  // 7. Reset channels (disable + clear) so the sandbox stays clean
  await fetch(`${API}/api/admin/providers/SMS`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, apiKey: '', senderId: '', extra: { webhookSigningSecret: undefined } }),
  })
  await fetch(`${API}/api/admin/providers/WHATSAPP`, {
    method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: false, apiKey: '', phoneNumberId: '', accountId: '', extra: { webhookVerifyToken: undefined, metaAppSecret: undefined } }),
  })
  results.push('cleanup: channels disabled + secrets cleared')

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL'))
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASSED')
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => { console.error('E2E crashed:', e); process.exit(1) })
