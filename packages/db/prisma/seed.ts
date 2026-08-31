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

async function seed() {
  console.log('🌱 Seeding database...');

  // ─── Clean up existing data (order matters for FK constraints) ─────────────────
  console.log('🧹 Cleaning existing data...');
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
  await db.agency.deleteMany();
  await db.user.deleteMany();

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 1. Create Admin User ──────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👤 Creating admin user...');

  const admin = await db.user.create({
    data: {
      username: 'admin',
      fullName: 'Platform Admin',
      passwordHash: hashPassword('admin123'),
      role: 'SUPER_ADMIN',
      language: 'ar',
      email: 'admin@blasti.dz',
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 2. Phase 2: Create Subscription Plans ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('📋 Creating subscription plans...');

  await db.subscriptionPlan.deleteMany();

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

  console.log(`   📋 Created ${3} subscription plans with ${allFeatures.length * 3} features`);

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 3. Create Demo Agency (owned by admin) ───────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('🏢 Creating demo agency...');

  const agency = await db.agency.create({
    data: {
      name: 'BLASTI Demo Agency',
      nameAr: 'بلاصتي وكالة تجريبية',
      nameFr: 'BLASTI Agence Démo',
      customCode: 'DEMO001',
      category: 'AGENCY',
      address: 'M\'Sila, Algeria',
      city: 'M\'Sila',
      wilaya: '28',
      phone: '+213 00 00 00 00',
      email: 'demo@blasti.dz',
      description: 'Welcome to your BLASTI demo agency! This is a fresh setup — customize everything from the agency dashboard.',
      descriptionAr: 'مرحباً بك في وكالتك التجريبية! هذا إعداد جديد — قم بتخصيص كل شيء من لوحة التحكم.',
      descriptionFr: 'Bienvenue dans votre agence démo BLASTI! Configuration fraîche — personnalisez tout depuis le tableau de bord.',
      averageServiceTime: 10,
      maxActiveReservations: 50,
      autoPauseWhenFull: false,
      isSponsored: false,
      subscriptionTier: 'BASIC',
      subscriptionPlanId: basicPlan.id,
      subscriptionStatus: 'TRIAL',
      workingHoursStart: '08:00',
      workingHoursEnd: '17:00',
      isQueueOpen: true,
      isActive: true,
      kioskModeEnabled: false,
      ownerId: admin.id,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 3. Create Main Branch ────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('🌿 Creating main branch...');

  const mainBranch = await db.branch.create({
    data: {
      name: 'Main Branch',
      nameAr: 'الفرع الرئيسي',
      nameFr: 'Branche Principale',
      address: 'M\'Sila, Algeria',
      phone: '+213 00 00 00 00',
      isActive: true,
      isMain: true,
      agencyId: agency.id,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 4. Create Default Counter ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('🔢 Creating default counter...');

  const counter1 = await db.counter.create({
    data: {
      number: 1,
      name: 'Counter 1',
      nameAr: 'الشباك 1',
      nameFr: 'Guichet 1',
      isActive: true,
      branchId: mainBranch.id,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 5. Create Default Service ────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('📋 Creating default service...');

  await db.service.create({
    data: {
      agencyId: agency.id,
      name: 'General Service',
      nameAr: 'خدمة عامة',
      nameFr: 'Service Général',
      description: 'Default general service queue',
      prefix: 'A',
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 6. Create Queue Settings ─────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('⚙️ Creating queue settings...');

  await db.queueSettings.create({
    data: {
      agencyId: agency.id,
      currentServingNumber: 0,
      lastIssuedNumber: 0,
      isPaused: false,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 7. Create Admin as Agency Staff (OWNER role) ────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👨‍💼 Creating admin as agency staff...');

  await db.agencyStaff.create({
    data: {
      userId: admin.id,
      agencyId: agency.id,
      branchId: mainBranch.id,
      role: 'OWNER',
      permissions: JSON.stringify({
        canManageQueue: true,
        canManageServices: true,
        canManageStaff: true,
        canViewAnalytics: true,
        canManageBranches: true,
        canManageWorkingHours: true,
        canExportData: true,
        canManageProfile: true,
      }),
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 8. Create SMS Settings (disabled by default) ────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('📱 Creating SMS settings...');

  await db.smsSettings.create({
    data: {
      provider: 'algeria_sms',
      apiUrl: '',
      apiKey: '',
      senderName: 'BLASTI',
      enabled: false,
      smsPerReminder: 1,
      maxSmsPerDay: 5,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 9. Create Payment Settings (disabled by default) ────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('💳 Creating payment settings...');

  await db.paymentSettings.create({
    data: {
      ccpEnabled: false,
      bankEnabled: false,
      electronicEnabled: false,
      ccpAccount: '',
      ccpKey: '',
      bankName: '',
      bankAccount: '',
      bankRib: '',
      ewalletNumber: '',
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 10. Create FAQ Entries ──────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('❓ Creating FAQ entries...');

  const faqs = [
    {
      question: 'How do I join a queue?',
      questionAr: 'كيف أنضم إلى الطابور؟',
      questionFr: 'Comment rejoindre la file d\'attente?',
      answer: 'Search for the agency, select the service you need, and tap "Join Queue". You\'ll get a ticket number and estimated wait time.',
      answerAr: 'ابحث عن الوكالة، اختر الخدمة التي تحتاجها، واضغط "انضمام للطابور". ستحصل على رقم تذكرة ووقت الانتظار المتوقع.',
      answerFr: 'Recherchez l\'agence, sélectionnez le service dont vous avez besoin, et appuyez sur "Rejoindre la file". Vous recevrez un numéro de ticket et un temps d\'attente estimé.',
      category: 'QUEUE',
      order: 1,
    },
    {
      question: 'How do I cancel my reservation?',
      questionAr: 'كيف ألغي حجزي؟',
      questionFr: 'Comment annuler ma réservation?',
      answer: 'Go to "My Queue" and tap "Cancel" on your active ticket. You can cancel at any time before being called.',
      answerAr: 'اذهب إلى "طابوري" واضغط "إلغاء" على التذكرة النشطة. يمكنك الإلغاء في أي وقت قبل أن يُنادى دورك.',
      answerFr: 'Allez dans "Ma file" et appuyez sur "Annuler" sur votre ticket actif. Vous pouvez annuler à tout moment avant d\'être appelé.',
      category: 'QUEUE',
      order: 2,
    },
    {
      question: 'What subscription plans are available?',
      questionAr: 'ما هي خطط الاشتراك المتاحة؟',
      questionFr: 'Quels plans d\'abonnement sont disponibles?',
      answer: 'BLASTI offers three plans: Basic (free, 1 branch, 50 reservations/day), Premium (5 branches, unlimited reservations), and Enterprise (unlimited everything with priority support).',
      answerAr: 'بلاصتي تقدم ثلاث خطط: أساسي (مجاني، فرع واحد، 50 حجز/يوم)، مميز (5 فروع، حجز غير محدود)، ومؤسسي (غير محدود مع دعم أولوي).',
      answerFr: 'BLASTI propose trois plans: Basique (gratuit, 1 branche, 50 réservations/jour), Premium (5 branches, réservations illimitées), et Entreprise (illimité avec support prioritaire).',
      category: 'SUBSCRIPTION',
      order: 3,
    },
    {
      question: 'How do I pay for a subscription?',
      questionAr: 'كيف أدفع الاشتراك؟',
      questionFr: 'Comment payer un abonnement?',
      answer: 'Go to Subscription in your agency dashboard, choose a plan, and select your payment method (CCP, bank transfer, or e-wallet). Follow the instructions to complete the payment.',
      answerAr: 'اذهب إلى الاشتراك في لوحة تحكم الوكالة، اختر خطة، واختر طريقة الدفع (بريد، تحويل بنكي، أو محفظة إلكترونية). اتبع التعليمات لإتمام الدفع.',
      answerFr: 'Allez dans Abonnement dans votre tableau de bord d\'agence, choisissez un plan, et sélectionnez votre méthode de paiement (CCP, virement bancaire, ou e-portefeuille).',
      category: 'PAYMENT',
      order: 4,
    },
    {
      question: 'How do SMS notifications work?',
      questionAr: 'كيف تعمل إشعارات الرسائل القصيرة؟',
      questionFr: 'Comment fonctionnent les notifications SMS?',
      answer: 'When enabled, BLASTI sends SMS reminders when your turn is approaching and when it\'s your turn. Agency owners can configure SMS settings from the dashboard.',
      answerAr: 'عند التفعيل، بلاصتي ترسل تذكيرات بالرسائل القصيرة عندما يقترب دورك وعندما يحين دورك. يمكن لملاك الوكالات تهيئة الإعدادات من لوحة التحكم.',
      answerFr: 'Une fois activés, BLASTI envoie des rappels SMS lorsque votre tour approche et quand c\'est votre tour. Les propriétaires d\'agences peuvent configurer les paramètres SMS.',
      category: 'SMS',
      order: 5,
    },
    {
      question: 'What is the no-show policy?',
      questionAr: 'ما هي سياسة عدم الحضور؟',
      questionFr: 'Quelle est la politique d\'absence?',
      answer: 'If you don\'t show up when your number is called, your ticket will be marked as no-show. You can reclaim your position within a limited time from the app.',
      answerAr: 'إذا لم تحضر عندما يُنادى رقمك، ستُعلّم تذكرتك بعدم الحضور. يمكنك استعادة موقعك خلال وقت محدود من التطبيق.',
      answerFr: 'Si vous ne vous présentez pas quand votre numéro est appelé, votre ticket sera marqué comme absent. Vous pouvez récupérer votre position dans un délai limité.',
      category: 'QUEUE',
      order: 6,
    },
    {
      question: 'How do I create an agency account?',
      questionAr: 'كيف أنشئ حساب وكالة؟',
      questionFr: 'Comment créer un compte d\'agence?',
      answer: 'Register with the "Agency" tab, then create your agency from the dashboard. You can add branches, services, and staff members.',
      answerAr: 'سجّل من تبويب "الوكالة"، ثم أنشئ وكالتك من لوحة التحكم. يمكنك إضافة فروع وخدمات وموظفين.',
      answerFr: 'Inscrivez-vous avec l\'onglet "Agence", puis créez votre agence depuis le tableau de bord. Vous pouvez ajouter des branches, services et employés.',
      category: 'GENERAL',
      order: 7,
    },
  ];

  for (const faq of faqs) {
    await db.fAQ.create({ data: faq });
  }

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 11. No initial announcements (clean slate) ─────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  // Announcements are NOT created — admin can create them from the dashboard

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 13. Create Customer Test User ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👤 Creating customer test user...');

  const customer = await db.user.create({
    data: {
      username: 'customer1',
      fullName: 'أحمد محمد',
      passwordHash: hashPassword('customer123'),
      role: 'CUSTOMER',
      language: 'ar',
      phoneNumber: '+213 555 000 001',
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 13b. Create Agency Owner User ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👨‍💼 Creating agency owner user...');

  const agencyOwner = await db.user.create({
    data: {
      username: 'owner1',
      fullName: 'كريم بن علي',
      passwordHash: hashPassword('owner123'),
      role: 'AGENCY_OWNER',
      language: 'ar',
      phoneNumber: '+213 555 000 002',
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 13c. Create Agency Staff User ────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('👨‍💼 Creating agency staff user...');

  const agencyStaffUser = await db.user.create({
    data: {
      username: 'staff1',
      fullName: 'سارة أحمد',
      passwordHash: hashPassword('staff123'),
      role: 'AGENCY_STAFF',
      language: 'ar',
      phoneNumber: '+213 555 000 003',
      isActive: true,
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 13d. Create Additional Demo Agencies ─────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  console.log('🏢 Creating additional demo agencies...');

  const clinicAgency = await db.agency.create({
    data: {
      name: 'Al Salam Clinic',
      nameAr: 'عيادة السلام',
      nameFr: 'Clinique Al Salam',
      customCode: 'CLINIC001',
      category: 'CLINIC',
      address: 'Algiers, Algeria',
      city: 'Algiers',
      wilaya: '16',
      phone: '+213 21 00 00 01',
      email: 'info@alsalam-clinic.dz',
      description: 'A modern clinic offering general and specialized medical consultations.',
      descriptionAr: 'عيادة حديثة تقدم استشارات طبية عامة ومتخصصة.',
      descriptionFr: 'Une clinique moderne offrant des consultations médicales générales et spécialisées.',
      averageServiceTime: 15,
      maxActiveReservations: 80,
      autoPauseWhenFull: true,
      isSponsored: true,
      subscriptionTier: 'PREMIUM',
      subscriptionPlanId: premiumPlan.id,
      subscriptionStatus: 'ACTIVE',
      workingHoursStart: '08:00',
      workingHoursEnd: '18:00',
      isQueueOpen: true,
      isActive: true,
      kioskModeEnabled: true,
      ownerId: agencyOwner.id,
    },
  });

  const labAgency = await db.agency.create({
    data: {
      name: 'Lab Express M\'Sila',
      nameAr: 'مختبر إكسبريس المسيلة',
      nameFr: 'Lab Express M\'Sila',
      customCode: 'LAB001',
      category: 'LABORATORY',
      address: 'M\'Sila, Algeria',
      city: 'M\'Sila',
      wilaya: '28',
      phone: '+213 35 00 00 01',
      email: 'contact@labexpress.dz',
      description: 'Fast medical testing laboratory with same-day results for most tests.',
      descriptionAr: 'مختبر تحاليل طبية سريع مع نتائج نفس اليوم لمعظم الفحوصات.',
      descriptionFr: 'Laboratoire d\'analyses médicales rapide avec résultats le jour même.',
      averageServiceTime: 8,
      maxActiveReservations: 60,
      autoPauseWhenFull: false,
      isSponsored: false,
      subscriptionTier: 'BASIC',
      subscriptionPlanId: basicPlan.id,
      subscriptionStatus: 'ACTIVE',
      workingHoursStart: '07:00',
      workingHoursEnd: '16:00',
      isQueueOpen: true,
      isActive: true,
      kioskModeEnabled: false,
      ownerId: agencyOwner.id,
    },
  });

  const govAgency = await db.agency.create({
    data: {
      name: 'Wilaya Citizenship Office',
      nameAr: 'مكتب المواطنة بالولاية',
      nameFr: 'Bureau de Citoyenneté de Wilaya',
      customCode: 'GOV001',
      category: 'GOVERNMENT',
      address: 'M\'Sila, Algeria',
      city: 'M\'Sila',
      wilaya: '28',
      phone: '+213 35 00 00 02',
      email: 'citizenship@wilaya-msila.dz',
      description: 'Government office for civil documents, ID cards, and administrative procedures.',
      descriptionAr: 'مكتب حكومي للوثائق المدنية وبطاقات الهوية والإجراءات الإدارية.',
      descriptionFr: 'Bureau gouvernemental pour documents civils et procédures administratives.',
      averageServiceTime: 20,
      maxActiveReservations: 100,
      autoPauseWhenFull: true,
      isSponsored: false,
      subscriptionTier: 'FREE',
      subscriptionPlanId: freePlan.id,
      subscriptionStatus: 'ACTIVE',
      workingHoursStart: '09:00',
      workingHoursEnd: '15:00',
      isQueueOpen: true,
      isActive: true,
      kioskModeEnabled: false,
      ownerId: admin.id,
    },
  });

  // Create branches for additional agencies
  const clinicBranch = await db.branch.create({
    data: { name: 'Main Clinic', nameAr: 'العيادة الرئيسية', nameFr: 'Clinique Principale', address: 'Algiers, Algeria', phone: '+213 21 00 00 01', isActive: true, isMain: true, agencyId: clinicAgency.id },
  });

  const labBranch = await db.branch.create({
    data: { name: 'Main Lab', nameAr: 'المختبر الرئيسي', nameFr: 'Lab Principal', address: 'M\'Sila, Algeria', phone: '+213 35 00 00 01', isActive: true, isMain: true, agencyId: labAgency.id },
  });

  const govBranch = await db.branch.create({
    data: { name: 'Main Office', nameAr: 'المكتب الرئيسي', nameFr: 'Bureau Principal', address: 'M\'Sila, Algeria', phone: '+213 35 00 00 02', isActive: true, isMain: true, agencyId: govAgency.id },
  });

  // Create counters for additional agencies
  await db.counter.create({ data: { number: 1, name: 'Reception', nameAr: 'الاستقبال', nameFr: 'Réception', isActive: true, branchId: clinicBranch.id } });
  await db.counter.create({ data: { number: 2, name: 'Consultation 1', nameAr: 'استشارة 1', nameFr: 'Consultation 1', isActive: true, branchId: clinicBranch.id } });
  await db.counter.create({ data: { number: 1, name: 'Sample Collection', nameAr: 'جمع العينات', nameFr: 'Prélèvement', isActive: true, branchId: labBranch.id } });
  await db.counter.create({ data: { number: 1, name: 'Window 1', nameAr: 'الشباك 1', nameFr: 'Guichet 1', isActive: true, branchId: govBranch.id } });
  await db.counter.create({ data: { number: 2, name: 'Window 2', nameAr: 'الشباك 2', nameFr: 'Guichet 2', isActive: true, branchId: govBranch.id } });

  // Create services for additional agencies
  await db.service.create({ data: { agencyId: clinicAgency.id, name: 'General Consultation', nameAr: 'استشارة عامة', nameFr: 'Consultation Générale', description: 'General medical consultation', prefix: 'C', isActive: true } });
  await db.service.create({ data: { agencyId: clinicAgency.id, name: 'Specialist Consultation', nameAr: 'استشارة متخصصة', nameFr: 'Consultation Spécialisée', description: 'Specialist medical consultation', prefix: 'S', isActive: true } });
  await db.service.create({ data: { agencyId: labAgency.id, name: 'Blood Test', nameAr: 'تحليل الدم', nameFr: 'Analyse Sanguine', description: 'Complete blood count and analysis', prefix: 'L', isActive: true } });
  await db.service.create({ data: { agencyId: govAgency.id, name: 'ID Card', nameAr: 'بطاقة الهوية', nameFr: 'Carte d\'Identité', description: 'ID card application and renewal', prefix: 'G', isActive: true } });
  await db.service.create({ data: { agencyId: govAgency.id, name: 'Civil Documents', nameAr: 'وثائق مدنية', nameFr: 'Documents Civils', description: 'Birth certificates, marriage certificates, etc.', prefix: 'D', isActive: true } });

  // Create queue settings for additional agencies
  await db.queueSettings.create({ data: { agencyId: clinicAgency.id, currentServingNumber: 5, lastIssuedNumber: 12, isPaused: false } });
  await db.queueSettings.create({ data: { agencyId: labAgency.id, currentServingNumber: 3, lastIssuedNumber: 8, isPaused: false } });
  await db.queueSettings.create({ data: { agencyId: govAgency.id, currentServingNumber: 15, lastIssuedNumber: 25, isPaused: false } });

  // Create staff entries for additional agencies
  await db.agencyStaff.create({
    data: {
      userId: agencyOwner.id,
      agencyId: clinicAgency.id,
      branchId: clinicBranch.id,
      role: 'OWNER',
      permissions: JSON.stringify({ canManageQueue: true, canManageServices: true, canManageStaff: true, canViewAnalytics: true, canManageBranches: true, canManageWorkingHours: true, canExportData: true, canManageProfile: true }),
      isActive: true,
    },
  });

  await db.agencyStaff.create({
    data: {
      userId: agencyOwner.id,
      agencyId: labAgency.id,
      branchId: labBranch.id,
      role: 'OWNER',
      permissions: JSON.stringify({ canManageQueue: true, canManageServices: true, canManageStaff: true, canViewAnalytics: true, canManageBranches: true, canManageWorkingHours: true, canExportData: true, canManageProfile: true }),
      isActive: true,
    },
  });

  await db.agencyStaff.create({
    data: {
      userId: agencyStaffUser.id,
      agencyId: clinicAgency.id,
      branchId: clinicBranch.id,
      role: 'STAFF',
      permissions: JSON.stringify({ canManageQueue: true, canManageServices: false, canManageStaff: false, canViewAnalytics: true, canManageBranches: false, canManageWorkingHours: false, canExportData: false, canManageProfile: false }),
      isActive: true,
    },
  });

  // Create some sample reservations for the demo
  console.log('🎫 Creating sample reservations...');

  // Get service IDs for reservations
  const generalService = await db.service.findFirst({ where: { agencyId: agency.id } });
  const clinicService = await db.service.findFirst({ where: { agencyId: clinicAgency.id } });
  const govService = await db.service.findFirst({ where: { agencyId: govAgency.id } });

  const sampleReservations = [
    { userId: customer.id, agencyId: agency.id, serviceId: generalService?.id || '', queueNumber: 1, displayNumber: 'A001', status: 'SERVED', joinedAt: new Date(Date.now() - 86400000 * 3), completedAt: new Date(Date.now() - 86400000 * 3 + 600000) },
    { userId: customer.id, agencyId: clinicAgency.id, serviceId: clinicService?.id || '', queueNumber: 3, displayNumber: 'C003', status: 'SERVED', joinedAt: new Date(Date.now() - 86400000 * 1), completedAt: new Date(Date.now() - 86400000 * 1 + 900000) },
    { userId: customer.id, agencyId: govAgency.id, serviceId: govService?.id || '', queueNumber: 22, displayNumber: 'G022', status: 'WAITING', joinedAt: new Date() },
  ];

  for (const res of sampleReservations) {
    await db.reservation.create({ data: res });
  }

  // Create some sample reviews
  console.log('⭐ Creating sample reviews...');

  await db.review.create({ data: { userId: customer.id, agencyId: agency.id, rating: 4, comment: 'Good service, short wait time', createdAt: new Date(Date.now() - 86400000 * 2) } });
  await db.review.create({ data: { userId: customer.id, agencyId: clinicAgency.id, rating: 5, comment: 'Excellent clinic, very organized', createdAt: new Date(Date.now() - 86400000 * 1) } });

  // Create sample notification for the customer
  console.log('🔔 Creating sample notifications...');

  await db.notification.create({ data: { userId: customer.id, title: 'Your turn is approaching!', message: 'You are position 3 at Al Salam Clinic', type: 'QUEUE_UPDATE', isRead: false, createdAt: new Date() } });
  await db.notification.create({ data: { userId: customer.id, title: 'Welcome to BLASTI!', message: 'Start by finding an agency near you', type: 'SYSTEM', isRead: false, createdAt: new Date(Date.now() - 3600000) } });
  await db.notification.create({ data: { userId: customer.id, title: 'Queue update', message: 'Your position at Wilaya Office is now 7', type: 'QUEUE_UPDATE', isRead: true, createdAt: new Date(Date.now() - 7200000) } });

  // ═══════════════════════════════════════════════════════════════════════════════
  // ─── 14. No initial audit logs (clean slate) ────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════════
  // Audit logs are NOT created — they'll be generated organically as users interact

  console.log('');
  console.log('✅ Seed completed successfully!');
  console.log('');
  console.log('📋 Summary:');
  console.log('   👤 Admin user: admin / admin123');
  console.log(`   👤 Customer user: customer1 / customer123`);
  console.log(`   👤 Agency Owner: owner1 / owner123`);
  console.log(`   👤 Agency Staff: staff1 / staff123`);
  console.log(`   🏢 Demo agency: ${agency.name} (${agency.customCode})`);
  console.log(`   🏢 Clinic: ${clinicAgency.name} (${clinicAgency.customCode})`);
  console.log(`   🏢 Lab: ${labAgency.name} (${labAgency.customCode})`);
  console.log(`   🏢 Gov Office: ${govAgency.name} (${govAgency.customCode})`);
  console.log(`   🌿 Main branch: ${mainBranch.name}`);
  console.log(`   🔢 Counter: ${counter1.name}`);
  console.log('   📋 Services: General, Consultation, Blood Test, ID Card, Civil Docs');
  console.log('   🎫 Sample reservations: 3 (1 active, 2 served)');
  console.log('   ⭐ Sample reviews: 2');
  console.log('   🔔 Sample notifications: 3');
  console.log('   ⚙️ Queue settings: initialized with sample data');
  console.log('   📱 SMS settings: disabled');
  console.log('   💳 Payment settings: disabled');
  console.log(`   ❓ FAQs: ${faqs.length} entries`);
  console.log('   📢 Announcements: none (clean slate)');
  console.log('   📝 Audit logs: none (clean slate)');
}

seed()
  .catch((e) => {
    console.error('❌ Seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
