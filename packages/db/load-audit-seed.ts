// R-audit: seed 90 days of realistic load for capacity benchmarking.
// Usage: cd /home/z/my-project/packages/db && DATABASE_URL=... bun /home/z/.audit-tmp/seed-load.ts
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const AGENCY = process.env.AGENCY_ID || "cmvex997i001ipxku32q3gpqa";
const DAYS = 90;
const PER_DAY = 120; // ≈ 10,800 reservations total

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

async function main() {
  const agency = await db.agency.findUnique({ where: { id: AGENCY } });
  if (!agency) throw new Error("agency not found");

  const svcNames = ["Consultation", "Dossier", "Paiement"];
  const services = [];
  for (const name of svcNames) {
    const s = await db.service.upsert({
      where: { agencyId_name: { agencyId: AGENCY, name } },
      update: {},
      create: { agencyId: AGENCY, name, prefix: name[0], isActive: true },
    });
    services.push(s);
  }

  let branch = await db.branch.findFirst({ where: { agencyId: AGENCY } });
  if (!branch) branch = await db.branch.create({ data: { agencyId: AGENCY, name: "Main", subCode: "MYA01", isMain: true } });

  const counters = [];
  for (let i = 0; i < 4; i++) {
    const name = `Counter ${i + 1}`;
    let c = await db.counter.findFirst({ where: { branchId: branch.id, name } });
    if (!c) c = await db.counter.create({ data: { branchId: branch.id, number: i + 1, name, isActive: true } });
    counters.push(c);
  }

  const customers = [];
  for (let i = 0; i < 30; i++) {
    const uname = `loaduser${i}`;
    const u = await db.user.upsert({
      where: { username: uname },
      update: {},
      create: { username: uname, email: `${uname}@load.test`, passwordHash: "x", role: "CUSTOMER", fullName: `Load User ${i}`, phoneNumber: `+21360000${String(i).padStart(4, "0")}`, phoneVerified: true },
    });
    customers.push(u);
  }

  const today = new Date();
  let created = 0;
  let batch = [];
  for (let day = DAYS; day >= 0; day--) {
    const d = new Date(today.getTime() - day * 86400000);
    const dateStr = d.toISOString().slice(0, 10);
    const isToday = day === 0;
    for (let n = 1; n <= PER_DAY; n++) {
      const svc = pick(services);
      const status = isToday
        ? (n <= 15 ? "COMPLETED" : n <= 18 ? "CALLED" : "WAITING")
        : pick(["COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "COMPLETED", "CANCELLED", "NO_SHOW"]);
      const joinedAt = new Date(d.getTime());
      joinedAt.setHours(8 + Math.floor(n / 20), (n % 20) * 3, 0, 0);
      const calledAt = new Date(joinedAt.getTime() + 5 + Math.random() * 30 * 60000);
      const completedAt = status === "COMPLETED" ? new Date(calledAt.getTime() + 2 + Math.random() * 10 * 60000) : null;
      batch.push({
        agencyId: AGENCY, serviceId: svc.id,
        userId: customers[n % customers.length].id,
        queueNumber: n, displayNumber: `${svc.prefix}-${String(n).padStart(3, "0")}`,
        status, reservedDate: dateStr,
        joinedAt, calledAt: status === "WAITING" ? null : calledAt,
        completedAt, estimatedWait: 10,
        isWalkIn: n % 7 === 0, walkInCustomerName: n % 7 === 0 ? `Walk-in ${n}` : null,
        rating: status === "COMPLETED" && Math.random() < 0.4 ? 3 + Math.round(Math.random() * 2) : null,
      });
      created++;
      if (batch.length >= 2000) { await db.reservation.createMany({ data: batch }); batch = []; }
    }
  }
  if (batch.length) await db.reservation.createMany({ data: batch });

  const actives = await db.reservation.findMany({ where: { agencyId: AGENCY, status: { in: ["WAITING", "CALLED"] } }, take: 40 });
  await db.notification.createMany({
    data: actives.map((r, i) => ({
      userId: r.userId, type: "QUEUE_JOINED", title: "Reservation Confirmed",
      message: `Ticket ${r.displayNumber}`, isRead: i % 3 === 0, createdAt: new Date(),
    })),
  });
  await db.auditLog.createMany({
    data: actives.map((r) => ({
      userId: r.userId, action: "QUEUE_JOINED", entityType: "Reservation", entityId: r.id, createdAt: new Date(),
    })),
  });
  await db.smsLog.createMany({
    data: actives.slice(0, 30).map((r) => ({
      userId: r.userId, phoneNumber: "+213600000000", message: "test", status: "SENT", createdAt: new Date(),
    })),
  });

  const total = await db.reservation.count({ where: { agencyId: AGENCY } });
  const notifs = await db.notification.count();
  console.log(`seeded: services=${services.length} counters=${counters.length} customers=${customers.length} reservations=${created} (agency total ${total}) notifications=${notifs}`);
}

main().finally(() => db.$disconnect());
