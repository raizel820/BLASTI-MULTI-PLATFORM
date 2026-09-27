import { db } from '@blasti/db'
const count = await db.dataUsageEvent.count()
console.log('dataUsageEvent rows:', count)
await db.$disconnect()
