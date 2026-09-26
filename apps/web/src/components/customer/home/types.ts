import type { TranslationKeys } from '@/i18n';
import {
  Navigation,
  Stethoscope,
  Globe,
  Scale,
  FlaskConical,
  Landmark,
  Building2,
  Cross,
  Smile,
  Pill,
  PawPrint,
  Banknote,
  Mail,
  Smartphone,
  Shield,
  FileText,
  GraduationCap,
  Plane,
  Home,
  Car,
  Scissors,
  Sparkles,
  Utensils,
  Coffee,
  ShoppingBag,
  Hotel,
} from 'lucide-react';

export interface AgencyListItem {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  isSponsored: boolean;
  customCode: string;
  isQueueOpen: boolean;
  isPaused: boolean;
  serviceCount: number;
  waitingCount: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  avgServiceTime?: number;
  averageRating?: number;
  reviewCount?: number;
  subscriptionStatus?: string;
}

export interface AgencyDetail {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  address: string;
  isSponsored: boolean;
  customCode: string;
  isQueueOpen: boolean;
  isPaused: boolean;
  currentServingNumber: number;
  lastIssuedNumber: number;
  workingHoursStart?: string;
  workingHoursEnd?: string;
  avgServiceTime?: number;
  services: { id: string; name: string; nameAr?: string; nameFr?: string; waitingCount: number }[];
  averageRating?: number;
  reviewCount?: number;
  subscriptionStatus?: string;
}

export interface ActiveReservation {
  agencyName: string;
  position: number;
  agencyId: string;
}

export interface CategoryKey {
  key: TranslationKeys;
  value: string;
  icon: React.ElementType;
}

/**
 * Cast an i18n key that is not in the generated TranslationKeys union yet
 * (the catXxx additions land with the Task 42 i18n pass). Keeps the literal
 * at the call site for greppability.
 */
const k = (key: string) => key as TranslationKeys;

/**
 * Task 42 — the 25 built-in category filter chips (ALL first). Custom
 * (user-created) categories are appended dynamically in CategoryFilters.tsx
 * via useAgencyCategories(); they use the Tag icon and are matched/displayed
 * by their user-entered name (uppercased for the case-insensitive filter).
 */
export const categoryKeys: CategoryKey[] = [
  { key: 'catAll', value: 'ALL', icon: Navigation },
  { key: 'catClinic', value: 'CLINIC', icon: Stethoscope },
  { key: k('catHospital'), value: 'HOSPITAL', icon: Cross },
  { key: k('catDentalClinic'), value: 'DENTAL_CLINIC', icon: Smile },
  { key: 'catLaboratory', value: 'LABORATORY', icon: FlaskConical },
  { key: k('catPharmacy'), value: 'PHARMACY', icon: Pill },
  { key: k('catVeterinary'), value: 'VETERINARY', icon: PawPrint },
  { key: k('catBank'), value: 'BANK', icon: Banknote },
  { key: k('catPostOffice'), value: 'POST_OFFICE', icon: Mail },
  { key: k('catTelecom'), value: 'TELECOM', icon: Smartphone },
  { key: k('catInsurance'), value: 'INSURANCE', icon: Shield },
  { key: 'catLawFirm', value: 'LAW_FIRM', icon: Scale },
  { key: k('catNotary'), value: 'NOTARY', icon: FileText },
  { key: 'catGovernment', value: 'GOVERNMENT', icon: Landmark },
  { key: k('catEducation'), value: 'EDUCATION', icon: GraduationCap },
  { key: 'catAgency', value: 'AGENCY', icon: Globe },
  { key: k('catTravel'), value: 'TRAVEL', icon: Plane },
  { key: k('catRealEstate'), value: 'REAL_ESTATE', icon: Home },
  { key: k('catCarService'), value: 'CAR_SERVICE', icon: Car },
  { key: k('catBarber'), value: 'BARBER', icon: Scissors },
  { key: k('catBeautySalon'), value: 'BEAUTY_SALON', icon: Sparkles },
  { key: k('catRestaurant'), value: 'RESTAURANT', icon: Utensils },
  { key: k('catCafe'), value: 'CAFE', icon: Coffee },
  { key: k('catRetail'), value: 'RETAIL', icon: ShoppingBag },
  { key: k('catHotel'), value: 'HOTEL', icon: Hotel },
  { key: 'catOther', value: 'OTHER', icon: Building2 },
];

export function getAgencyName(a: AgencyListItem | AgencyDetail, lang: string): string {
  if (lang === 'ar' && a.nameAr) return a.nameAr;
  if (lang === 'fr' && a.nameFr) return a.nameFr;
  return a.name;
}

export function getCategoryLabel(cat: string, t: (key: TranslationKeys) => string): string {
  const found = categoryKeys.find((c) => c.value === cat.toUpperCase());
  return found ? t(found.key) : cat;
}

export function isOpenNow(start: string, end: string): boolean | null {
  if (!start || !end) return null;
  const now = new Date();
  const [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  const cur = now.getHours() * 60 + now.getMinutes();
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  // Handle overnight hours (e.g. 22:00 - 06:00)
  if (startMin > endMin) {
    return cur >= startMin || cur < endMin;
  }
  return cur >= startMin && cur < endMin;
}
