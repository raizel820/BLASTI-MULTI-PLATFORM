import type { TranslationKeys } from '@/i18n';
import {
  Navigation,
  Stethoscope,
  Hospital,
  Scale,
  Scissors,
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
  // Task 82 — canonical coordinates (already returned by GET /api/agencies);
  // used to compute the estimated distance when the customer's location
  // access is granted. Optional: older payloads omit them.
  latitude?: number | null;
  longitude?: number | null;
  // Task 5-b — Agencies Management: parsed specialty ids the agency serves
  // (GET /api/agencies now enriches them). Optional: cached/older payloads
  // and desktop local builds omit them → the specialty filter skips them.
  specialtyIds?: string[];
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
  // Task 51-b: canonical agency location (spec §2). Optional — older
  // payloads / desktop local builds omit them entirely.
  latitude?: number | null;
  longitude?: number | null;
  postalCode?: string | null;
  locationVerified?: string | null;
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
 * Task A (R-6) — reduced to the 4 product agency types (doctor, clinic,
 * law office, barber). Legacy custom (user-created) categories, if any rows
 * still exist, are appended dynamically in CategoryFilters.tsx via
 * useAgencyCategories(); they use the Tag icon and are matched/displayed
 * by their user-entered name (uppercased for the case-insensitive filter).
 */
export const categoryKeys: CategoryKey[] = [
  { key: 'catAll', value: 'ALL', icon: Navigation },
  { key: 'catDoctor', value: 'DOCTOR', icon: Stethoscope },
  { key: 'catClinic', value: 'CLINIC', icon: Hospital },
  { key: 'catLawFirm', value: 'LAW_FIRM', icon: Scale },
  { key: 'catBarber', value: 'BARBER', icon: Scissors },
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
