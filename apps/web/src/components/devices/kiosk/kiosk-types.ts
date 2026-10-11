import type { Language } from '@/i18n';

// ─── Shared Types ───────────────────────────────────────────────

export type KioskStep = 'method-select' | 'code' | 'credentials' | 'services' | 'name' | 'ticket' | 'qr-scan' | 'discovery' | 'pairing-approval';

export interface PairingRequest {
  id: string;
  agencyId: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  branchName?: string;
  sentAt: string;
}

export interface OfflineTicket {
  id: string;
  agencyId: string;
  serviceId: string;
  serviceName: string;
  servicePrefix: string;
  ticketNumber: string;
  customerName: string;
  issuedAt: string;
  synced: boolean;
}

export interface AgencyCache {
  agency: AgencyInfo;
  services: ServiceInfo[];
  lastIssuedNumbers: Record<string, number>;
  cachedAt: number;
}

export interface AgencyInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  category: string;
  customCode?: string;
  logoUrl?: string | null;
  workingHoursStart: string;
  workingHoursEnd: string;
  isQueueOpen: boolean;
  isPaused: boolean;
}

export interface ServiceInfo {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  prefix: string;
  avgTime: number;
}

export interface QueueStats {
  waiting: number;
  currentServing: string | null;
  estimatedWait: number;
  currentlyServingList?: { ticketNumber: string; counterName?: string }[];
}

export interface TicketInfo {
  id: string;
  ticketNumber: string;
  position: number;
  estimatedWaitMinutes: number;
  customerName: string;
  serviceName: string;
  serviceNameAr?: string | null;
  serviceNameFr?: string | null;
  agencyName: string;
  agencyNameAr?: string | null;
  agencyNameFr?: string | null;
  branchName?: string | null;
  branchNameAr?: string | null;
  branchNameFr?: string | null;
  method?: string | null;
  joinedAt: string;
  importToken: string;
}

// ─── Step configuration ─────────────────────────────────────────

export const STEP_ORDER: KioskStep[] = ['code', 'services', 'name', 'ticket'];

// ─── Constants ──────────────────────────────────────────────────

export const MAX_RETRIES = 3;
export const BACKOFF_DELAYS = [2000, 8000, 32000];

// ─── Device Fingerprint Generator ───────────────────────────────

export function generateFingerprint(): string {
  const nav = navigator as any;
  const parts = [
    nav.userAgent,
    nav.language,
    screen.width + 'x' + screen.height,
    nav.hardwareConcurrency || '',
    nav.platform || '',
  ];
  // Simple hash
  let hash = 0;
  const str = parts.join('|');
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash |= 0;
  }
  return Math.abs(hash).toString(16);
}

// ─── QR Generation Helper ───────────────────────────────────────

export async function generateQRDataURL(data: string, options: { width?: number } = {}) {
  try {
    const mod = await import('qrcode');
    const QRCode = mod.default || mod;
    if (!QRCode || typeof QRCode.toDataURL !== 'function') return null;
    return await QRCode.toDataURL(data, {
      width: options.width || 200,
      margin: 1,
      color: { dark: '#111827', light: '#ffffff' },
      errorCorrectionLevel: 'M',
    });
  } catch {
    return null;
  }
}

// ─── Localized Name Helper ──────────────────────────────────────

export function getLocalizedName(
  obj: { name: string; nameAr?: string | null; nameFr?: string | null },
  lang: Language,
): string {
  if (lang === 'ar' && obj.nameAr) return obj.nameAr;
  if (lang === 'fr' && obj.nameFr) return obj.nameFr;
  return obj.name;
}

// ─── Localized Ticket Name Helper ───────────────────────────────

export function getLocalizedTicketAgencyName(ticket: TicketInfo, lang: Language): string {
  if (ticket.agencyNameAr && lang === 'ar') return ticket.agencyNameAr;
  if (ticket.agencyNameFr && lang === 'fr') return ticket.agencyNameFr;
  return ticket.agencyName;
}

export function getLocalizedTicketServiceName(ticket: TicketInfo, lang: Language): string {
  if (ticket.serviceNameAr && lang === 'ar') return ticket.serviceNameAr;
  if (ticket.serviceNameFr && lang === 'fr') return ticket.serviceNameFr;
  return ticket.serviceName;
}

// ─── Offline Storage Utilities ──────────────────────────────────

const OFFLINE_TICKETS_KEY = 'blasti-kiosk-offline-tickets';
const AGENCY_CACHE_KEY = 'blasti-kiosk-agency-cache';
const AGENCY_CODE_KEY = 'blasti_kiosk_code';
const DEVICE_TOKEN_KEY = 'blasti_kiosk_device_token';
const DEVICE_ID_KEY = 'blasti_kiosk_device_id';

export function loadOfflineTickets(): OfflineTicket[] {
  try {
    const stored = localStorage.getItem(OFFLINE_TICKETS_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return [];
}

export function saveOfflineTickets(tickets: OfflineTicket[]): void {
  try {
    localStorage.setItem(OFFLINE_TICKETS_KEY, JSON.stringify(tickets));
  } catch { /* ignore */ }
}

export function loadAgencyCache(): AgencyCache | null {
  try {
    const stored = localStorage.getItem(AGENCY_CACHE_KEY);
    if (stored) return JSON.parse(stored);
  } catch { /* ignore */ }
  return null;
}

export function saveAgencyCache(cache: AgencyCache): void {
  try {
    localStorage.setItem(AGENCY_CACHE_KEY, JSON.stringify(cache));
    localStorage.setItem('blasti-kiosk-last-sync', Date.now().toString());
  } catch { /* ignore */ }
}

export function loadSavedAgencyCode(): string {
  try {
    return localStorage.getItem(AGENCY_CODE_KEY) || '';
  } catch { return ''; }
}

export function saveAgencyCode(code: string): void {
  try {
    localStorage.setItem(AGENCY_CODE_KEY, code);
  } catch { /* ignore */ }
}

export function removeAgencyCode(): void {
  try {
    localStorage.removeItem(AGENCY_CODE_KEY);
  } catch { /* ignore */ }
}

export function loadDeviceToken(): string {
  try {
    return localStorage.getItem(DEVICE_TOKEN_KEY) || '';
  } catch { return ''; }
}

export function saveDeviceToken(token: string): void {
  try {
    localStorage.setItem(DEVICE_TOKEN_KEY, token);
  } catch { /* ignore */ }
}

export function removeDeviceToken(): void {
  try {
    localStorage.removeItem(DEVICE_TOKEN_KEY);
    localStorage.removeItem(DEVICE_ID_KEY);
  } catch { /* ignore */ }
}

export function loadDeviceId(): string {
  try {
    return localStorage.getItem(DEVICE_ID_KEY) || '';
  } catch { return ''; }
}

export function saveDeviceId(id: string): void {
  try {
    localStorage.setItem(DEVICE_ID_KEY, id);
  } catch { /* ignore */ }
}

// ─── Page Animation Variants ────────────────────────────────────

export function getPageVariants(rtl: boolean) {
  return {
    enter: { opacity: 0, x: rtl ? -40 : 40 },
    center: { opacity: 1, x: 0 },
    exit: { opacity: 0, x: rtl ? 40 : -40 },
  };
}

// ─── Clock Formatting Helpers ───────────────────────────────────

export function formatClockTime(date: Date, lang: Language): string {
  return date.toLocaleTimeString(
    lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
    { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false },
  );
}

export function formatClockDate(date: Date, lang: Language): string {
  return date.toLocaleDateString(
    lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
    { weekday: 'short', month: 'short', day: 'numeric' },
  );
}