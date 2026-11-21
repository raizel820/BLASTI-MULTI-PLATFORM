/**
 * Self-healing bootstrap for the AgencyCategory dictionary.
 *
 * WHY THIS EXISTS: the Agencies Management epic ships the 4 built-in
 * categories (DOCTOR | CLINIC | LAW_FIRM | BARBER) + Algeria-market
 * specialties + terminology defaults as a MANUAL seed script
 * (packages/db/scripts/seed-agency-categories.mjs). Manual seeds don't run
 * on existing deployments — on the VPS the AgencyCategory/CategoryTerm
 * tables were empty, so the admin "Agency Categories Manager" and
 * "Agency Categories Language" pages rendered EMPTY while the Services
 * Manager still worked (it falls back to the hardcoded
 * BUILT_IN_AGENCY_CATEGORY_KEYS). This module makes every API boot
 * self-healing so no environment can regress again.
 *
 * DESIGN — deliberately GENTLE (unlike the manual seed, which force-upserts):
 *   1. Built-in categories: CREATE-if-missing only (matched by slug OR name).
 *      Existing rows are NEVER modified → admin renames/edits survive every
 *      restart. Re-creating a deleted built-in is CORRECT: the 4 keys are
 *      canonical product types enforced by zod enums across the API.
 *   2. Legacy backfill: any Agency.category value with no dictionary row
 *      becomes a visible custom category (same as the manual seed).
 *   3. Specialties: per built-in category, the full catalog is seeded ONLY
 *      when that category has ZERO specialties (fresh environment). After
 *      the first seed, admin deletions are respected on every restart.
 *   4. Terms: per built-in category, defaults seeded ONLY when that category
 *      has ZERO terms (same zero-gate rationale).
 *
 * The result is memoized per process: after the first success every later
 * call awaits an already-resolved promise (nanoseconds). A failure resets
 * the memo so the next call (first admin GET after a DB hiccup) retries.
 *
 * Data mirrors seed-agency-categories.mjs (keep both in lockstep).
 */

import { db } from '@blasti/db'

// ─── Built-in category definitions (slug = the exact Agency.category value) ──

const BUILT_INS = [
  { slug: 'DOCTOR', name: 'Doctor', nameAr: 'طبيب', nameFr: 'Médecin', icon: '🩺', sortOrder: 1 },
  { slug: 'CLINIC', name: 'Clinic', nameAr: 'عيادة', nameFr: 'Clinique', icon: '🏥', sortOrder: 2 },
  { slug: 'LAW_FIRM', name: 'Law Office', nameAr: 'مكتب محاماة', nameFr: 'Cabinet d\u2019avocat', icon: '⚖️', sortOrder: 3 },
  { slug: 'BARBER', name: 'Barber', nameAr: 'حلاق', nameFr: 'Barbier', icon: '💈', sortOrder: 4 },
] as const

// ─── Algeria-market specialty catalog (nameEn / nameAr / nameFr) ────────────

const DOCTOR_SPECIALTIES: Array<[string, string, string]> = [
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

const CLINIC_SPECIALTIES: Array<[string, string, string]> = [
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

const LAW_FIRM_SPECIALTIES: Array<[string, string, string]> = [
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

const BARBER_SPECIALTIES: Array<[string, string, string]> = [
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

const SPECIALTY_CATALOG: Record<string, Array<[string, string, string]>> = {
  DOCTOR: DOCTOR_SPECIALTIES,
  CLINIC: CLINIC_SPECIALTIES,
  LAW_FIRM: LAW_FIRM_SPECIALTIES,
  BARBER: BARBER_SPECIALTIES,
}

// ─── Default terminology overrides (key = i18n dictionary key) ──────────────
// Doctor/Clinic callers are PATIENTS; law-office callers are CLIENTS
// (موكل); barber callers are CUSTOMERS (زبناء).
//
// 0.6.76 — terminology AUDIT expansion: beyond the six stat labels, three
// queue-sentence keys also carry customer-flavored wording and MUST follow
// the category vocabulary ("No patients in queue" vs "No customers in
// queue"): `noQueue`, `noCustomersWaiting`, `customerJoinedQueue`. The
// translation agent generates exactly this key set for NEW custom
// categories (CATEGORY_TERM_KEYS below); built-ins are seeded with it.
//
// 0.6.98 — FULL terminology audit (29 keys): every i18n key whose wording
// depends on the agency category is replaceable per category from the
// translation agent. New groups: the SERVICE wording (a law office's
// "Service" is a "Legal Service", a doctor's is a "Consultation"), the
// queue/counter/ticket labels, and the customer-flavored sentences (walk-in
// flow, call/complete events, satisfaction/growth stats).

export const CATEGORY_TERM_KEYS = [
  // ── served person + stat labels (0.6.76) ──
  'customer',
  'totalCustomers',
  'customersServed',
  'waitingCustomers',
  'customerReviews',
  'customersPerHour',
  'noQueue',
  'noCustomersWaiting',
  'customerJoinedQueue',
  // ── 0.6.98 audit — service wording (domain-specific offering name) ──
  'service',
  'services',
  'addService',
  'serviceName',
  // ── 0.6.98 audit — ticket / counter / queue labels ──
  'ticket',
  'currentTicket',
  'counter',
  'counterLabel',
  'queueNumber',
  'queueManagement',
  'joinQueue',
  // ── 0.6.98 audit — customer-flavored sentences + walk-in flow ──
  'noQueueHint',
  'customerWasCalled',
  'customerCompletedService',
  'customerSatisfaction',
  'customerGrowth',
  'customerInfo',
  'walkInCustomerName',
  'addWalkInCustomer',
  'walkInCustomerAdded',
] as const

const TERMS: Record<string, Array<[string, string, string, string]>> = {
  DOCTOR: [
    ['customer', 'مريض', 'Patient', 'Patient'],
    ['totalCustomers', 'إجمالي المرضى', 'Total Patients', 'Total des patients'],
    ['customersServed', 'المرضى الذين تمت خدمتهم', 'Patients Served', 'Patients servis'],
    ['waitingCustomers', 'المرضى المنتظرون', 'Waiting Patients', 'Patients en attente'],
    ['customerReviews', 'تقييمات المرضى', 'Patient Reviews', 'Avis des patients'],
    ['customersPerHour', 'مريض/ساعة', 'patients/hr', 'patients/heure'],
    ['noQueue', 'لا يوجد مرضى في الانتظار', 'No patients in queue', 'Aucun patient en attente'],
    ['noCustomersWaiting', 'لا يوجد مرضى منتظرون', 'No patients waiting', 'Aucun patient en attente'],
    ['customerJoinedQueue', '{name} انضم إلى قائمة الانتظار', '{name} joined the queue', '{name} a rejoint la file d\'attente'],
    // ── 0.6.98 audit — a medical "service" is a consultation ──
    ['service', 'استشارة', 'Consultation', 'Consultation'],
    ['services', 'الاستشارات', 'Consultations', 'Consultations'],
    ['addService', 'إضافة استشارة', 'Add Consultation', 'Ajouter une consultation'],
    ['serviceName', 'اسم الاستشارة', 'Consultation Name', 'Nom de la consultation'],
    ['ticket', 'تذكرة', 'Ticket', 'Ticket'],
    ['currentTicket', 'التذكرة الحالية', 'Current Ticket', 'Ticket actuel'],
    ['counter', 'الشباك', 'Desk', 'Guichet'],
    ['counterLabel', 'الشباك', 'Desk', 'Guichet'],
    ['queueNumber', 'رقم الانتظار', 'Queue Number', 'Numéro de file'],
    ['queueManagement', 'إدارة قائمة الانتظار', 'Queue Management', 'Gestion de la file'],
    ['joinQueue', 'انضم إلى قائمة الانتظار', 'Join Queue', 'Rejoindre la file'],
    ['noQueueHint', 'تمت خدمة جميع المرضى. عمل رائع!', 'All patients have been served. Great job!', 'Tous les patients ont été servis. Bon travail !'],
    ['customerWasCalled', 'تم استدعاء {name}', '{name} was called', '{name} a été appelé'],
    ['customerCompletedService', '{name} أنهى الاستشارة', '{name} completed the consultation', '{name} a terminé la consultation'],
    ['customerSatisfaction', 'رضا المرضى', 'Patient Satisfaction', 'Satisfaction des patients'],
    ['customerGrowth', 'نمو المرضى', 'Patient Growth', 'Croissance des patients'],
    ['customerInfo', 'معلومات المريض', 'Patient Info', 'Infos patient'],
    ['walkInCustomerName', 'اسم المريض', 'Patient Name', 'Nom du patient'],
    ['addWalkInCustomer', 'إضافة مريض حاضر', 'Add Walk-in Patient', 'Ajouter un patient présent'],
    ['walkInCustomerAdded', 'تمت إضافة المريض الحاضر إلى قائمة الانتظار', 'Walk-in patient added to the queue', 'Patient présent ajouté à la file'],
  ],
  CLINIC: [
    ['customer', 'مريض', 'Patient', 'Patient'],
    ['totalCustomers', 'إجمالي المرضى', 'Total Patients', 'Total des patients'],
    ['customersServed', 'المرضى الذين تمت خدمتهم', 'Patients Served', 'Patients servis'],
    ['waitingCustomers', 'المرضى المنتظرون', 'Waiting Patients', 'Patients en attente'],
    ['customerReviews', 'تقييمات المرضى', 'Patient Reviews', 'Avis des patients'],
    ['customersPerHour', 'مريض/ساعة', 'patients/hr', 'patients/heure'],
    ['noQueue', 'لا يوجد مرضى في الانتظار', 'No patients in queue', 'Aucun patient en attente'],
    ['noCustomersWaiting', 'لا يوجد مرضى منتظرون', 'No patients waiting', 'Aucun patient en attente'],
    ['customerJoinedQueue', '{name} انضم إلى قائمة الانتظار', '{name} joined the queue', '{name} a rejoint la file d\'attente'],
    // ── 0.6.98 audit — a medical "service" is a consultation ──
    ['service', 'استشارة', 'Consultation', 'Consultation'],
    ['services', 'الاستشارات', 'Consultations', 'Consultations'],
    ['addService', 'إضافة استشارة', 'Add Consultation', 'Ajouter une consultation'],
    ['serviceName', 'اسم الاستشارة', 'Consultation Name', 'Nom de la consultation'],
    ['ticket', 'تذكرة', 'Ticket', 'Ticket'],
    ['currentTicket', 'التذكرة الحالية', 'Current Ticket', 'Ticket actuel'],
    ['counter', 'الشباك', 'Desk', 'Guichet'],
    ['counterLabel', 'الشباك', 'Desk', 'Guichet'],
    ['queueNumber', 'رقم الانتظار', 'Queue Number', 'Numéro de file'],
    ['queueManagement', 'إدارة قائمة الانتظار', 'Queue Management', 'Gestion de la file'],
    ['joinQueue', 'انضم إلى قائمة الانتظار', 'Join Queue', 'Rejoindre la file'],
    ['noQueueHint', 'تمت خدمة جميع المرضى. عمل رائع!', 'All patients have been served. Great job!', 'Tous les patients ont été servis. Bon travail !'],
    ['customerWasCalled', 'تم استدعاء {name}', '{name} was called', '{name} a été appelé'],
    ['customerCompletedService', '{name} أنهى الاستشارة', '{name} completed the consultation', '{name} a terminé la consultation'],
    ['customerSatisfaction', 'رضا المرضى', 'Patient Satisfaction', 'Satisfaction des patients'],
    ['customerGrowth', 'نمو المرضى', 'Patient Growth', 'Croissance des patients'],
    ['customerInfo', 'معلومات المريض', 'Patient Info', 'Infos patient'],
    ['walkInCustomerName', 'اسم المريض', 'Patient Name', 'Nom du patient'],
    ['addWalkInCustomer', 'إضافة مريض حاضر', 'Add Walk-in Patient', 'Ajouter un patient présent'],
    ['walkInCustomerAdded', 'تمت إضافة المريض الحاضر إلى قائمة الانتظار', 'Walk-in patient added to the queue', 'Patient présent ajouté à la file'],
  ],
  LAW_FIRM: [
    ['customer', 'موكّل', 'Client', 'Client'],
    ['totalCustomers', 'إجمالي الموكلين', 'Total Clients', 'Total des clients'],
    ['customersServed', 'الموكلون الذين تمت خدمتهم', 'Clients Served', 'Clients servis'],
    ['waitingCustomers', 'الموكلون المنتظرون', 'Waiting Clients', 'Clients en attente'],
    ['customerReviews', 'تقييمات الموكلين', 'Client Reviews', 'Avis des clients'],
    ['customersPerHour', 'موكّل/ساعة', 'clients/hr', 'clients/heure'],
    ['noQueue', 'لا يوجد موكلين في الانتظار', 'No clients in queue', 'Aucun client en attente'],
    ['noCustomersWaiting', 'لا يوجد موكلين منتظرون', 'No clients waiting', 'Aucun client en attente'],
    ['customerJoinedQueue', '{name} انضم إلى قائمة الانتظار', '{name} joined the queue', '{name} a rejoint la file d\'attente'],
    // ── 0.6.98 audit — a law office's "service" is a legal service ──
    ['service', 'خدمة قانونية', 'Legal Service', 'Service juridique'],
    ['services', 'الخدمات القانونية', 'Legal Services', 'Services juridiques'],
    ['addService', 'إضافة خدمة قانونية', 'Add Legal Service', 'Ajouter un service juridique'],
    ['serviceName', 'اسم الخدمة', 'Service Name', 'Nom du service'],
    ['ticket', 'تذكرة', 'Ticket', 'Ticket'],
    ['currentTicket', 'التذكرة الحالية', 'Current Ticket', 'Ticket actuel'],
    ['counter', 'المكتب', 'Desk', 'Bureau'],
    ['counterLabel', 'المكتب', 'Desk', 'Bureau'],
    ['queueNumber', 'رقم الانتظار', 'Queue Number', 'Numéro de file'],
    ['queueManagement', 'إدارة قائمة الانتظار', 'Queue Management', 'Gestion de la file'],
    ['joinQueue', 'انضم إلى قائمة الانتظار', 'Join Queue', 'Rejoindre la file'],
    ['noQueueHint', 'تمت خدمة جميع الموكلين. عمل رائع!', 'All clients have been served. Great job!', 'Tous les clients ont été servis. Bon travail !'],
    ['customerWasCalled', 'تم استدعاء {name}', '{name} was called', '{name} a été appelé'],
    ['customerCompletedService', '{name} أنهى الخدمة', '{name} completed the service', '{name} a terminé le service'],
    ['customerSatisfaction', 'رضا الموكلين', 'Client Satisfaction', 'Satisfaction des clients'],
    ['customerGrowth', 'نمو الموكلين', 'Client Growth', 'Croissance des clients'],
    ['customerInfo', 'معلومات الموكل', 'Client Info', 'Infos client'],
    ['walkInCustomerName', 'اسم الموكل', 'Client Name', 'Nom du client'],
    ['addWalkInCustomer', 'إضافة موكّل حاضر', 'Add Walk-in Client', 'Ajouter un client présent'],
    ['walkInCustomerAdded', 'تمت إضافة الموكل الحاضر إلى قائمة الانتظار', 'Walk-in client added to the queue', 'Client présent ajouté à la file'],
  ],
  BARBER: [
    ['customer', 'زبون', 'Customer', 'Client'],
    ['totalCustomers', 'إجمالي الزبناء', 'Total Customers', 'Total des clients'],
    ['customersServed', 'الزبناء الذين تمت خدمتهم', 'Customers Served', 'Clients servis'],
    ['waitingCustomers', 'الزبناء المنتظرون', 'Waiting Customers', 'Clients en attente'],
    ['customerReviews', 'تقييمات الزبناء', 'Customer Reviews', 'Avis des clients'],
    ['customersPerHour', 'زبون/ساعة', 'customers/hr', 'clients/heure'],
    ['noQueue', 'لا يوجد زبناء في الانتظار', 'No customers in queue', 'Aucun client en attente'],
    ['noCustomersWaiting', 'لا يوجد زبناء منتظرون', 'No customers waiting', 'Aucun client en attente'],
    ['customerJoinedQueue', '{name} انضم للطابور', '{name} joined the queue', '{name} a rejoint la file d\'attente'],
    // ── 0.6.98 audit — a barber's "service" is a hair service ──
    ['service', 'خدمة شعر', 'Hair Service', 'Service coiffure'],
    ['services', 'خدمات الشعر', 'Hair Services', 'Services coiffure'],
    ['addService', 'إضافة خدمة', 'Add Service', 'Ajouter un service'],
    ['serviceName', 'اسم الخدمة', 'Service Name', 'Nom du service'],
    ['ticket', 'تذكرة', 'Ticket', 'Ticket'],
    ['currentTicket', 'التذكرة الحالية', 'Current Ticket', 'Ticket actuel'],
    ['counter', 'الكرسي', 'Chair', 'Fauteuil'],
    ['counterLabel', 'الكرسي', 'Chair', 'Fauteuil'],
    ['queueNumber', 'رقم الطابور', 'Queue Number', 'Numéro de file'],
    ['queueManagement', 'إدارة الطابور', 'Queue Management', 'Gestion de la file'],
    ['joinQueue', 'انضم للطابور', 'Join Queue', 'Rejoindre la file'],
    ['noQueueHint', 'تمت خدمة جميع الزبناء. عمل رائع!', 'All customers have been served. Great job!', 'Tous les clients ont été servis. Bon travail !'],
    ['customerWasCalled', 'تم استدعاء {name}', '{name} was called', '{name} a été appelé'],
    ['customerCompletedService', '{name} أنهى الخدمة', '{name} completed the service', '{name} a terminé le service'],
    ['customerSatisfaction', 'رضا الزبناء', 'Customer Satisfaction', 'Satisfaction des clients'],
    ['customerGrowth', 'نمو الزبناء', 'Customer Growth', 'Croissance des clients'],
    ['customerInfo', 'معلومات الزبون', 'Customer Info', 'Infos client'],
    ['walkInCustomerName', 'اسم الزبون', 'Customer Name', 'Nom du client'],
    ['addWalkInCustomer', 'إضافة زبون حاضر', 'Add Walk-in Customer', 'Ajouter un client présent'],
    ['walkInCustomerAdded', 'تمت إضافة الزبون الحاضر إلى الطابور', 'Walk-in customer added to the queue', 'Client présent ajouté à la file'],
  ],
}

// ─── Ensure steps ────────────────────────────────────────────────────────────

async function ensureBuiltInCategories(): Promise<number> {
  let created = 0
  for (const c of BUILT_INS) {
    const existing = await db.agencyCategory.findFirst({
      where: { OR: [{ slug: c.slug }, { name: c.name }] },
      select: { id: true },
    })
    if (existing) continue
    await db.agencyCategory.create({
      data: { slug: c.slug, name: c.name, nameAr: c.nameAr, nameFr: c.nameFr, icon: c.icon, sortOrder: c.sortOrder, isCustom: false, isActive: true },
    })
    created++
  }
  return created
}

async function backfillLegacyCategories(): Promise<number> {
  const rows = await db.agency.groupBy({ by: ['category'] })
  let created = 0
  for (const r of rows) {
    const value = (r.category || '').trim()
    if (!value) continue
    if (BUILT_INS.some((b) => b.slug === value || b.name === value)) continue
    const existing = await db.agencyCategory.findFirst({
      where: { OR: [{ slug: value }, { name: value }] },
      select: { id: true },
    })
    if (existing) continue
    await db.agencyCategory.create({
      data: { slug: value, name: value, isCustom: true, isActive: true, sortOrder: 100 },
    })
    created++
  }
  return created
}

async function ensureSpecialties(): Promise<number> {
  let created = 0
  const cats = await db.agencyCategory.findMany({
    where: { slug: { in: Object.keys(SPECIALTY_CATALOG) } },
    select: { id: true, slug: true, _count: { select: { specialties: true } } },
  })
  for (const cat of cats) {
    // Zero-gate: only a FRESH environment gets the catalog seeded. Once any
    // specialty exists, admin deletions are respected on every restart.
    if (cat._count.specialties > 0) continue
    const list = SPECIALTY_CATALOG[cat.slug] || []
    if (list.length === 0) continue
    await db.specialty.createMany({
      data: list.map(([nameEn, nameAr, nameFr], i) => ({
        categoryId: cat.id, nameEn, nameAr, nameFr, sortOrder: i + 1, isActive: true,
      })),
    })
    created += list.length
  }
  return created
}

async function ensureTerms(): Promise<number> {
  let created = 0
  const cats = await db.agencyCategory.findMany({
    where: { slug: { in: Object.keys(TERMS) } },
    select: { id: true, slug: true, _count: { select: { terms: true } } },
  })
  for (const cat of cats) {
    // Zero-gate: only seed when the category has NO terms at all — a fresh
    // environment gets the defaults; admin deletions survive restarts.
    if (cat._count.terms > 0) continue
    for (const [key, valueAr, valueEn, valueFr] of TERMS[cat.slug] || []) {
      const existing = await db.categoryTerm.findFirst({
        where: { categoryId: cat.id, key },
        select: { id: true },
      })
      if (existing) continue
      await db.categoryTerm.create({
        data: { categoryId: cat.id, key, valueAr, valueEn, valueFr },
      })
      created++
    }
  }
  return created
}

/**
 * 0.6.98 — per-key (NOT zero-gated) top-up of the built-in categories'
 * terminology. The TERMS table now carries the AUDIT-EXPANDED key set
 * (service wording, walk-in sentences, counter/ticket labels...); existing
 * deployments seeded before 0.6.98 have only the original 9 keys per
 * category, so this creates exactly the MISSING keys and never touches
 * existing values. Runs once per terms-audit version (guarded by the
 * PlatformSetting marker in the scheduler boot), so an admin-deleted key is
 * not resurrected on every restart — only by the NEXT audit version.
 */
export async function createMissingBuiltInTermRows(): Promise<number> {
  let created = 0
  const cats = await db.agencyCategory.findMany({
    where: { slug: { in: Object.keys(TERMS) } },
    select: { id: true, slug: true },
  })
  for (const cat of cats) {
    for (const [key, valueAr, valueEn, valueFr] of TERMS[cat.slug] || []) {
      if (!CATEGORY_TERM_KEYS.includes(key as (typeof CATEGORY_TERM_KEYS)[number])) continue
      const existing = await db.categoryTerm.findFirst({
        where: { categoryId: cat.id, key },
        select: { id: true },
      })
      if (existing) continue
      await db.categoryTerm.create({
        data: { categoryId: cat.id, key, valueAr, valueEn, valueFr },
      })
      created++
    }
  }
  return created
}

export interface CategoryDictionaryEnsureResult {
  categoriesCreated: number
  legacyBackfilled: number
  specialtiesCreated: number
  termsCreated: number
}

async function runEnsure(): Promise<CategoryDictionaryEnsureResult> {
  const categoriesCreated = await ensureBuiltInCategories()
  const legacyBackfilled = await backfillLegacyCategories()
  const specialtiesCreated = await ensureSpecialties()
  const termsCreated = await ensureTerms()
  if (categoriesCreated || legacyBackfilled || specialtiesCreated || termsCreated) {
    console.log(
      `[CATEGORY-DICTIONARY-ENSURE] categories+${categoriesCreated} legacy+${legacyBackfilled} specialties+${specialtiesCreated} terms+${termsCreated}`,
    )
  }
  return { categoriesCreated, legacyBackfilled, specialtiesCreated, termsCreated }
}

let inflight: Promise<CategoryDictionaryEnsureResult> | null = null

/**
 * Idempotent, memoized, self-healing dictionary bootstrap. Safe to call on
 * every request — after the first success it is a no-op resolved promise.
 */
export function ensureCategoryDictionary(): Promise<CategoryDictionaryEnsureResult> {
  if (!inflight) {
    inflight = runEnsure().catch((e) => {
      inflight = null // allow the next call (e.g. the first admin GET) to retry
      throw e
    })
  }
  return inflight
}
