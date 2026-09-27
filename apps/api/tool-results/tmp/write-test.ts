import { db } from '@blasti/db'
try {
  const ev = await db.dataUsageEvent.create({ data: { uploadBytes: 1, downloadBytes: 1, trafficType: 'API', networkType: 'UNKNOWN', path: '/diag/write-test' } })
  console.log('WRITE OK:', ev.id)
  await db.dataUsageEvent.delete({ where: { id: ev.id } })
  console.log('DELETE OK — fresh process CAN write')
} catch (e) {
  console.error('WRITE FAILED:', e instanceof Error ? e.message.split('\n').slice(0,4).join(' | ') : e)
}
await db.$disconnect()
