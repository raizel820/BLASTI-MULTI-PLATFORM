import { db } from '@blasti/db'
const ev = await db.dataUsageEvent.create({ data: { path: '/write-test', method: 'GET', status: 200 } })
console.log('fresh-process write OK:', ev.id)
const cnt = await db.dataUsageEvent.count()
console.log('dataUsageEvent count:', cnt)
await db.dataUsageEvent.delete({ where: { id: ev.id } })
console.log('cleanup OK, count now:', await db.dataUsageEvent.count())
process.exit(0)
