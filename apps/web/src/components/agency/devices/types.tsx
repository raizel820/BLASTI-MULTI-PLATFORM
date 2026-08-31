// ─── Types ──────────────────────────────────────────────────────────────────

export type DeviceType = 'TV' | 'KIOSK' | 'DISPLAY' | 'PRINTER' | 'APP' | 'PHONE' | 'ROUTER' | 'IOT';
export type ConnectionType = 'LAN' | 'WIFI' | 'CABLE' | 'MANUAL' | 'USB';
export type DeviceStatus = 'ONLINE' | 'OFFLINE' | 'PAIRING' | 'DISABLED' | 'UPDATING';
export type ScreenLayout = 'QUEUE_BOARD' | 'TICKET_PRINTER' | 'SERVICE_SELECTOR' | 'CUSTOM';
export type CommandType = 'REFRESH' | 'REBOOT' | 'CONFIG_UPDATE' | 'CLEAR_CACHE' | 'UPDATE_FIRMWARE';
export type CommandStatus = 'PENDING' | 'DELIVERED' | 'COMPLETED' | 'FAILED' | 'EXPIRED';

export interface AgencyDevice {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  type: DeviceType;
  status: DeviceStatus;
  connectionType: ConnectionType;
  ipAddress?: string | null;
  port?: number | null;
  pairingCode?: string | null;
  autoDiscovery: boolean;
  screenLayout: ScreenLayout;
  branchId?: string | null;
  displaySettings: string | Record<string, unknown>;
  printConfig?: string | Record<string, unknown> | null;
  serviceFilter?: string | null;
  appVersion?: string | null;
  deviceFingerprint?: string | null;
  connectedAt?: string | null;
  lastHeartbeatAt?: string | null;
  totalUptimeSec?: number | null;
  createdAt: string;
  updatedAt: string;
  branch?: {
    id: string;
    name: string;
    nameAr?: string | null;
    nameFr?: string | null;
  } | null;
  token?: string | null;
  commands?: DeviceCommand[];
}

export interface DiscoveredDevice {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  type: DeviceType;
  status: DeviceStatus;
  ipAddress?: string | null;
  port?: number | null;
  pairingCode?: string | null;
  appVersion?: string | null;
  connectionType: ConnectionType;
  lastHeartbeatAt?: string | null;
}

export interface Branch {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
}

export interface DisplaySettings {
  fontSize?: number;
  theme?: string;
  language?: string;
  showAds?: boolean;
  showLogo?: boolean;
  rotationSec?: number;
}

export interface DeviceCommand {
  id: string;
  deviceId: string;
  type: CommandType;
  status: CommandStatus;
  payload?: string | Record<string, unknown> | null;
  createdAt: string;
  deliveredAt?: string | null;
  completedAt?: string | null;
}

export interface NetworkScanResponse {
  success?: boolean;
  devices?: DiscoveredDevice[];
  devicesByType?: Record<string, DiscoveredDevice[]>;
  pairingDevices?: DiscoveredDevice[];
  error?: string;
}

// ── Discovery Protocol Types ──────────────────────────────────────────
export type DiscoverySource = 'udp_broadcast' | 'ssdp' | 'http_probe' | 'mdns' | 'database' | 'arp' | 'ping' | 'usb' | 'local';
export type DiscoveredDeviceCategory = 'BLASTI' | 'NETWORK' | 'UPNP' | 'LOCAL';

export interface RealDiscoveredDevice {
  id: string;
  source: DiscoverySource;
  category: DiscoveredDeviceCategory;
  type: DeviceType | 'APP' | 'UNKNOWN';
  name: string;
  nameAr?: string;
  nameFr?: string;
  ip: string;
  port: number;
  mac?: string;
  model?: string;
  manufacturer?: string;
  appVersion?: string;
  fingerprint?: string;
  capabilities: string[];
  status: 'ONLINE' | 'STALE';
  lastSeen: number;
  firstSeen: number;
  connectionType: 'LAN' | 'WIFI' | 'USB' | 'UNKNOWN';
  ssdpLocation?: string;
  httpUrl?: string;
  httpTitle?: string;
  httpServer?: string;
  httpStatus?: number;
  ssdpServer?: string;
  ssdpSt?: string;
  mdnsService?: string;
  /** USB Vendor ID (hex) — populated by USB probe */
  usbVendorId?: string;
  /** USB Product ID (hex) — populated by USB probe */
  usbProductId?: string;
  /** CUPS printer URI (e.g. "ipp://localhost/printers/X") */
  cupsUri?: string;
  /** CUPS printer queue name */
  cupsName?: string;
  /** CUPS state: idle, printing, stopped */
  cupsState?: string;
  /** USB bus:device path */
  usbBusDevice?: string;
  /** Inferred vendor from MAC OUI */
  macVendor?: string;
  /** Reverse-DNS hostname (PTR record) resolved for this IP */
  reverseDnsName?: string;
  /** NetBIOS workstation name (from NBNS port 137 query) */
  netbiosName?: string;
}

export type ScanPhase = 'idle' | 'arp' | 'ping' | 'udp' | 'ssdp' | 'mdns' | 'names' | 'http' | 'https' | 'local' | 'fingerprinting' | 'complete' | 'error';

export interface ScanState {
  scanning: boolean;
  scanId: string | null;
  totalIPs: number;
  scannedIPs: number;
  currentSubnet: string;
  phase: ScanPhase;
  devicesFound: number;
  subnets: string[];
  protocolsUsed: string[];
  elapsed: number;
}

export interface DeviceStats {
  total: number;
  online: number;
  offline: number;
  pairing: number;
  byType: Record<string, number>;
}

export interface ProtocolStatus {
  name: string;
  enabled: boolean;
  available: boolean;
  description: string;
}

export interface NetworkInterface {
  name: string;
  address: string;
  netmask: string;
  cidr: string;
  family: string;
  internal: boolean;
  mac: string;
}

export interface Diagnostics {
  networkInterfaces: NetworkInterface[];
  protocolAvailability: Record<string, boolean>;
  databaseStats: { devices: number; scans: number; aliases: number; size: string };
  config: Record<string, unknown>;
  uptime: number;
  memoryUsage: { rss: number; heapUsed: number; heapTotal: number };
}

export const DEFAULT_SCAN_STATE: ScanState = {
  scanning: false,
  scanId: null,
  totalIPs: 0,
  scannedIPs: 0,
  currentSubnet: '',
  phase: 'idle',
  devicesFound: 0,
  subnets: [],
  protocolsUsed: [],
  elapsed: 0,
};

// ─── Constants ──────────────────────────────────────────────────────────────

export const API_BASE = '/api/agency-devices';
export const PORT_Q = 'XTransformPort=3003';
export const HEARTBEAT_THRESHOLD_MS = 30_000;
export const PAIRING_EXPIRE_MS = 10 * 60 * 1000;

export const DEVICE_TYPE_CONFIG: Record<
  DeviceType,
  { icon: typeof Monitor; labelAr: string; labelEn: string; labelFr?: string; color: string }
> = {
  TV: {
    icon: () => null,
    labelAr: 'تلفزيون',
    labelEn: 'TV',
    labelFr: 'Télévision',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  KIOSK: {
    icon: () => null,
    labelAr: 'كيوسك',
    labelEn: 'Kiosk',
    labelFr: 'Kiosque',
    color: 'bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400',
  },
  DISPLAY: {
    icon: () => null,
    labelAr: 'شاشة عرض',
    labelEn: 'Display',
    labelFr: 'Écran',
    color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-400',
  },
  PRINTER: {
    icon: () => null,
    labelAr: 'طابعة تذاكر',
    labelEn: 'Ticket Printer',
    labelFr: 'Imprimante',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  },
  APP: {
    icon: () => null,
    labelAr: 'تطبيق بلاصتي',
    labelEn: 'BLASTI App',
    labelFr: 'Application BLASTI',
    color: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
  },
  PHONE: {
    icon: () => null,
    labelAr: 'هاتف ذكي',
    labelEn: 'Phone',
    labelFr: 'Téléphone',
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  },
  ROUTER: {
    icon: () => null,
    labelAr: 'موجّه (راوتر)',
    labelEn: 'Router',
    labelFr: 'Routeur',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  },
  IOT: {
    icon: () => null,
    labelAr: 'جهاز ذكي',
    labelEn: 'IoT Device',
    labelFr: 'Objet connecté',
    color: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400',
  },
};

// NOTE: DEVICE_TYPE_CONFIG icons are replaced at runtime via `initDeviceTypeIcons()`
// because lucide-react icons cannot be used in static object definitions in this module
// without a client context. The parent component calls `initDeviceTypeIcons()` once.

import {
  Monitor,
  Tv,
  Printer,
  Tablet,
  Cast,
  Wifi,
  Cable,
  Settings,
  RefreshCw,
  Power,
  HardDrive,
  ShieldCheck,
  Smartphone,
  Radio,
  Globe,
  Database,
  Router,
  Cpu,
  Usb,
  ServerCog,
} from 'lucide-react';
import { useState, useEffect } from 'react';

export function initDeviceTypeIcons() {
  DEVICE_TYPE_CONFIG.TV.icon = Tv;
  DEVICE_TYPE_CONFIG.KIOSK.icon = Tablet;
  DEVICE_TYPE_CONFIG.DISPLAY.icon = Cast;
  DEVICE_TYPE_CONFIG.PRINTER.icon = Printer;
  DEVICE_TYPE_CONFIG.APP.icon = Smartphone;
  DEVICE_TYPE_CONFIG.PHONE.icon = Smartphone;
  DEVICE_TYPE_CONFIG.ROUTER.icon = Router;
  DEVICE_TYPE_CONFIG.IOT.icon = Cpu;
}

export const STATUS_CONFIG: Record<
  DeviceStatus,
  { labelAr: string; labelEn: string; labelFr?: string; color: string; dotColor: string; pulse: boolean }
> = {
  ONLINE: {
    labelAr: 'متصل',
    labelEn: 'Online',
    labelFr: 'En ligne',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    dotColor: 'bg-emerald-500',
    pulse: true,
  },
  OFFLINE: {
    labelAr: 'غير متصل',
    labelEn: 'Offline',
    labelFr: 'Hors ligne',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
    dotColor: 'bg-gray-400',
    pulse: false,
  },
  PAIRING: {
    labelAr: 'جاري الربط',
    labelEn: 'Pairing',
    labelFr: 'Association',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
    dotColor: 'bg-amber-500',
    pulse: true,
  },
  DISABLED: {
    labelAr: 'معطّل',
    labelEn: 'Disabled',
    labelFr: 'Désactivé',
    color: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
    dotColor: 'bg-red-500',
    pulse: false,
  },
  UPDATING: {
    labelAr: 'جاري التحديث',
    labelEn: 'Updating',
    labelFr: 'Mise à jour',
    color: 'bg-blue-100 text-blue-700 dark:bg-blue-950/40 dark:text-blue-400',
    dotColor: 'bg-blue-500',
    pulse: true,
  },
};

export const CONNECTION_TYPE_CONFIG: Record<
  ConnectionType,
  { labelAr: string; labelEn: string; labelFr?: string; icon: typeof Wifi }
> = {
  LAN: { labelAr: 'شبكة محلية', labelEn: 'LAN', labelFr: 'Réseau local', icon: Cable },
  WIFI: { labelAr: 'واي فاي', labelEn: 'Wi-Fi', labelFr: 'Wi-Fi', icon: Wifi },
  CABLE: { labelAr: 'كابل', labelEn: 'Cable', labelFr: 'Câble', icon: Cable },
  MANUAL: { labelAr: 'يدوي', labelEn: 'Manual', labelFr: 'Manuel', icon: Settings },
  USB: { labelAr: 'USB', labelEn: 'USB', labelFr: 'USB', icon: Usb },
};

export const SCREEN_LAYOUT_CONFIG: Record<
  ScreenLayout,
  { labelAr: string; labelEn: string; labelFr?: string; icon: typeof Monitor }
> = {
  QUEUE_BOARD: { labelAr: 'لوحة الطابور', labelEn: 'Queue Board', labelFr: 'Tableau d\'attente', icon: Tv },
  TICKET_PRINTER: { labelAr: 'طابعة التذاكر', labelEn: 'Ticket Printer', labelFr: 'Imprimante de tickets', icon: Printer },
  SERVICE_SELECTOR: { labelAr: 'اختيار الخدمة', labelEn: 'Service Selector', labelFr: 'Sélecteur de service', icon: Tablet },
  CUSTOM: { labelAr: 'مخصص', labelEn: 'Custom', labelFr: 'Personnalisé', icon: Settings },
};

export const COMMAND_TYPE_CONFIG: Record<
  CommandType,
  { labelAr: string; labelEn: string; labelFr?: string; icon: typeof RefreshCw; color: string }
> = {
  REFRESH: {
    icon: RefreshCw,
    labelAr: 'تحديث',
    labelEn: 'Refresh',
    labelFr: 'Rafraîchir',
    color: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-950/40 dark:text-cyan-400',
  },
  REBOOT: {
    icon: Power,
    labelAr: 'إعادة تشغيل',
    labelEn: 'Reboot',
    labelFr: 'Redémarrer',
    color: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
  },
  CONFIG_UPDATE: {
    icon: Settings,
    labelAr: 'تحديث الإعدادات',
    labelEn: 'Config Update',
    labelFr: 'Mise à jour config',
    color: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
  },
  CLEAR_CACHE: {
    icon: HardDrive,
    labelAr: 'مسح الذاكرة المؤقتة',
    labelEn: 'Clear Cache',
    labelFr: 'Vider le cache',
    color: 'bg-orange-100 text-orange-700 dark:bg-orange-950/40 dark:text-orange-400',
  },
  UPDATE_FIRMWARE: {
    icon: ShieldCheck,
    labelAr: 'تحديث البرنامج',
    labelEn: 'Update Firmware',
    labelFr: 'Mise à jour firmware',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
};

export const COMMAND_STATUS_CONFIG: Record<
  CommandStatus,
  { labelAr: string; labelEn: string; labelFr?: string; color: string }
> = {
  PENDING: {
    labelAr: 'قيد الانتظار',
    labelEn: 'Pending',
    labelFr: 'En attente',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  },
  DELIVERED: {
    labelAr: 'تم التسليم',
    labelEn: 'Delivered',
    labelFr: 'Livré',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  },
  COMPLETED: {
    labelAr: 'مكتمل',
    labelEn: 'Completed',
    labelFr: 'Terminé',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  FAILED: {
    labelAr: 'فشل',
    labelEn: 'Failed',
    labelFr: 'Échoué',
    color: 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400',
  },
  EXPIRED: {
    labelAr: 'منتهي الصلاحية',
    labelEn: 'Expired',
    labelFr: 'Expiré',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
};

export const DISCOVERY_SOURCE_CONFIG: Record<
  DiscoverySource,
  { labelAr: string; labelEn: string; labelFr?: string; icon: typeof Radio; color: string }
> = {
  udp_broadcast: {
    icon: Radio,
    labelAr: 'بث UDP',
    labelEn: 'UDP',
    labelFr: 'UDP',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  },
  ssdp: {
    icon: Cast,
    labelAr: 'SSDP/UPnP',
    labelEn: 'UPnP',
    labelFr: 'UPnP',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
  },
  http_probe: {
    icon: Globe,
    labelAr: 'فحص HTTP',
    labelEn: 'HTTP',
    labelFr: 'HTTP',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
  },
  mdns: {
    icon: Wifi,
    labelAr: 'mDNS',
    labelEn: 'mDNS',
    labelFr: 'mDNS',
    color: 'bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400',
  },
  database: {
    icon: Database,
    labelAr: 'قاعدة البيانات',
    labelEn: 'Database',
    labelFr: 'Base de données',
    color: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  },
  arp: {
    icon: Radio,
    labelAr: 'ARP',
    labelEn: 'ARP',
    labelFr: 'ARP',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  },
  ping: {
    icon: Radio,
    labelAr: 'Ping',
    labelEn: 'Ping',
    labelFr: 'Ping',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
  },
  usb: {
    icon: Usb,
    labelAr: 'USB',
    labelEn: 'USB',
    labelFr: 'USB',
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  },
  local: {
    icon: ServerCog,
    labelAr: 'CUPS محلي',
    labelEn: 'CUPS Local',
    labelFr: 'CUPS Local',
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
  },
};

export const DISCOVERY_CATEGORY_CONFIG: Record<
  DiscoveredDeviceCategory,
  { labelAr: string; labelEn: string; labelFr?: string; color: string; borderColor: string }
> = {
  BLASTI: {
    labelAr: 'بلاصتي',
    labelEn: 'BLASTI',
    labelFr: 'BLASTI',
    color: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400',
    borderColor: 'border-emerald-200 dark:border-emerald-900/40',
  },
  NETWORK: {
    labelAr: 'شبكة',
    labelEn: 'Network',
    labelFr: 'Réseau',
    color: 'bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400',
    borderColor: 'border-sky-200 dark:border-sky-900/40',
  },
  UPNP: {
    labelAr: 'UPnP',
    labelEn: 'UPnP',
    labelFr: 'UPnP',
    color: 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400',
    borderColor: 'border-amber-200 dark:border-amber-900/40',
  },
  LOCAL: {
    labelAr: 'محلي (USB)',
    labelEn: 'Local (USB)',
    labelFr: 'Local (USB)',
    color: 'bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400',
    borderColor: 'border-rose-200 dark:border-rose-900/40',
  },
};

// ─── Animation Variants ─────────────────────────────────────────────────────

export const fadeUp = {
  hidden: { opacity: 0, y: 12 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.35, ease: 'easeOut' as const } },
};

export const staggerContainer = {
  hidden: { opacity: 0 },
  visible: { opacity: 1, transition: { staggerChildren: 0.05 } },
};

export const staggerItem = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0, transition: { duration: 0.25 } },
};

// ─── Helpers ────────────────────────────────────────────────────────────────

export function parseDisplaySettings(raw: string | Record<string, unknown>): DisplaySettings {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw || '{}');
    } catch {
      return {};
    }
  }
  return (raw as DisplaySettings) || {};
}

export function isRecentlyAlive(lastHeartbeatAt?: string | null): boolean {
  if (!lastHeartbeatAt) return false;
  const diff = Date.now() - new Date(lastHeartbeatAt).getTime();
  return diff < HEARTBEAT_THRESHOLD_MS;
}

export function getHeartbeatLabel(lastHeartbeatAt?: string | null): {
  text: string;
  color: string;
} {
  if (!lastHeartbeatAt) {
    return { text: 'neverConnected', color: 'text-red-500' };
  }
  const diffMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  if (diffMs < HEARTBEAT_THRESHOLD_MS) {
    return { text: 'heartbeatAlive', color: 'text-emerald-500' };
  }
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  let ago = '';
  if (diffSec < 60) ago = `${diffSec}s`;
  else if (diffMin < 60) ago = `${diffMin}m`;
  else if (diffHr < 24) ago = `${diffHr}h ${diffMin % 60}m`;
  else ago = `${diffDay}d ${diffHr % 24}h`;
  return { text: `lastSeenAgo|${ago}`, color: 'text-amber-500' };
}

export function formatUptime(totalSec?: number | null): string {
  if (!totalSec || totalSec <= 0) return '—';
  const hrs = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export function timeSince(dateStr?: string | null): string {
  if (!dateStr) return '—';
  const diffMs = Date.now() - new Date(dateStr).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 60) return `${diffSec}s ago`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  return `${Math.floor(diffHr / 24)}d ago`;
}

export function formatDiscoveryLastSeen(
  lastHeartbeatAt: string | null | undefined,
  _lang: string,
  t: (key: string) => string,
): string {
  if (!lastHeartbeatAt) return '—';
  const diffMs = Date.now() - new Date(lastHeartbeatAt).getTime();
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return t('dmJustNow');
  if (diffSec < 60) return `${diffSec}${t('dmSecondsAgo')}`;
  const diffMin = Math.floor(diffSec / 60);
  return `${diffMin}${t('dmMinutesAgo')}`;
}

export function getConnectionQuality(device: AgencyDevice): {
  label: string;
  quality: 'excellent' | 'good' | 'fair' | 'poor';
} {
  if (device.status !== 'ONLINE' || !device.lastHeartbeatAt) {
    return { label: 'Poor', quality: 'poor' };
  }
  const diffMs = Date.now() - new Date(device.lastHeartbeatAt).getTime();
  if (diffMs < 10000) return { label: 'Excellent', quality: 'excellent' };
  if (diffMs < 20000) return { label: 'Good', quality: 'good' };
  if (diffMs < 30000) return { label: 'Fair', quality: 'fair' };
  return { label: 'Poor', quality: 'poor' };
}

export function getLocalizedName(device: { name: string; nameAr?: string | null; nameFr?: string | null }, lang: string): string {
  if (lang === 'ar' && device.nameAr) return device.nameAr;
  if (lang === 'fr' && device.nameFr) return device.nameFr;
  return device.name;
}

export function getLocalizedString(ar: string, fr: string, en: string, lang: string): string {
  if (lang === 'ar') return ar;
  if (lang === 'fr') return fr;
  return en;
}

export function getLocalizedLabel(cfg: { labelAr: string; labelEn: string; labelFr?: string }, lang: string): string {
  if (lang === 'ar') return cfg.labelAr;
  if (lang === 'fr' && cfg.labelFr) return cfg.labelFr;
  return cfg.labelEn;
}

// ─── Hook: Heartbeat force-update ticker ────────────────────────────────────

export function useHeartbeatTick(intervalMs = 5000) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
}

// ─── Sub-Components ─────────────────────────────────────────────────────────

import { Heart } from 'lucide-react';

export function PulseDot({ color, pulse }: { color: string; pulse: boolean }) {
  if (!pulse) {
    return <span className={`inline-block h-2 w-2 rounded-full ${color}`} />;
  }
  return (
    <span className="relative flex h-2 w-2">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 ${color}`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

export function StatusDot({ status }: { status: DeviceStatus }) {
  const cfg = STATUS_CONFIG[status];
  return <PulseDot color={cfg.dotColor} pulse={cfg.pulse} />;
}

export function HeartbeatIndicator({ lastHeartbeatAt }: { lastHeartbeatAt?: string | null }) {
  useHeartbeatTick(5000);
  const alive = isRecentlyAlive(lastHeartbeatAt);
  return (
    <div className="flex items-center gap-1.5">
      <Heart className={`h-3.5 w-3.5 ${alive ? 'text-emerald-500 animate-pulse' : 'text-gray-400'}`} />
      <span className={`text-xs ${alive ? 'text-emerald-600 dark:text-emerald-400' : 'text-muted-foreground'}`}>
        {alive ? '♥' : '♡'}
      </span>
    </div>
  );
}

export function ConnectionQualityBar({ quality }: { quality: 'excellent' | 'good' | 'fair' | 'poor' }) {
  const colors = {
    excellent: 'bg-emerald-500',
    good: 'bg-lime-500',
    fair: 'bg-amber-500',
    poor: 'bg-red-500',
  };
  const widths = { excellent: 'w-full', good: 'w-3/4', fair: 'w-1/2', poor: 'w-1/4' };
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-muted overflow-hidden">
        <div className={`h-full rounded-full transition-all ${colors[quality]} ${widths[quality]}`} />
      </div>
      <span className="text-[10px] text-muted-foreground capitalize">{quality}</span>
    </div>
  );
}

export function ScreenLayoutIcon({ layout, className }: { layout: ScreenLayout; className?: string }) {
  const cfg = SCREEN_LAYOUT_CONFIG[layout];
  const Icon = cfg.icon;
  return <Icon className={className} />;
}