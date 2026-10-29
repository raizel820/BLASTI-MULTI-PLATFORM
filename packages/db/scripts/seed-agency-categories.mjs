/**
 * Agencies Management — category dictionary seed + legacy backfill.
 *
 * Idempotent — safe to run repeatedly (upserts by slug / (categoryId,nameEn) /
 * (categoryId,key)).
 *
 * What it does:
 *  1. Upserts the 4 BUILT-IN categories (DOCTOR | CLINIC | LAW_FIRM | BARBER)
 *     with slug = the exact key already stored in Agency.category → zero data
 *     migration for existing agencies.
 *  2. Backfills an AgencyCategory row for every legacy Agency.category value
 *     that has no row (old free-text values like BANK/GOVERNMENT that the
 *     normalize script intentionally left untouched) — they become visible,
 *     manageable rows in the new admin Categories Manager.
 *  3. Seeds the Algeria-market specialty catalog for the 4 built-ins
 *     (3 languages per specialty).
 *  4. Seeds default terminology overrides per category (Patient for doctors,
 *     Client for law offices, ...) — editable in the admin
 *     "Agency Categories Language" page.
 */

import { db } from '../index.ts'

const BUILT_INS = [
  {
    slug: 'DOCTOR', name: 'Doctor', nameAr: 'طبيب', nameFr: 'Médecin', icon: '🩺', sortOrder: 1,
  },
  {
    slug: 'CLINIC', name: 'Clinic', nameAr: 'عيادة', nameFr: 'Clinique', icon: '🏥', sortOrder: 2,
  },
  {
    slug: 'LAW_FIRM', name: 'Law Office', nameAr: 'مكتب محاماة', nameFr: 'Cabinet d\u2019avocat', icon: '⚖️', sortOrder: 3,
  },
  {
    slug: 'BARBER', name: 'Barber', nameAr: 'حلاق', nameFr: 'Barbier', icon: '💈', sortOrder: 4,
  },
]

// ─── Algeria-market specialty catalog (nameEn / nameAr / nameFr) ────────────

const DOCTOR_SPECIALTIES = [
  ['General Medicine', 'طب عام', 'Médecine générale'],
  ['Dentist', 'طبيب أسنان', 'Dentiste'],
  ['Cardiology', 'أمراض القلب', 'Cardiologie'],
  ['Dermatology', 'الأمراض الجلدية', 'Dermatologie'],
  ['Pediatrics', 'طب الأطفال', 'Pédiatrie'],
  ['Ophthalmology', 'طب العيون', 'Ophtalmologie'],
  ['ENT', 'أنف وأذن وحنجرة', 'ORL'],
  ['Gynecology & Obstetrics', 'النساء والتوليد', 'Gynécologie-obstétrique'],
  ['Orthopedics', 'جراحة العظام', 'Orthopédie'],
  ['Neurology', 'طب الأعصاب', 'Neurologie'],
  ['Psychiatry', 'الطب النفسي', 'Psychiatrie'],
  ['Urology', 'المسالك البولية', 'Urologie'],
  ['Endocrinology & Diabetes', 'الغدد الصماء والسكري', 'Endocrinologie & Diabétologie'],
  ['Gastroenterology', 'الجهاز الهضمي', 'Gastro-entérologie'],
  ['Pulmonology', 'أمراض الصدر', 'Pneumologie'],
  ['Nephrology', 'أمراض الكلى', 'Néphrologie'],
  ['Rheumatology', 'أمراض المفاصل', 'Rhumatologie'],
  ['Oncology', 'الأورام', 'Oncologie'],
  ['Hematology', 'أمراض الدم', 'Hématologie'],
  ['Allergy & Immunology', 'الحساسية والمناعة', 'Allergologie & Immunologie'],
  ['Infectious Diseases', 'الأمراض المعدية', 'Maladies infectieuses'],
  ['Sports Medicine', 'طب الرياضة', 'Médecine du sport'],
  ['Physical Therapy & Rehabilitation', 'العلاج الطبيعي والتأهيل', 'Kinésithérapie & Rééducation'],
  ['Nutrition & Dietetics', 'التغذية العلاجية', 'Nutrition & Diététique'],
  ['Plastic Surgery', 'الجراحة التجميلية', 'Chirurgie plastique'],
  ['General Surgery', 'الجراحة العامة', 'Chirurgie générale'],
  ['Internal Medicine', 'الطب الباطني', 'Médecine interne'],
  ['Family Medicine', 'طب الأسرة', 'Médecine familiale'],
  ['Geriatrics', 'طب المسنين', 'Gériatrie'],
  ['Occupational Medicine', 'طب العمل', 'Médecine du travail'],
  ['Radiology & Medical Imaging', 'الأشعة والتصوير الطبي', 'Radiologie & Imagerie médicale'],
]

const CLINIC_SPECIALTIES = [
  ['General Clinic', 'عيادة عامة', 'Clinique générale'],
  ['Dental Clinic', 'عيادة أسنان', 'Clinique dentaire'],
  ['Medical Analysis Laboratory', 'مختبر التحاليل الطبية', 'Laboratoire d\u2019analyses médicales'],
  ['Radiology & Imaging Center', 'مركز الأشعة والتصوير', 'Centre d\u2019imagerie médicale'],
  ['Dialysis Center', 'مركز غسيل الكلى', 'Centre de dialyse'],
  ['Physiotherapy Center', 'مركز العلاج الطبيعي', 'Centre de kinésithérapie'],
  ['Ophthalmology Clinic', 'عيادة العيون', 'Clinique ophtalmologique'],
  ['Cardiology Clinic', 'عيادة أمراض القلب', 'Clinique cardiologique'],
  ['Pediatric Clinic', 'عيادة الأطفال', 'Clinique pédiatrique'],
  ['Gynecology Clinic', 'عيادة النساء والتوليد', 'Clinique gynécologique'],
  ['Dermatology Clinic', 'عيادة الأمراض الجلدية', 'Clinique dermatologique'],
  ['ENT Clinic', 'عيادة أنف وأذن وحنجرة', 'Clinique ORL'],
  ['Dental Prosthetics', 'تركيبات الأسنان', 'Prothèse dentaire'],
  ['Orthodontics', 'تقويم الأسنان', 'Orthodontie'],
  ['Minor Surgery Clinic', 'عيادة الجراحة الصغرى', 'Clinique de chirurgie mineure'],
  ['Vaccination Center', 'مركز التلقيح', 'Centre de vaccination'],
  ['Maternity & Childbirth', 'الولادة والأمومة', 'Maternité'],
  ['Rehabilitation Center', 'مركز التأهيل', 'Centre de rééducation'],
  ['Diabetes & Nutrition Center', 'مركز السكري والتغذية', 'Centre du diabète & de la nutrition'],
  ['Sleep Clinic', 'عيادة اضطرابات النوم', 'Clinique du sommeil'],
  ['Urgent Care', 'الرعاية الطارئة', 'Soins d\u2019urgence'],
  ['Family Medicine Clinic', 'عيادة طب الأسرة', 'Clinique de médecine familiale'],
  ['Psychiatric Clinic', 'عيادة الطب النفسي', 'Clinique psychiatrique'],
  ['Addiction Treatment Center', 'مركز علاج الإدمان', 'Centre de traitement des addictions'],
  ['Speech Therapy', 'عيادة تخاطب', 'Orthophonie'],
]

const LAW_FIRM_SPECIALTIES = [
  ['Family Law', 'قانون الأسرة', 'Droit de la famille'],
  ['Personal Status Law', 'قانون الأحوال الشخصية', 'Droit du statut personnel'],
  ['Criminal Law', 'القانون الجنائي', 'Droit pénal'],
  ['Civil Law', 'القانون المدني', 'Droit civil'],
  ['Commercial & Business Law', 'القانون التجاري', 'Droit commercial & des affaires'],
  ['Labor & Social Security Law', 'قانون العمل والضمان الاجتماعي', 'Droit du travail & Sécurité sociale'],
  ['Real Estate Law', 'قانون العقارات', 'Droit immobilier'],
  ['Administrative Law', 'القانون الإداري', 'Droit administratif'],
  ['Tax Law', 'القانون الجبائي', 'Droit fiscal'],
  ['Corporate Law', 'قانون الشركات', 'Droit des sociétés'],
  ['Insurance Law', 'قانون التأمين', 'Droit des assurances'],
  ['Customs Law', 'قانون الجمارك', 'Droit douanier'],
  ['Maritime Law', 'القانون البحري', 'Droit maritime'],
  ['Banking & Finance Law', 'قانون البنوك والتمويل', 'Droit bancaire & financier'],
  ['Intellectual Property', 'الملكية الفكرية', 'Propriété intellectuelle'],
  ['International Law', 'القانون الدولي', 'Droit international'],
  ['Arbitration & Mediation', 'التحكيم والوساطة', 'Arbitrage & Médiation'],
  ['Debt Recovery', 'تحصيل الديون', 'Recouvrement de créances'],
  ['Legal Consultation', 'الاستشارة القانونية', 'Consultation juridique'],
  ['Contract Drafting', 'صياغة العقود', 'Rédaction de contrats'],
  ['Commercial Registry & Company Formation', 'السجل التجاري وتأسيس الشركات', 'Registre du commerce & création de sociétés'],
  ['Human Rights Law', 'قانون حقوق الإنسان', 'Droit des droits de l\u2019homme'],
  ['Immigration & Nationality Law', 'قانون الهجرة والجنسية', 'Droit de l\u2019immigration & de la nationalité'],
  ['Notarial Services', 'الخدمات التوثيقية', 'Services notariaux'],
  ['Environmental Law', 'قانون البيئة', 'Droit de l\u2019environnement'],
  ['Media & Press Law', 'قانون الإعلام والصحافة', 'Droit des médias & de la presse'],
  ['Construction Law', 'قانون البناء', 'Droit de la construction'],
]

const BARBER_SPECIALTIES = [
  ['Men\u2019s Haircut', 'قص الشعر للرجال', 'Coupe homme'],
  ['Kids Haircut', 'قص شعر الأطفال', 'Coupe enfant'],
  ['Beard Trim & Shaping', 'تشذيب وتشكيل اللحية', 'Taille de barbe'],
  ['Traditional Shave', 'الحلاقة التقليدية', 'Rasage traditionnel'],
  ['Hot Towel Shave', 'حلاقة بالمنشفة الساخنة', 'Rasage à la serviette chaude'],
  ['Hair Coloring', 'صبغة الشعر', 'Coloration cheveux'],
  ['Beard Coloring', 'صبغة اللحية', 'Coloration de barbe'],
  ['Hair Protein & Keratin Treatment', 'بروتين وكيراتين الشعر', 'Traitement protéine & kératine'],
  ['Haircare & Scalp Treatment', 'العناية بالشعر وفروة الرأس', 'Soins cheveux & cuir chevelu'],
  ['Facial Grooming & Masks', 'العناية بالوجه والأقنعة', 'Soin du visage & masques'],
  ['Black Mask', 'القناع الأسود', 'Masque noir'],
  ['Head & Face Massage', 'مساج الرأس والوجه', 'Massage tête & visage'],
  ['Waxing & Hair Removal', 'إزالة الشعر بالشمع', 'Épilation à la cire'],
  ['Fade Haircut', 'قص متدرج (فايد)', 'Coupe fade'],
  ['Wedding Groom Package', 'حزمة العريس', 'Forfait du marié'],
  ['Braids', 'الضفائر', 'Tresses'],
  ['Shaving Design & Hair Art', 'نقش الشعر', 'Design & motifs'],
  ['Steam Treatment', 'العلاج بالبخار', 'Traitement à la vapeur'],
  ['Blow-dry & Styling', 'تصفيف وتسريح', 'Coiffage & brushing'],
]

const SPECIALTY_CATALOG = {
  DOCTOR: DOCTOR_SPECIALTIES,
  CLINIC: CLINIC_SPECIALTIES,
  LAW_FIRM: LAW_FIRM_SPECIALTIES,
  BARBER: BARBER_SPECIALTIES,
}

// ─── Default terminology overrides (key = i18n dictionary key) ──────────────
// Doctor/Clinic callers are PATIENTS; law-office callers are CLIENTS
// (موكل); barber callers are CUSTOMERS (زبناء). These five keys cover the
// customer/agency surfaces that display the word; admins can add more keys
// from the "Agency Categories Language" page.

const TERMS = {
  DOCTOR: [
    ['customer', 'مريض', 'Patient', 'Patient'],
    ['totalCustomers', 'إجمالي المرضى', 'Total Patients', 'Total des patients'],
    ['customersServed', 'المرضى الذين تمت خدمتهم', 'Patients Served', 'Patients servis'],
    ['waitingCustomers', 'المرضى المنتظرون', 'Waiting Patients', 'Patients en attente'],
    ['customerReviews', 'تقييمات المرضى', 'Patient Reviews', 'Avis des patients'],
    ['customersPerHour', 'مريض/ساعة', 'patients/hr', 'patients/heure'],
  ],
  CLINIC: [
    ['customer', 'مريض', 'Patient', 'Patient'],
    ['totalCustomers', 'إجمالي المرضى', 'Total Patients', 'Total des patients'],
    ['customersServed', 'المرضى الذين تمت خدمتهم', 'Patients Served', 'Patients servis'],
    ['waitingCustomers', 'المرضى المنتظرون', 'Waiting Patients', 'Patients en attente'],
    ['customerReviews', 'تقييمات المرضى', 'Patient Reviews', 'Avis des patients'],
    ['customersPerHour', 'مريض/ساعة', 'patients/hr', 'patients/heure'],
  ],
  LAW_FIRM: [
    ['customer', 'موكّل', 'Client', 'Client'],
    ['totalCustomers', 'إجمالي الموكلين', 'Total Clients', 'Total des clients'],
    ['customersServed', 'الموكلون الذين تمت خدمتهم', 'Clients Served', 'Clients servis'],
    ['waitingCustomers', 'الموكلون المنتظرون', 'Waiting Clients', 'Clients en attente'],
    ['customerReviews', 'تقييمات الموكلين', 'Client Reviews', 'Avis des clients'],
    ['customersPerHour', 'موكّل/ساعة', 'clients/hr', 'clients/heure'],
  ],
  BARBER: [
    ['customer', 'زبون', 'Customer', 'Client'],
    ['totalCustomers', 'إجمالي الزبناء', 'Total Customers', 'Total des clients'],
    ['customersServed', 'الزبناء الذين تمت خدمتهم', 'Customers Served', 'Clients servis'],
    ['waitingCustomers', 'الزبناء المنتظرون', 'Waiting Customers', 'Clients en attente'],
    ['customerReviews', 'تقييمات الزبناء', 'Customer Reviews', 'Avis des clients'],
    ['customersPerHour', 'زبون/ساعة', 'customers/hr', 'clients/heure'],
  ],
}

async function upsertBuiltIns() {
  for (const c of BUILT_INS) {
    const existing = await db.agencyCategory.findFirst({
      where: { OR: [{ slug: c.slug }, { name: c.name }] },
    })
    if (existing) {
      await db.agencyCategory.update({
        where: { id: existing.id },
        data: {
          slug: c.slug,
          name: c.name,
          nameAr: c.nameAr,
          nameFr: c.nameFr,
          icon: c.icon,
          isCustom: false,
          isActive: true,
          sortOrder: c.sortOrder,
        },
      })
    } else {
      await db.agencyCategory.create({ data: { ...c, isCustom: false, isActive: true } })
    }
  }
}

async function backfillLegacyCategories() {
  const rows = await db.agency.groupBy({ by: ['category'] })
  let created = 0
  for (const r of rows) {
    const value = (r.category || '').trim()
    if (!value) continue
    const isBuiltIn = BUILT_INS.some((b) => b.slug === value)
    if (isBuiltIn) continue
    const existing = await db.agencyCategory.findFirst({
      where: { OR: [{ slug: value }, { name: value }] },
    })
    if (existing) continue
    await db.agencyCategory.create({
      data: { slug: value, name: value, isCustom: true, isActive: true, sortOrder: 100 },
    })
    created++
  }
  return created
}

async function seedSpecialties() {
  const cats = await db.agencyCategory.findMany({ where: { slug: { in: Object.keys(SPECIALTY_CATALOG) } } })
  let count = 0
  for (const cat of cats) {
    const list = SPECIALTY_CATALOG[cat.slug] || []
    for (let i = 0; i < list.length; i++) {
      const [nameEn, nameAr, nameFr] = list[i]
      const existing = await db.specialty.findFirst({
        where: { categoryId: cat.id, nameEn },
      })
      if (existing) {
        if (existing.nameAr !== nameAr || existing.nameFr !== nameFr) {
          await db.specialty.update({
            where: { id: existing.id },
            data: { nameAr, nameFr, sortOrder: i + 1 },
          })
        }
        continue
      }
      await db.specialty.create({
        data: { categoryId: cat.id, nameEn, nameAr, nameFr, sortOrder: i + 1, isActive: true },
      })
      count++
    }
  }
  return count
}

async function seedTerms() {
  const cats = await db.agencyCategory.findMany({ where: { slug: { in: Object.keys(TERMS) } } })
  let count = 0
  for (const cat of cats) {
    for (const [key, valueAr, valueEn, valueFr] of TERMS[cat.slug]) {
      const existing = await db.categoryTerm.findFirst({
        where: { categoryId: cat.id, key },
      })
      if (existing) continue
      await db.categoryTerm.create({
        data: { categoryId: cat.id, key, valueAr, valueEn, valueFr },
      })
      count++
    }
  }
  return count
}

async function main() {
  console.log('[seed-agency-categories] upserting built-ins...')
  await upsertBuiltIns()
  console.log('[seed-agency-categories] backfilling legacy categories...')
  const legacy = await backfillLegacyCategories()
  console.log(`[seed-agency-categories] legacy backfill: ${legacy} rows created`)
  console.log('[seed-agency-categories] seeding specialties...')
  const specs = await seedSpecialties()
  console.log(`[seed-agency-categories] specialties created: ${specs}`)
  console.log('[seed-agency-categories] seeding terminology...')
  const terms = await seedTerms()
  console.log(`[seed-agency-categories] terms created: ${terms}`)
  const total = await db.agencyCategory.count()
  const totalSpecs = await db.specialty.count()
  const totalTerms = await db.categoryTerm.count()
  console.log(`[seed-agency-categories] DONE — categories=${total} specialties=${totalSpecs} terms=${totalTerms}`)
}

main()
  .catch((e) => {
    console.error('[seed-agency-categories] FAILED:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
