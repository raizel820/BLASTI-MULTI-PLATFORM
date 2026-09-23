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
 * Task 34 — FRESH-START SEED.
 *
 * Seeds ONLY platform-admin data:
 *   1. The single SUPER_ADMIN account → admin / admin123 (admin@blasti.dz)
 *   2. The subscription-plan catalog  → FREE / BASIC / PREMIUM + plan features
 *      (platform data the subscription flow requires — not user accounts)
 *
 * Deliberately creates NO customer / agency-owner / staff accounts, NO demo
 * agencies, branches, services, counters, reservations, reviews, notifications,
 * FAQs or global settings rows (the API self-heals its SmsSettings /
 * PaymentSettings singletons on first use). After a reset the database contains
 * exactly ONE account: the super admin. Everything else is created by real usage.
 */
async function seed() {
  console.log('🌱 Seeding database (fresh platform setup — admin only)...');

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
  // ─── 1. Create the (only) Admin User ──────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👤 Creating super admin (the only account)...');

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

  console.log('');
  console.log('✅ Fresh seed completed successfully!');
  console.log('');
  console.log('📋 Summary:');
  console.log('   👤 Super Admin: admin / admin123 (admin@blasti.dz) — the ONLY account');
  console.log('   📋 Plans: FREE (0 DZD) · BASIC (2,000 DZD/mo) · PREMIUM (5,000 DZD/mo)');
  console.log('      Period discounts: 6 months -5% · 12 months -10% · 24 months -20%');
  console.log('   🚫 No customers / agency owners / staff / demo agencies (fresh start)');
}

seed()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
