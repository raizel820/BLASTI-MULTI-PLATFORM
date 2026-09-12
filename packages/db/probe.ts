import { db } from './index'
async function main() {
  const jobs = await db.delayedJob.count()
  const users = await db.user.count()
  console.log('PROBE OK — delayedJob rows:', jobs, '| users:', users)
  await db.$disconnect()
}
main().catch(e => { console.error('PROBE FAIL:', e.message.slice(0, 150)); process.exit(1) })
