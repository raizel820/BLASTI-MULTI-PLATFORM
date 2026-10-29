/**
 * E2E verification for the messaging provider webhooks + admin test flow.
 * Run: bun run tests/test-messaging-webhooks.e2e.ts  (from apps/api)
 */
import { db } from '@blasti/db'
import { encrypt } from '../src/lib/encryption'

const API = 'http://127.0.0.1:3003'
const { createHmac } = await import('crypto')

function hmac(secret: string, body: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex')
}

async function main() {
  const results: string[] = []
  const ok = (name: string, pass: boolean, extra = '') =>
    results.push(`${pass ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`)

  // ── 1. eSMS DLR correlates by providerMessageId ──
  const log1 = await db.smsLog.create({
    data: {
      phoneNumber: '+213555000111',
      message: 'e2e dlr test',
      status: 'SENT',
      provider: 'esmsafrica',
      providerMessageId: 'msg-e2e-1',
    },
  })
  let res = await fetch(`${API}/api/webhooks/esms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'message.delivered', message_id: 'msg-e2e-1', status: 'delivered' }),
  })
  const j1 = await res.json() as { success: boolean; correlated: boolean }
  ok('eSMS DLR accepted', res.status === 200 && j1.success)
  ok('eSMS DLR correlated', j1.correlated === true)
  const after1 = await db.smsLog.findUnique({ where: { id: log1.id } })
  ok('eSMS log → DELIVERED', after1?.status === 'DELIVERED', `status=${after1?.status}`)

  // ── 2. eSMS signature enforcement once the signing secret is stored ──
  await db.providerConfig.upsert({
    where: { channel: 'SMS' },
    create: { channel: 'SMS', provider: 'esmsafrica', extraConfig: JSON.stringify({ webhookSigningSecret: encrypt('whsec_e2e_secret') }) },
    update: { extraConfig: JSON.stringify({ webhookSigningSecret: encrypt('whsec_e2e_secret') }) },
  })
  const body2 = JSON.stringify({ event: 'message.failed', message_id: 'msg-e2e-1', status: 'failed', error_code: 'X' })
  const resUnsigned = await fetch(`${API}/api/webhooks/esms`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body2,
  })
  ok('eSMS unsigned rejected when secret set', resUnsigned.status === 401, `status=${resUnsigned.status}`)
  const resSigned = await fetch(`${API}/api/webhooks/esms`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': hmac('whsec_e2e_secret', body2) },
    body: body2,
  })
  ok('eSMS signed accepted', resSigned.status === 200)
  const after2 = await db.smsLog.findUnique({ where: { id: log1.id } })
  ok('eSMS forward-only: DELIVERED not downgraded', after2?.status === 'DELIVERED', `status=${after2?.status}`)
  await db.providerConfig.update({ where: { channel: 'SMS' }, data: { extraConfig: '{}' } }).catch(() => {})

  // ── 3. WhatsApp status correlates by wamid ──
  const log3 = await db.smsLog.create({
    data: {
      phoneNumber: '+213555000222',
      message: 'e2e wa status test',
      status: 'SENT',
      provider: 'whatsapp',
      providerMessageId: 'wamid.e2e.1',
    },
  })
  res = await fetch(`${API}/api/webhooks/whatsapp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      object: 'whatsapp_business_account',
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.e2e.1', status: 'read', recipient_id: '213555000222' }] } }] }],
    }),
  })
  const j3 = await res.json() as { success: boolean; correlated: number }
  ok('WhatsApp status accepted', res.status === 200 && j3.success)
  ok('WhatsApp status correlated', j3.correlated === 1, `correlated=${j3.correlated}`)
  const after3 = await db.smsLog.findUnique({ where: { id: log3.id } })
  ok('WhatsApp log → READ', after3?.status === 'READ', `status=${after3?.status}`)

  // ── 4. WhatsApp GET verification handshake ──
  await db.providerConfig.upsert({
    where: { channel: 'WHATSAPP' },
    create: { channel: 'WHATSAPP', provider: 'meta_whatsapp', extraConfig: JSON.stringify({ webhookVerifyToken: encrypt('e2e-verify-token') }) },
    update: { extraConfig: JSON.stringify({ webhookVerifyToken: encrypt('e2e-verify-token') }) },
  })
  const resVerify = await fetch(`${API}/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=e2e-verify-token&hub.challenge=CHAL-987654`)
  const verifyBody = await resVerify.text()
  ok('WhatsApp GET verification returns challenge', resVerify.status === 200 && verifyBody === 'CHAL-987654', `status=${resVerify.status} body=${verifyBody}`)
  await db.providerConfig.update({ where: { channel: 'WHATSAPP' }, data: { extraConfig: '{}' } }).catch(() => {})

  // ── Cleanup ──
  await db.smsLog.delete({ where: { id: log1.id } })
  await db.smsLog.delete({ where: { id: log3.id } })
  await db.providerConfig.deleteMany({ where: { channel: { in: ['SMS', 'WHATSAPP'] }, apiKey: '', senderId: '', phoneNumberId: '', accountId: '' } }).catch(() => {})

  console.log(results.join('\n'))
  const failed = results.filter(r => r.startsWith('FAIL'))
  console.log(failed.length ? `\n${failed.length} FAILURES` : '\nALL PASSED')
  process.exit(failed.length ? 1 : 0)
}

main().catch(e => { console.error('E2E crashed:', e); process.exit(1) })
