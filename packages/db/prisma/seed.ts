import { db } from '@blasti/db';
import crypto from 'crypto';

/**
 * Hash a password using scrypt (same algorithm as @blasti/api/src/lib/password).
 * Duplicated here to avoid cross-workspace import issues.
 */
function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(password, salt, 64, {
    N: 16384, r: 8, p: 1,
  });
  return `${salt}:${derivedKey.toString('hex')}`;
}

/**
 * Task 34 — FRESH-START SEED (amended by Task 38).
 *
 * Seeds ONLY platform-admin data plus ONE untouched agency account:
 *   1. The single SUPER_ADMIN account → admin / admin123 (admin@blasti.dz)
 *   2. The subscription-plan catalog  → FREE / BASIC / PREMIUM + plan features
 *      (platform data the subscription flow requires — not user accounts)
 *   3. Task 38 — ONE fresh agency account → owner / owner123 (owner@blasti.dz)
 *      with agency "My Agency" (code MYA) in the exact state the real
 *      POST /agencies flow leaves it after creation: empty QueueSettings row
 *      (schema defaults), FREE tier / INACTIVE subscription, and NOTHING else
 *      — no branches, no services, no staff, no counters, no reservations, no
 *      AgencyStaff row (the real create flow resolves the owner via ownerId
 *      and never creates one). Fresh as if the owner just created it.
 *
 * Deliberately creates NO customer accounts, NO demo branches/services/counters/
 * reservations/reviews/notifications/FAQs or global settings rows (the API
 * self-heals its SmsSettings / PaymentSettings singletons on first use).
 *
 * Task 47 — EXPLICIT FRESH-ACCOUNT INITIAL VALUES. A fresh account is
 * intentionally 90% empty: the owner may fill the rest from the webapp OR the
 * desktop, across sessions, while sync keeps both sides converging. To make
 * that safe the seed no longer relies on schema defaults silently — every
 * scalar the UI/sync touches is written EXPLICITLY here, byte-for-byte equal
 * to what the real POST /agencies + POST /auth/register flows produce:
 *   • numeric counters are 0 (never null) — smsBalance 0, queue counters 0;
 *   • text defaults are present (wilaya '28', city "M'Sila", working hours);
 *   • subscription state is FREE + INACTIVE (never a paid tier by accident).
 * This guards against future schema-default drift: if the schema default ever
 * changes, the seed still pins the known-good fresh-account state that the
 * webapp and desktop are hardened against.
 */
async function seed() {
  console.log('🌱 Seeding database (fresh platform setup — admin + one fresh agency)...');

  // ─── Clean up ALL existing data (children first, parents last) ─────────────────
  console.log('🧹 Cleaning existing data...');
  await db.deviceCommand.deleteMany();
  await db.agencyDevice.deleteMany();
  await db.savedTv.deleteMany();
  await db.defaultPrinter.deleteMany();
  await db.localPendingMutation.deleteMany();
  await db.localSyncAppliedMutation.deleteMany();
  await db.localDeferredChange.deleteMany();
  await db.localSyncConflict.deleteMany();
  await db.localSyncMeta.deleteMany();
  await db.agencyLocalState.deleteMany();
  await db.syncChange.deleteMany();
  await db.syncMutation.deleteMany();
  await db.delayedJob.deleteMany();
  await db.fileAsset.deleteMany();
  await db.uploadedFile.deleteMany();
  await db.deletedRecord.deleteMany();
  await db.hardwareOrderItem.deleteMany();
  await db.hardwareOrder.deleteMany();
  await db.enterpriseContractRequest.deleteMany();
  await db.hardwareProduct.deleteMany();
  await db.hardwareCommitmentTier.deleteMany();
  await db.hardwareSettings.deleteMany();
  await db.deviceRegistration.deleteMany();
  await db.localDeviceCredential.deleteMany();
  await db.verificationCode.deleteMany();
  await db.auditLog.deleteMany();
  await db.notification.deleteMany();
  await db.smsLog.deleteMany();
  await db.globalAnnouncement.deleteMany();
  await db.announcement.deleteMany();
  await db.review.deleteMany();
  await db.reservation.deleteMany();
  await db.transaction.deleteMany();
  await db.favorite.deleteMany();
  await db.counter.deleteMany();
  await db.agencyStaff.deleteMany();
  await db.branch.deleteMany();
  await db.queueSettings.deleteMany();
  await db.service.deleteMany();
  await db.smsPurchase.deleteMany();
  await db.smsSettings.deleteMany();
  await db.paymentSettings.deleteMany();
  await db.fAQ.deleteMany();
  await db.providerConfig.deleteMany();
  await db.notificationTemplate.deleteMany();
  await db.systemSetting.deleteMany();
  await db.appVersion.deleteMany();
  await db.agency.deleteMany();
  await db.user.deleteMany();
  await db.planFeature.deleteMany();
  await db.subscriptionPlan.deleteMany();

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 1. Create the Super Admin ─────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👤 Creating super admin...');

  await db.user.create({
    data: {
      username: 'admin',
      fullName: 'Platform Admin',
      passwordHash: hashPassword('admin123'),
      role: 'SUPER_ADMIN',
      language: 'ar',
      email: 'admin@blasti.dz',
      isActive: true,
      // Task 31 (bug 3): SUPER_ADMIN never needs email/phone confirmation.
      emailVerified: true,
      phoneVerified: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 2. Subscription Plans (platform catalog) ─────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('📋 Creating subscription plans...');

  const freePlan = await db.subscriptionPlan.create({
    data: {
      name: 'FREE',
      displayName: 'Free',
      displayNameAr: 'مجاني',
      displayNameFr: 'Gratuit',
      description: 'Basic queue management for small agencies',
      descriptionAr: 'إدارة طوابير أساسية للوكالات الصغيرة',
      descriptionFr: 'Gestion de file basique pour petites agences',
      price: 0,
      currency: 'DZD',
      billingCycle: 'MONTHLY',
      maxServices: 3,
      maxBranches: 1,
      maxStaff: 2,
      maxActiveReservations: 30,
      maxSmsPerMonth: 20,
      kioskModeEnabled: false,
      analyticsEnabled: false,
      priorityListing: false,
      customBranding: false,
      apiAccess: false,
      isActive: true,
      sortOrder: 0,
    },
  });

  const basicPlan = await db.subscriptionPlan.create({
    data: {
      name: 'BASIC',
      displayName: 'Basic',
      displayNameAr: 'أساسي',
      displayNameFr: 'Basique',
      description: 'For growing agencies that need more capacity',
      descriptionAr: 'للوكالات النامية التي تحتاج سعة أكبر',
      descriptionFr: 'Pour les agences en croissance',
      price: 2000,
      currency: 'DZD',
      billingCycle: 'MONTHLY',
      maxServices: 10,
      maxBranches: 2,
      maxStaff: 5,
      maxActiveReservations: 100,
      maxSmsPerMonth: 100,
      kioskModeEnabled: true,
      analyticsEnabled: true,
      priorityListing: false,
      customBranding: false,
      apiAccess: false,
      // Task 32 (bug C): default multi-month discounts so agencies can pay
      // 6/12/24 months upfront out of the box. Admins can tune these in the
      // platform admin plan editor (3-month discount intentionally 0).
      semiAnnualDiscount: 5,
      annualDiscount: 10,
      biennialDiscount: 20,
      isActive: true,
      sortOrder: 1,
    },
  });

  const premiumPlan = await db.subscriptionPlan.create({
    data: {
      name: 'PREMIUM',
      displayName: 'Premium',
      displayNameAr: 'متميز',
      displayNameFr: 'Premium',
      description: 'Full-featured plan for professional agencies',
      descriptionAr: 'خطة كاملة الميزات للوكالات المهنية',
      descriptionFr: 'Plan complet pour agences professionnelles',
      price: 5000,
      currency: 'DZD',
      billingCycle: 'MONTHLY',
      maxServices: -1, // unlimited
      maxBranches: -1,
      maxStaff: -1,
      maxActiveReservations: -1,
      maxSmsPerMonth: 500,
      kioskModeEnabled: true,
      analyticsEnabled: true,
      priorityListing: true,
      customBranding: true,
      apiAccess: true,
      // Task 32 (bug C): same default multi-month discounts as Basic (see above).
      semiAnnualDiscount: 5,
      annualDiscount: 10,
      biennialDiscount: 20,
      isActive: true,
      sortOrder: 2,
    },
  });

  // Create plan features
  const allFeatures = [
    { featureKey: 'kiosk_mode', featureName: 'Kiosk Mode', featureNameAr: 'وضع الكشك', featureNameFr: 'Mode Kiosque' },
    { featureKey: 'analytics', featureName: 'Analytics Dashboard', featureNameAr: 'لوحة التحليلات', featureNameFr: 'Tableau Analytique' },
    { featureKey: 'sms_gateway', featureName: 'SMS Notifications', featureNameAr: 'إشعارات SMS', featureNameFr: 'Notifications SMS' },
    { featureKey: 'priority_listing', featureName: 'Priority Listing', featureNameAr: 'قائمة الأولوية', featureNameFr: 'Affichage Prioritaire' },
    { featureKey: 'custom_branding', featureName: 'Custom Branding', featureNameAr: 'علامة تجارية مخصصة', featureNameFr: 'Marque Personnalisée' },
    { featureKey: 'api_access', featureName: 'API Access', featureNameAr: 'الوصول للواجهة', featureNameFr: 'Accès API' },
    { featureKey: 'multi_branch', featureName: 'Multi-Branch', featureNameAr: 'متعدد الفروع', featureNameFr: 'Multi-Succursales' },
    { featureKey: 'export_data', featureName: 'Data Export', featureNameAr: 'تصدير البيانات', featureNameFr: 'Export Données' },
  ];

  for (const feature of allFeatures) {
    // Free plan features
    await db.planFeature.create({
      data: {
        planId: freePlan.id,
        ...feature,
        enabled: ['sms_gateway'].includes(feature.featureKey),
        limitValue: feature.featureKey === 'sms_gateway' ? 20 : null,
      },
    });
    // Basic plan features
    await db.planFeature.create({
      data: {
        planId: basicPlan.id,
        ...feature,
        enabled: ['kiosk_mode', 'analytics', 'sms_gateway', 'multi_branch', 'export_data'].includes(feature.featureKey),
        limitValue: feature.featureKey === 'sms_gateway' ? 100 : null,
      },
    });
    // Premium plan features — all enabled
    await db.planFeature.create({
      data: {
        planId: premiumPlan.id,
        ...feature,
        enabled: true,
        limitValue: feature.featureKey === 'sms_gateway' ? 500 : null,
      },
    });
  }

  console.log(`   📋 Created 3 subscription plans with ${allFeatures.length * 3} features`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 3. Fresh Agency Account (Task 38) ─────────────────────────────────────
  //   Mirrors the real flow byte-for-byte: a freshly registered AGENCY_OWNER
  //   who has just created ONE agency and done nothing else.
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('🏢 Creating fresh agency account (owner only, no other data)...');

  const owner = await db.user.create({
    data: {
      username: 'owner',
      fullName: 'Agency Owner',
      passwordHash: hashPassword('owner123'),
      role: 'AGENCY_OWNER',
      email: 'owner@blasti.dz',
      // Task 47 — explicit fresh-account initial values (mirror POST
      // /auth/register defaults). wilaya/commune stay NULL: a real fresh
      // registration only sets them when the user picks them, and both apps
      // treat null address as "not set yet" (UI shows the empty selector).
      language: 'ar',
      freeSmsCount: 10,
      reminderMinutes: 10,
      // Deviation note: a literally-fresh registration is unverified until the
      // email/phone OTP passes (Task 22). The seeded account is pre-verified —
      // same precedent as the super admin (Task 31-A) — so it can log in and
      // be used immediately without an OTP round-trip.
      emailVerified: true,
      phoneVerified: true,
    },
    select: { id: true },
  });

  await db.agency.create({
    data: {
      name: 'My Agency',
      // Exactly what the real auto-derive produces: name.slice(0, 3).toUpperCase()
      customCode: 'MYA',
      // Route default when the create form omits a category
      category: 'OTHER',
      ownerId: owner.id,
      // ── Task 47 — EXPLICIT initial values, identical to the schema
      // defaults the real POST /agencies flow lands on. Written out so a
      // future schema-default change can never silently re-shape the
      // fresh-account state the webapp + desktop sync rely on.
      //
      // Address: Algeria defaults (wilaya 28 = M'Sila) — same as the create
      // route when the wizard omits the address step.
      wilaya: '28',
      city: "M'Sila",
      // Working schedule defaults.
      workingHoursStart: '08:00',
      workingHoursEnd: '17:00',
      workingDays: '1,2,3,4,5',
      // Subscription: never-paid fresh agency → built-in FREE tier,
      // INACTIVE status, no plan row, zero SMS balance.
      subscriptionTier: 'FREE',
      subscriptionStatus: 'INACTIVE',
      smsBalance: 0,
      // Capacity/service defaults (queue engine + analytics read these).
      averageServiceTime: 10,
      maxActiveReservations: 50,
      // Operational flags.
      isQueueOpen: true,
      isActive: true,
      kioskModeEnabled: false,
      autoPauseWhenFull: false,
      isSponsored: false,
      sponsorSms: false,
      // The real POST /agencies always creates the queue settings row with
      // counters at 0 and the queue not paused — now pinned explicitly so
      // "initial value is 0" stays true even if defaults drift.
      queueSettings: {
        create: {
          currentServingNumber: 0,
          lastIssuedNumber: 0,
          isPaused: false,
        },
      },
    },
  });

  console.log('   🏢 Agency "My Agency" (MYA) created — FREE tier, no branches/services/staff');

  console.log('');
  console.log('✅ Fresh seed completed successfully!');
  console.log('');
  console.log('📋 Summary:');
  console.log('   👤 Super Admin: admin / admin123 (admin@blasti.dz)');
  console.log('   👤 Agency Owner: owner / owner123 (owner@blasti.dz) — fresh agency, owner only');
  console.log('   🏢 Agency: "My Agency" (code MYA) — FREE tier · INACTIVE · smsBalance 0 · counters 0 · no branches/services/staff');
  console.log('   📋 Plans: FREE (0 DZD) · BASIC (2,000 DZD/mo) · PREMIUM (5,000 DZD/mo)');
  console.log('      Period discounts: 6 months -5% · 12 months -10% · 24 months -20%');
  console.log('   🚫 No customers / demo data — the agency is exactly as if just created');
}

seed()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
