import { db } from '@blasti/db'
const users = await db.user.findMany({ select: { username: true, role: true } })
const agencies = await db.agency.findMany({ select: { name: true, customCode: true, wilaya: true, subscriptionTier: true } })
const usage = await db.dataUsageEvent.count()
console.log('users:', JSON.stringify(users))
console.log('agencies:', JSON.stringify(agencies))
console.log('dataUsageEvents:', usage)
await db.$disconnect()
