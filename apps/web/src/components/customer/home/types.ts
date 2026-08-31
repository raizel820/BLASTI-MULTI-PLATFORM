import type { TranslationKeys } from '@/i18n';
import {
  Navigation,
  Stethoscope,
  Globe,
  Scale,
  FlaskConical,
  Landmark,
  Building2,
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

export const categoryKeys: CategoryKey[] = [
  { key: 'catAll', value: 'ALL', icon: Navigation },
  { key: 'catClinic', value: 'CLINIC', icon: Stethoscope },
  { key: 'catAgency', value: 'AGENCY', icon: Globe },
  { key: 'catLawFirm', value: 'LAW_FIRM', icon: Scale },
  { key: 'catLaboratory', value: 'LABORATORY', icon: FlaskConical },
  { key: 'catGovernment', value: 'GOVERNMENT', icon: Landmark },
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
