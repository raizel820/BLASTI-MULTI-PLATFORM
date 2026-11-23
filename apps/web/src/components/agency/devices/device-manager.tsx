'use client';

/**
 * DeviceManager — unified device manager (0.6.74 full redesign).
 * ────────────────────────────────────────────────────────────────────────
 * One screen, one workflow for EVERY device type (TV / Kiosk / Printer /
 * Display / PC):
 *
 *   1. Scan  → compact progress card + discovered devices appear inline
 *   2. Add   → one click on a discovered device (Save TV / Pair / Printer)
 *              or the "Add device" menu for manual provisioning
 *   3. Manage→ single grid with filters, quick actions and an overflow menu
 *
 * Replaces the old four-section layout (network-discovery-panel + device-card
 * + device-detail-sheet + device-dialogs + lan-topology-panel ≈ 4,300 lines)
 * with a single coherent surface. All API contracts are unchanged.
 */

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';
import type { TranslationKeys } from '@/i18n';
import { useAppStore } from '@/store/use-app-store';
import { useRealtime } from '@/hooks/use-realtime';
import { apiFetch } from '@/lib/api-fetch';
import { getCloudApiBaseUrl } from '@/lib/api-client';
import { unwrapListPayload } from '@/lib/list-payload';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
// 0.6.104 — per-kiosk default printer selector (compact select control)
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { TooltipProvider } from '@/components/ui/tooltip';
// 0.6.113 — connection-mode switch (Local only vs Cloud)
import { Switch } from '@/components/ui/switch';
import { motion } from 'framer-motion';
import {
  Monitor, RefreshCw, Copy, Radio, QrCode, Cast, Cable, ExternalLink,
  Loader2, Tv, Printer, Plus, Settings, Square, CheckCheck, Wifi,
  AlertTriangle, RadioTower, Usb, X, Search, MonitorPlay, Trash2, Unplug,
  Plug, Send, Smartphone, Laptop, Router as RouterIcon, Cpu,
  Cloud, CloudOff,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDiscoveryService } from '@/hooks/use-discovery-service';
// 0.6.99 — signal-based discovery whitelist (client mirror of the server shaper)
import { isSignalBackedDevice } from '@/lib/device-signal';

import { initDeviceTypeIcons } from './types';
import {
  type AgencyDevice, type RealDiscoveredDevice, type Branch, type DeviceType,
  type DeviceStatus, type ConnectionType, type CommandType, type ScreenLayout,
  type DisplaySettings, type ScanState, API_BASE, deviceApi, PAIRING_EXPIRE_MS,
  DEVICE_TYPE_CONFIG, STATUS_CONFIG, SCREEN_LAYOUT_CONFIG, DISCOVERY_SOURCE_CONFIG,
  fadeUp, getLocalizedString, getLocalizedName, getLocalizedLabel,
  getScanPhaseLabelKey, PulseDot, StatusDot, timeSince, useHeartbeatTick,
} from './types';
import { LanMasterCard } from './lan-master-card';
import { DeviceTreeCard } from './device-tree';
// 0.6.105 — dedicated Paired-PC section (realtime master PC + queue counters)
import { PairedPCSection } from './paired-pc-section';
import {
  type DeviceFormState,
  EditDeviceDialog, PairDeviceDialog, CommandDialog, ConfirmDialog,
  KioskCredDialog, CreateKioskDialog, TvPreviewDialog, TvQrDialog,
} from './manager-dialogs';

// Initialize lucide icons in the type config maps
initDeviceTypeIcons();

type DeviceFilter = 'ALL' | 'TV' | 'KIOSK' | 'PRINTER' | 'OTHER' | 'ONLINE' | 'OFFLINE' | 'NEEDS_ATTENTION';

interface UnpairedDevice {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  type: DeviceType;
  status: string;
  connectionType: ConnectionType;
  ipAddress?: string | null;
  port?: number | null;
  deviceFingerprint?: string | null;
  appVersion?: string | null;
  autoDiscovery: boolean;
  screenLayout: ScreenLayout;
  lastHeartbeatAt?: string | null;
  createdAt: string;
  // 0.6.95 — cloud-merged orphan (desktop split-brain fix): the pairing
  // request for this device must go to the CLOUD API, not the local one.
  cloudDevice?: boolean;
}

const EMPTY_FORM: DeviceFormState = {
  name: '', nameAr: '', nameFr: '',
  type: 'TV', connectionType: 'LAN',
  ipAddress: '', port: '',
  autoDiscovery: true, screenLayout: 'TV_CLASSIC',
  branchId: '', serviceFilter: '',
  status: 'OFFLINE', displaySettings: {},
  defaultPrinterDeviceId: '',
};

// ─── printerConfig helpers (0.6.104 — kiosk default printer) ───────────────

/** printerConfig arrives as a JSON string (local API) or object (cloud M7). */
function parseDevicePrinterConfig(device: AgencyDevice | null): Record<string, unknown> {
  if (!device?.printerConfig) return {};
  if (typeof device.printerConfig === 'object') return device.printerConfig as Record<string, unknown>;
  try { return JSON.parse(device.printerConfig) as Record<string, unknown>; } catch { return {}; }
}

/** The printer AgencyDevice id assigned to a kiosk via its printerConfig. */
function kioskAssignedPrinterId(device: AgencyDevice | null): string {
  const cfg = parseDevicePrinterConfig(device);
  return typeof cfg.defaultPrinterDeviceId === 'string' ? cfg.defaultPrinterDeviceId : '';
}

/**
 * Merge the kiosk default-printer assignment into a device's printerConfig —
 * an empty printerId removes the key so the kiosk falls back to the
 * agency-level DefaultPrinter.
 */
function kioskPrinterConfigWithAssignment(device: AgencyDevice | null, printerId: string): Record<string, unknown> {
  const nextCfg: Record<string, unknown> = { ...parseDevicePrinterConfig(device) };
  if (printerId) nextCfg.defaultPrinterDeviceId = printerId;
  else delete nextCfg.defaultPrinterDeviceId;
  return nextCfg;
}

export function DeviceManager() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const realtime = useRealtime();
  const agencyId = user?.agencyId;
  const rtl = isRTL(lang);
  useHeartbeatTick(10000);

  // ─── Data state ──────────────────────────────────────────────────────────
  const [devices, setDevices] = useState<AgencyDevice[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [unpairedDevices, setUnpairedDevices] = useState<UnpairedDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { scanState, discoveredDevices, serviceAvailable, startScan, stopScan } = useDiscoveryService(agencyId);
  const [dismissedIds, setDismissedIds] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<DeviceFilter>('ALL');
  // 0.6.105 — owner-only per-branch filter for paired devices. Rendered ONLY
  // when the agency has more than one branch; 'ALL' shows every branch.
  const [branchFilter, setBranchFilter] = useState<string>('ALL');

  const [savedTvIps, setSavedTvIps] = useState<Set<string>>(new Set());
  const [defaultPrinterIp, setDefaultPrinterIp] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

  // 0.6.78 — connect protocol + raw print states (per discovered-device id)
  const [connectingId, setConnectingId] = useState<string | null>(null);
  const [connectResults, setConnectResults] = useState<Record<string, 'verified' | 'failed'>>({});
  const [printingTestId, setPrintingTestId] = useState<string | null>(null);

  const fetchDevicesTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ─── Fetchers ────────────────────────────────────────────────────────────
  const fetchDevices = useCallback(async (silent = false) => {
    if (!agencyId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(API_BASE);
      if (!res.ok) throw new Error('failed');
      const data = await res.json();
      if (data.success) setDevices(data.devices ?? []);
      else throw new Error(data.error || 'error');
    } catch {
      setError(getLocalizedString('تعذر تحميل الأجهزة', 'Échec du chargement des appareils', 'Failed to load devices', lang));
    } finally {
      if (!silent) setLoading(false);
    }
  }, [agencyId, lang]);

  const fetchDevicesDebounced = useCallback(() => {
    if (fetchDevicesTimer.current) clearTimeout(fetchDevicesTimer.current);
    fetchDevicesTimer.current = setTimeout(() => fetchDevices(true), 500);
  }, [fetchDevices]);

  const fetchBranches = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${agencyId}`);
      if (res.ok) {
        const data = await res.json();
        setBranches(unwrapListPayload(data, ['branches', 'data']));
      }
    } catch { /* silent */ }
  }, [agencyId]);

  const fetchUnpaired = useCallback(async () => {
    try {
      const res = await apiFetch(`${API_BASE}/unpaired`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success) setUnpairedDevices(data.devices ?? []);
    } catch { /* nice-to-have */ }
  }, []);

  const fetchSavedMeta = useCallback(async () => {
    if (!agencyId) return;
    try {
      const [tvRes, prRes] = await Promise.all([
        apiFetch(deviceApi('/discovery/saved-tvs')),
        apiFetch(deviceApi('/discovery/default-printer')),
      ]);
      if (tvRes.ok) {
        const tvData = await tvRes.json();
        if (tvData.success && Array.isArray(tvData.savedTvs)) {
          setSavedTvIps(new Set(tvData.savedTvs.map((tv: { ip: string }) => tv.ip)));
        }
      }
      if (prRes.ok) {
        const prData = await prRes.json();
        setDefaultPrinterIp(prData.success && prData.defaultPrinter ? prData.defaultPrinter.ip || null : null);
      }
    } catch { /* silent */ }
  }, [agencyId]);

  useEffect(() => {
    fetchDevices();
    fetchBranches();
    fetchUnpaired();
    fetchSavedMeta();
  }, [fetchDevices, fetchBranches, fetchUnpaired, fetchSavedMeta]);

  // ─── 0.6.113 — CONNECTION MODE (Local only vs Cloud switch) ──────────────
  // 'local' → strict LAN/Wi-Fi device-to-device: the local API never consults
  // the cloud for discovery/pairing (no merges, no relays, no reconciles) and
  // the LAN topology reporter pauses — the cloud cannot interrupt anything.
  // 'cloud' → historic behaviour (LAN first + cloud relay/merge paths).
  const [connMode, setConnMode] = useState<'local' | 'cloud'>('cloud');
  const [connModeLoaded, setConnModeLoaded] = useState(false);
  const [connModeSaving, setConnModeSaving] = useState(false);

  const fetchConnMode = useCallback(async () => {
    try {
      const res = await apiFetch(deviceApi('/connection-mode'));
      if (res.ok) {
        const data = await res.json().catch(() => null);
        if (data && data.success && (data.mode === 'local' || data.mode === 'cloud')) {
          setConnMode(data.mode);
        }
      }
    } catch { /* keep default 'cloud' */ } finally {
      setConnModeLoaded(true);
    }
  }, []);

  useEffect(() => {
    if (agencyId) fetchConnMode();
  }, [agencyId, fetchConnMode]);

  const toggleConnMode = useCallback(async (cloudAllowed: boolean) => {
    const mode: 'local' | 'cloud' = cloudAllowed ? 'cloud' : 'local';
    if (mode === connMode || connModeSaving) return;
    const prev = connMode;
    setConnModeSaving(true);
    setConnMode(mode); // optimistic
    try {
      const res = await apiFetch(deviceApi('/connection-mode'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok || !data || !data.success) throw new Error((data && data.error) || 'failed');
      setConnMode(data.mode === 'local' ? 'local' : 'cloud');
      toast.success(
        `${t('dmConnModeSaved')} — ${data.mode === 'local' ? t('dmConnModeLocal') : t('dmConnModeCloud')}`,
      );
      // The mode instantly changes what the manager lists (cloud merges vanish
      // in local-only mode) — refresh both surfaces.
      fetchUnpaired();
      fetchDevices(true);
    } catch {
      setConnMode(prev);
      toast.error(t('dmConnModeSaveFailed'));
    } finally {
      setConnModeSaving(false);
    }
  }, [connMode, connModeSaving, fetchUnpaired, fetchDevices, t]);

  // Unpaired polling (0.6.105 — 5s: the approval strip must surface a newly
  // registered kiosk fast; the 10s poll made pairing feel "very slow").
  useEffect(() => {
    if (!agencyId) return;
    const interval = setInterval(fetchUnpaired, 5_000);
    return () => clearInterval(interval);
  }, [agencyId, fetchUnpaired]);

  // Realtime subscriptions
  useEffect(() => {
    if (!agencyId) return;
    const unsubs = [
      realtime.subscribe('device:registered', fetchDevicesDebounced),
      realtime.subscribe('device:status-changed', fetchDevicesDebounced),
      realtime.subscribe('device:online', fetchDevicesDebounced),
      realtime.subscribe('agency-device:connected', fetchDevicesDebounced),
    ];
    return () => unsubs.forEach((u) => u());
  }, [agencyId, fetchDevicesDebounced, realtime]);

  // ─── Device form / dialog state ──────────────────────────────────────────
  const [formOpen, setFormOpen] = useState(false);
  const [editingDevice, setEditingDevice] = useState<AgencyDevice | null>(null);
  const [form, setForm] = useState<DeviceFormState>(EMPTY_FORM);
  const [formSubmitting, setFormSubmitting] = useState(false);

  const [pairingDevice, setPairingDevice] = useState<AgencyDevice | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingTimer, setPairingTimer] = useState(PAIRING_EXPIRE_MS);

  const [commandDevice, setCommandDevice] = useState<AgencyDevice | null>(null);
  const [commandType, setCommandType] = useState<CommandType>('REFRESH');
  const [commandSending, setCommandSending] = useState(false);

  const [confirmState, setConfirmState] = useState<
    { kind: 'delete' | 'unpair'; device: AgencyDevice } | null
  >(null);
  const [confirmLoading, setConfirmLoading] = useState(false);

  const [kioskCredDevice, setKioskCredDevice] = useState<AgencyDevice | null>(null);
  const [kioskCredLoading, setKioskCredLoading] = useState(false);
  const [kioskPairingCode, setKioskPairingCode] = useState('');
  const [kioskToken, setKioskToken] = useState('');
  const [kioskTokenVisible, setKioskTokenVisible] = useState(false);
  const [kioskCopied, setKioskCopied] = useState<string | null>(null);

  const [createKioskOpen, setCreateKioskOpen] = useState(false);
  const [createKioskLoading, setCreateKioskLoading] = useState(false);
  const [createKioskName, setCreateKioskName] = useState('');
  const [createKioskBranchId, setCreateKioskBranchId] = useState('');
  const [createKioskResult, setCreateKioskResult] = useState<{ pairingCode: string; deviceToken: string } | null>(null);

  const [tvPreviewDevice, setTvPreviewDevice] = useState<AgencyDevice | null>(null);
  const [tvQrOpen, setTvQrOpen] = useState(false);

  // ─── Derived ─────────────────────────────────────────────────────────────
  // 0.6.105 — owner vs staff: the Paired-PC section scopes per branch for the
  // owner and the branch filter only exists for owner accounts.
  const isOwner = user?.role === 'AGENCY_OWNER' || user?.role === 'SUPER_ADMIN';
  // 0.6.104 — registered printers of the agency: the source list for the
  // per-kiosk "Default printer" selector (same GET the manager already runs,
  // filtered client-side by type like the KIOSK/PRINTER filter chips).
  const registeredPrinters = useMemo(() => devices.filter((d) => d.type === 'PRINTER'), [devices]);
  const onlineCount = devices.filter((d) => d.status === 'ONLINE').length;
  const needsAttention = devices.filter((d) => d.status === 'OFFLINE' || d.status === 'DISABLED').length;
  // 0.6.101 — identity keys of the registry orphans already shown in the
  // "Devices waiting for approval" strip. A discovered card whose fingerprint
  // (or IP) matches is THE SAME DEVICE — rendering both was the reported
  // duplicate ("device with an IP address" + "device waiting for pairing").
  const unpairedKeys = useMemo(
    () => new Set(
      unpairedDevices
        .flatMap((d) => [d.deviceFingerprint, d.ipAddress])
        .filter((v: string | undefined | null): v is string => !!v)
        .map((v: string) => v.toLowerCase()),
    ),
    [unpairedDevices],
  );
  // 0.6.115 — identity keys of the REGISTERED registry. A device that is
  // already registered (paired kiosk, saved TV/printer/PC) must not ALSO
  // render as a live scan card — one entry per app running on a device
  // (user requirement: never show "a device AND an app" for the same unit).
  const registeredKeys = useMemo(
    () => new Set(
      devices
        .flatMap((d) => [d.deviceFingerprint, d.ipAddress])
        .filter((v: string | undefined | null): v is string => !!v)
        .map((v: string) => v.toLowerCase()),
    ),
    [devices],
  );
  const visibleDiscovered = useMemo(
    // 0.6.99 — SIGNAL-BASED whitelist (user requirement): only devices that
    // ANSWERED a discovery signal render here — BLASTI apps (beacon/mDNS/
    // probe), TVs and printers. Generic phones/PCs/routers/IoT/unknown noise
    // never renders, even if a stale server build leaks them through.
    // 0.6.101 — one card per device (fingerprint/IP dedupe vs the unpaired
    // strip) + locally-attached printers (ip 127.0.0.1) are VISIBLE again:
    // the old blanket `ip !== '127.0.0.1'` exclusion was exactly why the USB
    // printer plugged into the PC never appeared in discovery. The only
    // loopback cards still hidden are non-printers (the manager's own app).
    () => discoveredDevices.filter(
      (d) => {
        if (dismissedIds.has(d.id)) return false;
        if (d.ip === '127.0.0.1' && d.type !== 'PRINTER') return false;
        if (!isSignalBackedDevice(d)) return false;
        const fp = (d.fingerprint || d.blastiInfo?.fingerprint || d.blastiInfo?.instanceId || '').toLowerCase();
        if (fp && unpairedKeys.has(fp)) return false;
        if (d.ip && d.ip !== '127.0.0.1' && unpairedKeys.has(d.ip.toLowerCase())) return false;
        // 0.6.115 — the registry owns the entry once the device is registered.
        if (fp && registeredKeys.has(fp)) return false;
        if (d.ip && d.ip !== '127.0.0.1' && registeredKeys.has(d.ip.toLowerCase())) return false;
        return true;
      },
    ),
    [discoveredDevices, dismissedIds, unpairedKeys, registeredKeys],
  );
  const hasDiscoveryContent = scanState.scanning || visibleDiscovered.length > 0 || unpairedDevices.length > 0;

  const filteredDevices = useMemo(() => {
    switch (filter) {
      case 'ALL': return devices;
      case 'TV': return devices.filter((d) => d.type === 'TV' || d.type === 'DISPLAY');
      case 'KIOSK': return devices.filter((d) => d.type === 'KIOSK');
      case 'PRINTER': return devices.filter((d) => d.type === 'PRINTER');
      case 'ONLINE': return devices.filter((d) => d.status === 'ONLINE');
      case 'OFFLINE': return devices.filter((d) => d.status === 'OFFLINE' || d.status === 'DISABLED');
      case 'NEEDS_ATTENTION': return devices.filter((d) => d.status === 'PAIRING' || d.status === 'OFFLINE' || d.status === 'DISABLED');
      default: return devices.filter((d) => !['TV', 'DISPLAY', 'KIOSK', 'PRINTER'].includes(d.type));
    }
  }, [devices, filter]);

  // 0.6.105 — the owner's per-branch paired-device filter (applies on top of
  // the type/status chips; only ever non-ALL when the agency has >1 branch).
  const branchFilteredDevices = useMemo(
    () => (branchFilter === 'ALL'
      ? filteredDevices
      : filteredDevices.filter((d) => d.branchId === branchFilter)),
    [filteredDevices, branchFilter],
  );

  // ─── TV URLs ─────────────────────────────────────────────────────────────
  const buildTvUrl = useCallback((device: AgencyDevice | null, layout?: ScreenLayout) => {
    const params = new URLSearchParams({ mode: 'device', type: 'TV' });
    if (agencyId) params.set('agencyId', agencyId);
    const resolvedLayout = layout ?? (device && SCREEN_LAYOUT_CONFIG[device.screenLayout]?.isTvDesign ? device.screenLayout : undefined);
    if (resolvedLayout && SCREEN_LAYOUT_CONFIG[resolvedLayout]?.urlParam) {
      params.set('layout', SCREEN_LAYOUT_CONFIG[resolvedLayout].urlParam!);
    }
    if (device) {
      const ds = typeof device.displaySettings === 'string' ? (() => { try { return JSON.parse(device.displaySettings || '{}'); } catch { return {}; } })() : device.displaySettings ?? {};
      Object.entries(ds as Record<string, unknown>).forEach(([k, v]) => { if (v !== undefined && v !== null) params.set(`ds_${k}`, String(v)); });
      if (device.branchId) params.set('branchId', device.branchId);
    }
    return `${window.location.origin}/?${params.toString()}`;
  }, [agencyId]);

  const genericTvUrl = useMemo(() => buildTvUrl(null), [buildTvUrl]);
  const designPreviewUrls = useMemo(
    () => (['TV_CLASSIC', 'TV_COUNTERS', 'TV_FOCUS', 'TV_MINIMAL'] as ScreenLayout[]).map((layout) => ({ layout, url: buildTvUrl(tvPreviewDevice, layout) })),
    [buildTvUrl, tvPreviewDevice],
  );

  // ─── Handlers: CRUD ──────────────────────────────────────────────────────
  const openAdd = (type: DeviceType = 'TV') => {
    setEditingDevice(null);
    setForm({ ...EMPTY_FORM, type, screenLayout: type === 'TV' ? 'TV_CLASSIC' : type === 'KIOSK' ? 'SERVICE_SELECTOR' : EMPTY_FORM.screenLayout });
    setFormOpen(true);
  };

  const openEdit = (device: AgencyDevice) => {
    setEditingDevice(device);
    const ds = typeof device.displaySettings === 'string' ? (() => { try { return JSON.parse(device.displaySettings || '{}'); } catch { return {}; } })() : device.displaySettings ?? {};
    setForm({
      name: device.name, nameAr: device.nameAr || '', nameFr: device.nameFr || '',
      type: device.type, connectionType: device.connectionType,
      ipAddress: device.ipAddress || '', port: device.port?.toString() || '',
      autoDiscovery: device.autoDiscovery, screenLayout: device.screenLayout,
      branchId: device.branchId || '', serviceFilter: device.serviceFilter || '',
      status: device.status, displaySettings: ds as DisplaySettings,
      // 0.6.104 — preselect the kiosk's assigned default printer
      defaultPrinterDeviceId: device.type === 'KIOSK' ? kioskAssignedPrinterId(device) : '',
    });
    setFormOpen(true);
  };

  const submitForm = async () => {
    setFormSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        nameAr: form.nameAr.trim() || undefined,
        nameFr: form.nameFr.trim() || undefined,
        type: form.type,
        connectionType: form.connectionType,
        ipAddress: form.ipAddress.trim() || undefined,
        port: form.port ? parseInt(form.port, 10) : undefined,
        autoDiscovery: form.autoDiscovery,
        screenLayout: form.screenLayout,
        branchId: form.branchId || null,
        serviceFilter: form.serviceFilter.trim() || undefined,
        displaySettings: form.displaySettings,
      };
      // 0.6.104 — kiosk default printer: persist the assignment on the KIOSK
      // row's printerConfig JSON (defaultPrinterDeviceId). Both the local and
      // cloud PATCH/POST device routes already accept printerConfig.
      if (form.type === 'KIOSK') {
        body.printerConfig = kioskPrinterConfigWithAssignment(editingDevice, form.defaultPrinterDeviceId);
      }
      const res = editingDevice
        ? await apiFetch(`${API_BASE}/${editingDevice.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        : await apiFetch(API_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          editingDevice ? 'تم تحديث الجهاز بنجاح' : 'تمت إضافة الجهاز',
          editingDevice ? 'Appareil mis à jour' : 'Appareil ajouté',
          editingDevice ? 'Device updated' : 'Device added',
          lang,
        ));
        setFormOpen(false);
        setEditingDevice(null);
        fetchDevices();
      } else {
        toast.error(data.error || getLocalizedString('فشل الحفظ', "Échec de l'enregistrement", 'Save failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally {
      setFormSubmitting(false);
    }
  };

  const handlePair = async (device: AgencyDevice) => {
    setPairingDevice(device); setPairingCode(''); setPairingCodeCopied(false);
    setPairingLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success && data.pairingCode) setPairingCode(data.pairingCode);
      else { toast.error(data.error || getLocalizedString('فشل توليد الرمز', 'Échec de génération du code', 'Failed to generate code', lang)); }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setPairingLoading(false); }
  };

  // Pairing countdown
  useEffect(() => {
    if (!pairingCode) return;
    setPairingTimer(PAIRING_EXPIRE_MS);
    const id = setInterval(() => {
      setPairingTimer((prev) => {
        if (prev <= 1000) { clearInterval(id); return 0; }
        return prev - 1000;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [pairingCode]);

  const handleConfirmDelete = async () => {
    if (!confirmState) return;
    setConfirmLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${confirmState.device.id}`, { method: 'DELETE' });
      const data = await res.json().catch(() => ({}));
      if (data.success) {
        toast.success(getLocalizedString('تم حذف الجهاز', 'Appareil supprimé', 'Device deleted', lang));
        setConfirmState(null);
        fetchDevices();
      } else {
        toast.error(data.error || getLocalizedString('فشل الحذف', 'Échec de la suppression', 'Delete failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setConfirmLoading(false); }
  };

  const handleConfirmUnpair = async () => {
    if (!confirmState) return;
    setConfirmLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${confirmState.device.id}/unpair`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم فك الربط', 'Appareil dissocié', 'Device unpaired', lang));
        setConfirmState(null);
        fetchDevices();
        fetchUnpaired();
      } else {
        toast.error(data.error || getLocalizedString('فشل فك الربط', 'Échec de la dissociation', 'Unpair failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setConfirmLoading(false); }
  };

  const sendCommand = async (device: AgencyDevice, type: CommandType) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم إرسال الأمر', 'Commande envoyée', 'Command sent', lang));
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل إرسال الأمر', "Échec de l'envoi", 'Command failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  const handleSendCommand = async () => {
    if (!commandDevice) return;
    setCommandSending(true);
    await sendCommand(commandDevice, commandType);
    setCommandSending(false);
    setCommandDevice(null);
  };

  const handleToggleEnable = async (device: AgencyDevice) => {
    const newStatus: DeviceStatus = device.status === 'DISABLED' ? 'OFFLINE' : 'DISABLED';
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          newStatus === 'DISABLED' ? 'تم تعطيل الجهاز' : 'تم تفعيل الجهاز',
          newStatus === 'DISABLED' ? 'Appareil désactivé' : 'Appareil activé',
          newStatus === 'DISABLED' ? 'Device disabled' : 'Device enabled',
          lang,
        ));
        fetchDevices(true);
      }
    } catch { /* silent */ }
  };

  // 0.6.104 — kiosk-assigned default printer (Fault: the kiosk must print on
  // the printer registered/attached to its branch, assignable per-kiosk from
  // the device manager). Saves the chosen printer AgencyDevice id on the
  // KIOSK row's printerConfig JSON (key `defaultPrinterDeviceId`); an empty
  // printerId clears the key so the kiosk falls back to the agency-level
  // DefaultPrinter. Uses the manager's own PATCH /api/agency-devices/:id
  // mechanism (apiFetch), which works against BOTH the local and cloud APIs.
  const handleSetKioskDefaultPrinter = async (device: AgencyDevice, printerId: string) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ printerConfig: kioskPrinterConfigWithAssignment(device, printerId) }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(t('dmKioskPrinterSaved'));
        fetchDevices(true);
      } else {
        toast.error(data.error || t('dmKioskPrinterSaveFailed'));
      }
    } catch {
      toast.error(t('dmKioskPrinterSaveFailed'));
    } finally { setBusyDeviceId(null); }
  };

  // ─── Handlers: kiosk credentials ─────────────────────────────────────────
  const openKioskCredentials = async (device: AgencyDevice) => {
    setKioskCredDevice(device);
    setKioskPairingCode(device.pairingCode || '');
    setKioskToken(''); setKioskTokenVisible(false); setKioskCopied(null);
    setKioskCredLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/kiosk-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        setKioskPairingCode(data.pairingCode);
        setKioskToken(data.deviceToken);
        if (data.regenerated) fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل التحميل', 'Échec du chargement', 'Failed to load', lang));
      }
    } catch { /* silent */ }
    finally { setKioskCredLoading(false); }
  };

  const handleRegenerateKioskCred = async () => {
    if (!kioskCredDevice) return;
    setKioskCredLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${kioskCredDevice.id}/kiosk-credentials/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        setKioskPairingCode(data.pairingCode);
        setKioskToken(data.deviceToken);
        setKioskTokenVisible(false);
        toast.success(getLocalizedString('تم إعادة إنشاء البيانات', 'Identifiants régénérés', 'Credentials regenerated', lang));
        fetchDevices(true);
      }
    } catch { /* silent */ }
    finally { setKioskCredLoading(false); }
  };

  const handleCreateKiosk = async () => {
    if (!createKioskName.trim()) return;
    setCreateKioskLoading(true);
    try {
      const body = {
        name: createKioskName.trim(),
        type: 'KIOSK', connectionType: 'MANUAL',
        branchId: createKioskBranchId || undefined,
        autoDiscovery: false, screenLayout: 'SERVICE_SELECTOR',
      };
      const res = await apiFetch(API_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        setCreateKioskResult({ pairingCode: data.device?.pairingCode || '', deviceToken: data.deviceToken || '' });
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل الإنشاء', 'Échec de la création', 'Creation failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setCreateKioskLoading(false); }
  };

  // ─── Handlers: discovery actions ─────────────────────────────────────────
  const handleSaveTv = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(deviceApi('/discovery/saved-tvs'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name, nameAr: device.nameAr, nameFr: device.nameFr,
          ip: device.ip, port: device.port, mac: device.mac,
          manufacturer: device.manufacturer || device.macVendor, model: device.model,
          ssdpLocation: device.ssdpLocation, mdnsService: device.mdnsService, source: device.source,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم حفظ التلفاز', 'Téléviseur enregistré', 'TV saved', lang));
        setSavedTvIps((prev) => new Set(prev).add(device.ip));
      } else {
        toast.error(data.error || getLocalizedString('فشل الحفظ', 'Échec de la sauvegarde', 'Save failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  const handleCastTv = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(deviceApi('/discovery/cast'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: device.ip, port: device.port,
          manufacturer: device.manufacturer || device.macVendor,
          name: device.name, ssdpLocation: device.ssdpLocation,
          mdnsService: device.mdnsService,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(data.message || getLocalizedString(
          data.protocol === 'blasti-tv'
            ? 'تم البث المباشر إلى تطبيق بلاستي على الشاشة'
            : 'تم البث بنجاح عبر ' + String(data.protocol || ''),
          data.protocol === 'blasti-tv'
            ? "Diffusion directe vers l'app BLASTI sur la TV"
            : 'Diffusion réussie via ' + String(data.protocol || ''),
          data.protocol === 'blasti-tv'
            ? 'Cast sent directly to the BLASTI app on the TV'
            : 'Cast successful via ' + String(data.protocol || ''),
          lang,
        ));
      } else {
        toast.error(data.message || data.error || getLocalizedString(
          'فشل البث — لا توجد بروتوكولات متاحة على هذا التلفاز',
          'Échec de la diffusion — aucun protocole disponible sur cette TV',
          'Cast failed — no protocol reachable on this TV',
          lang,
        ));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء البث', 'Erreur de diffusion', 'Error casting', lang));
    } finally { setBusyDeviceId(null); }
  };

  // 0.6.96 — "Request pairing" straight from a scan-result card: a discovered
  // BLASTI card carries its self-announced fingerprint; the desktop matches
  // (or creates) the device record and sends the pairing request. 0.6.100 —
  // the DEVICE must ACCEPT before the pairing completes (the kiosk shows
  // Accept/Reject cards, a PC pops a native dialog / lands in the master's
  // approval queue). This button only DELIVERS the request.
  const [pairRequestedIds, setPairRequestedIds] = useState<Set<string>>(new Set());
  const handlePairByIdentity = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const fingerprint = device.fingerprint || device.blastiInfo?.fingerprint || device.blastiInfo?.instanceId || '';
      const sendOnce = () => apiFetch(deviceApi('/discovery/pairing-request-by-identity'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fingerprint: fingerprint || undefined,
          name: device.name,
          ip: device.ip || undefined,
          port: device.port || undefined,
          deviceType: device.type,
        }),
      });
      // 0.6.112 — ONE bounded retry on 5xx/499: the local store can reject
      // the first write transiently (SQLITE_BUSY under the busy desktop main
      // process — the 2026-11-23 export showed a 19ms 500 that killed the
      // whole LAN delivery and pushed the flow onto the slow cloud relay).
      // A fast second attempt rides that out before anything else happens.
      let res = await sendOnce();
      if (!res.ok && (res.status >= 500 || res.status === 499)) {
        await new Promise((r) => setTimeout(r, 600));
        res = await sendOnce();
      }
      const data = await res.json().catch(() => null);
      if (data?.success) {
        setPairRequestedIds((prev) => new Set(prev).add(device.id));
        if (data.autoConnected) {
          toast.success(getLocalizedString(
            `تم الاتصال التلقائي بـ ${device.name}`,
            `Connexion automatique à ${device.name}`,
            `Auto-connected to ${device.name}`,
            lang,
          ));
        } else {
          // 0.6.99 → 0.6.106 — surface the delivery channels: the request
          // lands in this store, and is ALSO pushed through every channel
          // the device can receive: the device-to-device UDP offer (udpOffer,
          // ACKed by the device — instant, no cloud), the LAN HTTP offer to
          // targets that run a local API (lanOffer), and the cloud store the
          // device polls (cloudRelay).
          const viaUdp = Boolean(data.delivery?.udpOffer);
          const viaLan = Boolean(data.delivery?.lanOffer);
          const viaCloud = Boolean(data.delivery?.cloudRelay);
          const parts = [viaUdp ? 'device-to-device' : null, viaLan ? 'LAN' : null, viaCloud ? 'cloud' : null].filter(Boolean);
          const channel = parts.length > 0 ? ` (${parts.join(' + ')})` : '';
          toast.success(getLocalizedString(
            `تم إرسال طلب الربط${channel ? ` ${channel}` : ''} — انتظر موافقة الجهاز`,
            `Demande de jumelage envoyée${channel ? ` ${channel}` : ''} — en attente de l'appareil`,
            `Pairing request sent${channel ? ` ${channel}` : ''} — waiting for the device to accept`,
            lang,
          ));
        }
        fetchDevices(true);
        fetchUnpaired();
      } else {
        // 0.6.112 — surface the server's safe detail (SQLITE_BUSY, schema gap,
        // …) so a failed pairing request is diagnosable from the toast alone.
        const failMsg = [data?.error, data?.detail].filter(Boolean).join(' — ');
        toast.error(failMsg || getLocalizedString('فشل إرسال طلب الربط', "Échec de l'envoi", 'Pairing request failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  const handleSavePrinter = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const isUsb = device.connectionType === 'USB' || !device.ip;
      const res = await apiFetch(deviceApi('/discovery/default-printer'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name, nameAr: device.nameAr, nameFr: device.nameFr,
          ip: device.ip || undefined, port: device.port || 9100,
          mac: device.mac, manufacturer: device.manufacturer || device.macVendor, model: device.model,
          cupsName: device.cupsName, cupsUri: device.cupsUri,
          usbVendorId: device.usbVendorId, usbProductId: device.usbProductId,
          connectionType: isUsb ? 'USB' : device.connectionType === 'WIFI' ? 'WIFI' : 'LAN',
          source: device.source,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم تعيين الطابعة الافتراضية', 'Imprimante par défaut définie', 'Default printer saved', lang));
        setDefaultPrinterIp(device.ip || null);
      } else {
        toast.error(data.error || getLocalizedString('فشل التعيين', 'Échec', 'Failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  // 0.6.105 — SAVE PRINTER AS A CONNECTED DEVICE. The historic printer card
  // actions could only "Set agency default printer" (a DefaultPrinter meta
  // row — NOT a device) or "Register" a peripheral-report card. There was NO
  // button that saved the printer as a real AgencyDevice PRINTER row — so the
  // agency's registered-printer list stayed empty and the per-kiosk "Default
  // printer" selector had nothing to assign ("لا يوجد زر لحفظ الطابعة كجهاز
  // متصل ولا زر لتعيينها كطابعة افتراضية للكشك"). This handler creates the
  // PRINTER device row; the kiosk cards' selector becomes usable immediately.
  const savedPrinterKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const dev of devices) {
      if (dev.type !== 'PRINTER') continue;
      if (dev.ipAddress) keys.add(`ip:${dev.ipAddress.toLowerCase()}|name:${dev.name}`);
      if (dev.deviceFingerprint) keys.add(`fp:${dev.deviceFingerprint.toLowerCase()}`);
      const cfg = typeof dev.printerConfig === 'string'
        ? (() => { try { return JSON.parse(dev.printerConfig || '{}') as Record<string, unknown>; } catch { return {}; } })()
        : ((dev.printerConfig || {}) as Record<string, unknown>);
      if (cfg && typeof cfg.cupsName === 'string' && cfg.cupsName) keys.add(`cups:${cfg.cupsName.toLowerCase()}`);
    }
    return keys;
  }, [devices]);

  const printerDeviceKey = (d: RealDiscoveredDevice): string | null => {
    if (d.fingerprint) return `fp:${d.fingerprint.toLowerCase()}`;
    if (d.cupsName) return `cups:${d.cupsName.toLowerCase()}`;
    if (d.ip) return `ip:${d.ip.toLowerCase()}|name:${d.name}`;
    return null;
  };

  const handleSavePrinterAsDevice = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const isUsb = device.connectionType === 'USB' || !device.ip;
      const hostIp = device.hostIp || (device.ip === '127.0.0.1' ? null : undefined);
      const res = await apiFetch(API_BASE, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name,
          nameAr: device.nameAr || undefined,
          nameFr: device.nameFr || undefined,
          type: 'PRINTER',
          // CONNECTION_TYPES has no USB value on either store — the physical
          // attachment rides in printerConfig (attachment/hostIp/cupsName…).
          connectionType: isUsb ? 'MANUAL' : device.connectionType === 'WIFI' ? 'WIFI' : 'LAN',
          ipAddress: !isUsb && device.ip && device.ip !== '127.0.0.1' ? device.ip : undefined,
          port: !isUsb && device.port && device.port > 0 ? device.port : undefined,
          autoDiscovery: true,
          screenLayout: 'TICKET_PRINTER',
          printerConfig: {
            ...(isUsb ? { attachment: 'USB' } : {}),
            ...(hostIp ? { hostIp } : {}),
            ...(device.hostPort ? { hostPort: device.hostPort } : {}),
            ...(device.hostInstanceId || device.hostFingerprint ? { hostInstanceId: device.hostInstanceId || device.hostFingerprint } : {}),
            ...(device.hostName ? { hostName: device.hostName } : {}),
            ...(device.cupsName ? { cupsName: device.cupsName } : {}),
            ...(device.cupsUri ? { cupsUri: device.cupsUri } : {}),
            ...(device.usbVendorId ? { usbVendorId: device.usbVendorId } : {}),
            ...(device.usbProductId ? { usbProductId: device.usbProductId } : {}),
            ...(device.port && device.port > 0 && !isUsb ? { port: device.port } : {}),
            manufacturer: device.manufacturer || device.macVendor || undefined,
            model: device.model || undefined,
            source: device.source,
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          `تم حفظ الطابعة "${device.name}" كجهاز متصل`,
          `Imprimante "${device.name}" enregistrée comme appareil`,
          `Printer "${device.name}" saved as a connected device`,
          lang,
        ));
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل حفظ الطابعة', "Échec de l'enregistrement", 'Failed to save printer', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  // 0.6.100 — CASCADE PERIPHERAL REGISTRATION: a discovered printer that is
  // physically attached to ANOTHER branch PC (source 'peripheral-report') is
  // registered as a shared PRINTER device — usable by every branch device
  // (PCs + kiosks) for tickets, receipts and invoices through the host PC's
  // print service. Works regardless of which device launched the scan and
  // whether it is the master or not.
  const registeredPeripheralKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const dev of devices) {
      if (dev.type !== 'PRINTER') continue;
      const cfg = typeof dev.printerConfig === 'string'
        ? (() => { try { return JSON.parse(dev.printerConfig || '{}') as Record<string, unknown>; } catch { return {}; } })()
        : ((dev.printerConfig || {}) as Record<string, unknown>);
      if (cfg && cfg.attachment === 'USB' && cfg.hostIp) {
        // Match a discovered peripheral card: host ip + printer name.
        keys.add(`host:${cfg.hostIp}|name:${dev.name}`);
      }
    }
    return keys;
  }, [devices]);

  const handleRegisterPeripheral = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(deviceApi('/discovery/register-peripheral'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name,
          hostIp: device.hostIp || device.ip,
          hostPort: device.hostPort || 3080,
          hostInstanceId: device.hostInstanceId || device.hostFingerprint || undefined,
          hostName: device.hostName || undefined,
          printer: {
            name: device.name,
            manufacturer: device.manufacturer,
            model: device.model,
            cupsName: device.cupsName,
            cupsUri: device.cupsUri,
            usbVendorId: device.usbVendorId,
            usbProductId: device.usbProductId,
          },
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          `تم تسجيل الطابعة "${device.name}" — كل أجهزة الفرع يمكنها الطباعة عليها الآن`,
          `Imprimante "${device.name}" enregistrée — tout le réseau peut imprimer`,
          `Printer "${device.name}" registered — every branch device can now print to it`,
          lang,
        ));
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل تسجيل الطابعة', "Échec de l'enregistrement", 'Failed to register printer', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  const handleTestPrinter = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
      // 0.6.103 — a locally-attached USB printer (loopback card) has NO raw
      // JetDirect listener on 127.0.0.1:9100 — the TCP probe always answered
      // "printer unreachable" even though the printer was fine. For USB cards
      // the honest test is the OS print service: print a real test page
      // through the host's spooler (CUPS raw / Electron silent print).
      const isUsbLocal = device.ip === '127.0.0.1' || device.connectionType === 'USB' || (!device.ip && !!device.cupsName);
      if (isUsbLocal) {
        const res = await apiFetch(deviceApi('/discovery/print'), {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ip: device.ip || '127.0.0.1',
            cupsName: device.cupsName || undefined,
            connectionType: 'USB',
            test: true,
          }),
        });
        const data = await res.json();
        if (data.success) toast.success(getLocalizedString('تمت الطباعة عبر خدمة الطباعة', 'Imprimée via le service d’impression', 'Test page sent to the OS print service', lang));
        else toast.error(data.error || getLocalizedString('الطابعة لا تستجيب', 'Imprimante injoignable', 'Printer unreachable', lang));
        return;
      }
      const res = await apiFetch(`${API_BASE}/discovery/probe`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: device.ip, port: device.port, timeout: 3000 }),
      });
      const data = await res.json();
      if (data.reachable) toast.success(getLocalizedString('الطابعة متصلة', 'Imprimante joignable', 'Printer reachable', lang));
      else toast.error(getLocalizedString('الطابعة لا تستجيب', 'Imprimante injoignable', 'Printer unreachable', lang));
    } catch {
      toast.error(getLocalizedString('الطابعة لا تستجيب', 'Imprimante injoignable', 'Printer unreachable', lang));
    } finally { setBusyDeviceId(null); }
  };

  // ─── Connect protocol (0.6.78) ────────────────────────────────────────────
  // Deep-verify a discovered device: raw TCP connects + BLASTI /api/discover
  // marker. Returns the connection profile (open ports, mode, protocols) and
  // marks the device ONLINE in the discovery cache.
  const handleConnectDevice = async (device: RealDiscoveredDevice) => {
    if (!device.ip) return;
    setConnectingId(device.id);
    try {
      const res = await apiFetch(deviceApi('/discovery/connect'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: device.ip, port: device.port || undefined }),
      });
      const data = await res.json();
      if (data.success && data.verified) {
        setConnectResults((prev) => ({ ...prev, [device.id]: 'verified' }));
        const profile = data.profile || {};
        const protocolBits = profile.connection?.protocols
          ? Object.entries(profile.connection.protocols).filter(([, v]) => v).map(([k]) => k).join(', ')
          : '';
        toast.success(
          getLocalizedString(
            `تم الاتصال بـ ${profile.name || device.name}${protocolBits ? ` — ${protocolBits}` : ''}`,
            `Connecté à ${profile.name || device.name}${protocolBits ? ` — ${protocolBits}` : ''}`,
            `Connected to ${profile.name || device.name}${protocolBits ? ` — ${protocolBits}` : ''}`,
            lang,
          ),
        );
      } else {
        setConnectResults((prev) => ({ ...prev, [device.id]: 'failed' }));
        toast.error(getLocalizedString('تعذر الاتصال بالجهاز', 'Connexion impossible', 'Could not reach the device', lang));
      }
    } catch {
      setConnectResults((prev) => ({ ...prev, [device.id]: 'failed' }));
      toast.error(getLocalizedString('تعذر الاتصال بالجهاز', 'Connexion impossible', 'Could not reach the device', lang));
    } finally { setConnectingId(null); }
  };

  // Raw ESC/POS test page over the network — proves the printer connection
  // end-to-end without any OS driver.
  // 0.6.103 — for a locally-attached USB printer the network path does not
  // exist: the loopback target now routes to the host OS print service inside
  // the local API (raw JetDirect on 127.0.0.1 always ECONNREFUSED).
  const handlePrintTestPage = async (device: RealDiscoveredDevice) => {
    const isUsbLocal = device.ip === '127.0.0.1' || device.connectionType === 'USB' || (!device.ip && !!device.cupsName);
    setPrintingTestId(device.id);
    try {
      const res = await apiFetch(deviceApi('/discovery/print'), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: device.ip || '127.0.0.1',
          port: device.port || 9100,
          cupsName: device.cupsName || undefined,
          connectionType: isUsbLocal ? 'USB' : undefined,
          test: true,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تمت الطباعة', 'Page imprimée', 'Test page printed', lang));
      } else {
        toast.error(data.error || getLocalizedString('تعذر الاتصال بالطابعة', 'Imprimante injoignable', 'Printer unreachable', lang));
      }
    } catch {
      toast.error(getLocalizedString('تعذر الاتصال بالطابعة', 'Imprimante injoignable', 'Printer unreachable', lang));
    } finally { setPrintingTestId(null); }
  };

  const handleSendPairingRequest = async (deviceId: string) => {
    setBusyDeviceId(deviceId);
    try {
      // 0.6.95 — cloud-merged orphans (id prefix `cloud-`) live in the CLOUD
      // store: route their pairing request to the cloud API directly, since
      // the desktop apiClient always targets the local :3080 base.
      const isCloudDevice = deviceId.startsWith('cloud-');
      let data: { success?: boolean; error?: string } | null = null;
      if (isCloudDevice) {
        const token = useAppStore.getState().sessionToken;
        const cloudBase = getCloudApiBaseUrl().replace(/\/+$/, '');
        const res = await fetch(`${cloudBase}/api/agency-devices/${encodeURIComponent(deviceId.slice('cloud-'.length))}/pairing-request`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: '{}',
        });
        data = await res.json().catch(() => null);
      } else {
        const res = await apiFetch(`${API_BASE}/${deviceId}/pairing-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
        data = await res.json();
      }
      if (data?.success) {
        toast.success(getLocalizedString('تم إرسال طلب الربط', 'Demande de jumelage envoyée', 'Pairing request sent', lang));
        setUnpairedDevices((prev) => prev.filter((d) => d.id !== deviceId));
        fetchDevices(true);
      } else {
        toast.error(data?.error || getLocalizedString('فشل إرسال الطلب', "Échec de l'envoi", 'Request failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  // ─── Handlers: cast menu ─────────────────────────────────────────────────
  // 0.6.96 — CASTING REWORK (user requirement): real, DIRECT protocols only.
  // The Presentation-API "Google Cast" button (Chrome/Edge only) and the
  // "Open in TV browser" entry are GONE. Every cast goes through the device
  // API: registered TVs receive a direct CAST_URL command (BLASTI board app),
  // other TVs get Samsung Tizen / LG webOS / DLNA / CASTv2 / Roku pushes with
  // LAN-reachable URLs built by the server (bestLanIp).

  // LAN-reachable TV URL (QR / copy) — window.location.origin is loopback
  // inside Electron; the bridge exposes the host's real LAN IP.
  const [lanTvOrigin, setLanTvOrigin] = useState<string | null>(null);
  useEffect(() => {
    const electronApi = (window as unknown as { electronAPI?: { getLanServerInfo?: () => Promise<{ ip?: string; port?: number } | null> } }).electronAPI;
    if (electronApi?.getLanServerInfo) {
      electronApi.getLanServerInfo()
        .then((info) => {
          if (info && info.ip) setLanTvOrigin(`http://${info.ip}:${info.port || 3080}`);
        })
        .catch(() => { /* browser/mobile contexts keep window.origin */ });
    }
  }, []);
  const lanTvUrl = useMemo(
    () => (lanTvOrigin ? `${lanTvOrigin}/?mode=device&type=TV${agencyId ? `&agencyId=${agencyId}` : ''}` : genericTvUrl),
    [lanTvOrigin, genericTvUrl, agencyId],
  );

  // Cast the board to a REGISTERED TV — one direct CAST_URL command.
  const handleCastRegistered = async (device: AgencyDevice) => {
    setBusyDeviceId(device.id);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/cast`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          `تم إرسال البث إلى ${device.name} — ستعرض الشاشة اللوحة مباشرة`,
          `Diffusion envoyée à ${device.name} — l'écran affichera le tableau`,
          `Cast sent to ${device.name} — the screen will show the board`,
          lang,
        ));
      } else {
        toast.error(data.error || getLocalizedString('فشل البث', 'Échec de la diffusion', 'Cast failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء البث', 'Erreur de diffusion', 'Error casting', lang));
    } finally { setBusyDeviceId(null); }
  };

  const handleHdmi = useCallback(() => {
    const electronApi = (window as unknown as { electronAPI?: { openTvScreen?: (o: { url: string }) => void } }).electronAPI;
    if (electronApi?.openTvScreen) {
      electronApi.openTvScreen({ url: genericTvUrl });
      toast.success(getLocalizedString('تم فتح الشاشة على HDMI', 'Écran ouvert sur HDMI', 'Screen opened on HDMI', lang));
    } else {
      navigator.clipboard.writeText(lanTvUrl).then(() => {
        toast.info(getLocalizedString('تم نسخ الرابط — افتحه في تطبيق سطح المكتب', 'Lien copié — ouvrez-le dans l\'app desktop', 'URL copied — open in the desktop app', lang));
      });
    }
  }, [genericTvUrl, lanTvUrl, lang]);

  const copyText = useCallback((text: string, message?: string) => {
    navigator.clipboard.writeText(text).then(() => {
      toast.success(message || getLocalizedString('تم النسخ', 'Copié', 'Copied', lang));
    }).catch(() => {
      toast.error(getLocalizedString('فشل النسخ', 'Échec de la copie', 'Copy failed', lang));
    });
  }, [lang]);

  // ─── Render ──────────────────────────────────────────────────────────────
  if (!agencyId) {
    return (
      <div className="flex items-center justify-center min-h-[400px] p-4">
        <Card className="w-full max-w-md">
          <CardContent className="p-8 text-center space-y-3">
            <Settings className="h-12 w-12 mx-auto text-muted-foreground" />
            <h3 className="text-lg font-semibold">{getLocalizedString('لا توجد وكالة مرتبطة', 'Aucune agence assignée', 'No Agency Assigned', lang)}</h3>
          </CardContent>
        </Card>
      </div>
    );
  }

  const filterChips: Array<{ key: DeviceFilter; label: string; count: number }> = [
    { key: 'ALL', label: getLocalizedString('الكل', 'Tous', 'All', lang), count: devices.length },
    { key: 'TV', label: getLocalizedString('شاشات', 'Écrans', 'Screens', lang), count: devices.filter((d) => d.type === 'TV' || d.type === 'DISPLAY').length },
    { key: 'KIOSK', label: getLocalizedString('كيوسكات', 'Kiosques', 'Kiosks', lang), count: devices.filter((d) => d.type === 'KIOSK').length },
    { key: 'PRINTER', label: getLocalizedString('طابعات', 'Imprimantes', 'Printers', lang), count: devices.filter((d) => d.type === 'PRINTER').length },
    { key: 'ONLINE', label: getLocalizedString('متصل', 'En ligne', 'Online', lang), count: onlineCount },
    { key: 'OFFLINE', label: getLocalizedString('غير متصل', 'Hors ligne', 'Offline', lang), count: needsAttention },
  ];

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-5 p-4 md:p-6 max-w-7xl mx-auto" dir={rtl ? 'rtl' : 'ltr'}>
        {/* ── Header ── */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg">
                <Monitor className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{t('devicesConnection')}</h1>
                <p className="text-sm text-muted-foreground">{t('dmxSubtitle')}</p>
              </div>
            </div>

            <div className="flex items-center gap-2 flex-wrap">
              {/* Cast menu — 0.6.96: DIRECT protocols only, no browser entries */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5 bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-600 hover:to-teal-600 text-white shadow-md">
                    <Cast className="h-4 w-4" />
                    {getLocalizedString('بث إلى شاشة', 'Diffuser', 'Cast', lang)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>{getLocalizedString('بث مباشر — بلا متصفح', 'Diffusion directe — sans navigateur', 'Direct cast — no browser', lang)}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={handleHdmi}>
                    <Cable className="h-4 w-4 me-2" />
                    <div>
                      <div>{getLocalizedString('شاشة HDMI', 'Écran HDMI', 'HDMI screen', lang)}</div>
                      <div className="text-xs text-muted-foreground">{getLocalizedString('أي شاشة عبر سطح المكتب', 'Tout écran via le desktop', 'Any screen via desktop app', lang)}</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => copyText(lanTvUrl)}>
                    <Copy className="h-4 w-4 me-2" />
                    {getLocalizedString('نسخ رابط الشاشة (LAN)', 'Copier le lien (LAN)', 'Copy screen URL (LAN)', lang)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTvQrOpen(true)}>
                    <QrCode className="h-4 w-4 me-2" />
                    {getLocalizedString('عرض رمز QR', 'Afficher le QR', 'Show QR code', lang)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <p className="px-2 py-1.5 text-[11px] leading-snug text-muted-foreground">
                    {getLocalizedString(
                      'اضغط "بث" على بطاقة أي تلفاز مكتشف أو مسجل — يتم الإرسال مباشرة عبر بروتوكولات التلفاز (Samsung / LG / DLNA / Google Cast / Roku) أو بأمر مباشر لتطبيق بلاستي على الشاشة.',
                      'Appuyez « Diffuser » sur une TV découverte ou enregistrée — envoi direct via les protocoles TV (Samsung / LG / DLNA / Google Cast / Roku) ou commande directe à l\'app BLASTI.',
                      'Press "Cast" on any discovered or registered TV — sent directly via the TV\'s protocols (Samsung / LG / DLNA / Google Cast / Roku) or a direct command to the BLASTI app on the screen.',
                      lang,
                    )}
                  </p>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Add device menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 text-white shadow-md">
                    <Plus className="h-4 w-4" />
                    {getLocalizedString('إضافة جهاز', 'Ajouter un appareil', 'Add device', lang)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => openAdd('TV')}>
                    <Tv className="h-4 w-4 me-2" />
                    {getLocalizedLabel(DEVICE_TYPE_CONFIG.TV, lang)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openAdd('KIOSK')}>
                    <MonitorPlay className="h-4 w-4 me-2" />
                    {getLocalizedLabel(DEVICE_TYPE_CONFIG.KIOSK, lang)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => openAdd('PRINTER')}>
                    <Printer className="h-4 w-4 me-2" />
                    {getLocalizedLabel(DEVICE_TYPE_CONFIG.PRINTER, lang)}
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setCreateKioskOpen(true)}>
                    <QrCode className="h-4 w-4 me-2" />
                    {getLocalizedString('توليد بيانات كيوسك', 'Générer des identifiants kiosque', 'Generate kiosk credentials', lang)}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>

              {/* Scan */}
              {scanState.scanning ? (
                <Button size="sm" variant="destructive" className="gap-1.5" onClick={() => stopScan()}>
                  <Square className="h-4 w-4" />
                  {getLocalizedString('إيقاف', 'Arrêter', 'Stop', lang)}
                </Button>
              ) : (
                <Button size="sm" variant="outline" className="gap-1.5" onClick={() => startScan()} disabled={!serviceAvailable}>
                  <Radio className={`h-4 w-4 ${scanState.scanning ? 'animate-pulse' : ''}`} />
                  {getLocalizedString('فحص الشبكة', 'Scanner le réseau', 'Scan network', lang)}
                </Button>
              )}

              <Button variant="ghost" size="icon" onClick={() => fetchDevices()} aria-label="refresh">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Stats chips */}
          <div className="flex flex-wrap gap-2">
            <Badge variant="outline" className="gap-1.5 py-1.5">
              <PulseDot color="bg-emerald-500" pulse />
              {onlineCount} {getLocalizedString('متصل', 'en ligne', 'online', lang)}
            </Badge>
            <Badge variant="outline" className="gap-1.5 py-1.5">
              <PulseDot color="bg-gray-400" pulse={false} />
              {needsAttention} {getLocalizedString('يحتاج انتباه', 'à surveiller', 'need attention', lang)}
            </Badge>
            <Badge variant="outline" className="gap-1.5 py-1.5">
              {devices.length} {getLocalizedString('جهاز', 'appareils', 'devices', lang)}
            </Badge>
            {!serviceAvailable && (
              <Badge variant="outline" className="gap-1.5 py-1.5 text-amber-600 dark:text-amber-400">
                <AlertTriangle className="h-3.5 w-3.5" />
                {getLocalizedString('الفحص يعمل عبر الكمبيوتر الرئيسي فقط', 'Le scan nécessite le PC principal', 'Network scan needs the branch PC', lang)}
              </Badge>
            )}
          </div>

          {/* ── 0.6.113 — CONNECTION MODE switch (Local only / Cloud) ── */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 rounded-xl border bg-card p-3">
            <div className="flex items-start gap-2.5 min-w-0">
              {connMode === 'local'
                ? <CloudOff className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600 dark:text-emerald-400" />
                : <Cloud className="h-4 w-4 mt-0.5 shrink-0 text-teal-600 dark:text-teal-400" />}
              <div className="min-w-0">
                <div className="text-sm font-semibold leading-tight">{t('dmConnMode')}</div>
                <p className="text-xs text-muted-foreground mt-0.5 max-w-xl">
                  {connMode === 'local' ? t('dmConnModeLocalHint') : t('dmConnModeCloudHint')}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3 shrink-0">
              <span className={`text-xs font-medium ${connMode === 'local' ? 'text-foreground' : 'text-muted-foreground'}`}>
                {t('dmConnModeLocal')}
              </span>
              <Switch
                checked={connMode === 'cloud'}
                disabled={!connModeLoaded || connModeSaving}
                onCheckedChange={(v) => toggleConnMode(v)}
                aria-label={t('dmConnMode')}
              />
              <span className={`text-xs font-medium ${connMode === 'cloud' ? 'text-foreground' : 'text-muted-foreground'}`}>
                {t('dmConnModeCloud')}
              </span>
            </div>
          </div>
        </motion.div>

        {/* ── Branch PCs / LAN master ── */}
        <LanMasterCard agencyId={agencyId} lang={lang} />

        {/* ── 0.6.105 — PAIRED PC DEVICES (realtime master + queue counters) ──
            Staff: their branch only · Owner: per branch, honours the branch
            filter below. The counters ride the same shared-queue list that the
            master PC serializes. ── */}
        <PairedPCSection
          agencyId={agencyId}
          lang={lang}
          devices={devices}
          branches={branches}
          branchFilter={branchFilter}
          isOwner={isOwner}
        />

        {/* ── 0.6.100 — Branch DEVICE TREE (roles + status + pending pairings) ── */}
        <DeviceTreeCard
          agencyId={agencyId}
          lang={lang}
          devices={devices}
          printers={registeredPrinters}
          onDeviceUpdated={() => fetchDevices(true)}
        />

        {/* ── Discovery strip ── */}
        {hasDiscoveryContent && (
          <Card className="border-dashed">
            <CardContent className="p-4 space-y-4">
              {/* Scan progress */}
              {scanState.scanning && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3 text-sm">
                    <span className="flex items-center gap-2 font-medium">
                      <Radio className="h-4 w-4 animate-pulse text-emerald-500" />
                      {t(getScanPhaseLabelKey(scanState.phase) as TranslationKeys)}
                    </span>
                    <span className="text-xs text-muted-foreground tabular-nums" dir="ltr">
                      {scanState.devicesFound} · {scanState.scannedIPs}/{scanState.totalIPs || '…'}
                    </span>
                  </div>
                  <div className="h-1.5 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-teal-500 transition-all duration-500"
                      style={{ width: `${scanState.totalIPs ? Math.min(100, Math.round((scanState.scannedIPs / scanState.totalIPs) * 100)) : 12}%` }}
                    />
                  </div>
                  {scanState.protocolsUsed.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {scanState.protocolsUsed.slice(-6).map((p) => (
                        <Badge key={p} variant="secondary" className="text-[10px]">{p}</Badge>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Unpaired (kiosks waiting for approval) */}
              {unpairedDevices.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-amber-600 dark:text-amber-400">
                    {getLocalizedString('أجهزة تنتظر الموافقة', 'Appareils en attente', 'Devices waiting for approval', lang)}
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {unpairedDevices.map((d) => (
                      <div key={d.id} className="flex items-center gap-2 rounded-xl border border-amber-300/60 bg-amber-50/60 dark:border-amber-900/40 dark:bg-amber-950/20 px-3 py-2">
                        <StatusDot status="PAIRING" />
                        <div className="min-w-0">
                          <p className="text-sm font-medium truncate max-w-40">{getLocalizedName(d, lang)}</p>
                          <p className="text-[11px] text-muted-foreground" dir="ltr">{d.ipAddress || d.deviceFingerprint?.slice(0, 12) || '—'}</p>
                        </div>
                        <Button size="sm" className="h-7 gap-1 text-xs" disabled={busyDeviceId === d.id} onClick={() => handleSendPairingRequest(d.id)}>
                          {busyDeviceId === d.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCheck className="h-3.5 w-3.5" />}
                          {getLocalizedString('ربط', 'Associer', 'Pair', lang)}
                        </Button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Discovered network devices */}
              {visibleDiscovered.length > 0 && (
                <div className="space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {getLocalizedString('مكتشف على الشبكة', 'Découverts sur le réseau', 'Discovered on the network', lang)} ({visibleDiscovered.length})
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {visibleDiscovered.map((d) => (
                      <DiscoveredCard
                        key={d.id}
                        device={d}
                        lang={lang}
                        busy={busyDeviceId === d.id}
                        tvSaved={savedTvIps.has(d.ip)}
                        isDefaultPrinter={!!defaultPrinterIp && defaultPrinterIp === d.ip}
                        connecting={connectingId === d.id}
                        connectVerified={connectResults[d.id]}
                        printingTest={printingTestId === d.id}
                        registeredPeripheral={registeredPeripheralKeys.has(d.id)}
                        savedAsDevice={(() => { const k = printerDeviceKey(d); return !!k && savedPrinterKeys.has(k); })()}
                        onSaveTv={() => handleSaveTv(d)}
                        onCast={() => handleCastTv(d)}
                        onPair={() => handlePairByIdentity(d)}
                        pairRequested={pairRequestedIds.has(d.id)}
                        onSavePrinter={() => handleSavePrinter(d)}
                        onSavePrinterAsDevice={() => handleSavePrinterAsDevice(d)}
                        onRegisterPeripheral={() => handleRegisterPeripheral(d)}
                        onTestPrinter={() => handleTestPrinter(d)}
                        onPrintTest={() => handlePrintTestPage(d)}
                        onConnect={() => handleConnectDevice(d)}
                        onDismiss={() => setDismissedIds((prev) => new Set(prev).add(d.id))}
                      />
                    ))}
                  </div>
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {/* ── Filters ── */}
        <div className="flex flex-wrap items-center gap-2">
          {filterChips.map((chip) => (
            <button
              key={chip.key}
              type="button"
              onClick={() => setFilter(chip.key)}
              className={`rounded-full px-3.5 py-1.5 text-sm transition-colors ${
                filter === chip.key
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted/60 text-muted-foreground hover:bg-muted'
              }`}
            >
              {chip.label}
              <span className={`ms-1.5 text-xs tabular-nums ${filter === chip.key ? 'opacity-80' : 'opacity-60'}`}>{chip.count}</span>
            </button>
          ))}

          {/* 0.6.105 — OWNER-ONLY per-branch paired-device filter. Rendered
              only when the agency has MORE THAN ONE branch (requirement). */}
          {isOwner && branches.length > 1 && (
            <div className="flex items-center gap-1.5 ms-auto">
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {getLocalizedString('الفرع:', 'Succursale :', 'Branch:', lang)}
              </span>
              <Select value={branchFilter} onValueChange={setBranchFilter}>
                <SelectTrigger className="h-8 w-[170px] text-xs" aria-label={getLocalizedString('مرشّح الفرع', 'Filtre par succursale', 'Branch filter', lang)}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="ALL" className="text-xs">
                    {getLocalizedString('كل الفروع', 'Toutes les succursales', 'All branches', lang)}
                  </SelectItem>
                  {branches.map((b) => (
                    <SelectItem key={b.id} value={b.id} className="text-xs">
                      {getLocalizedName(b, lang)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {/* ── Unified device grid ── */}
        {error ? (
          <Card>
            <CardContent className="p-8 text-center space-y-3">
              <AlertTriangle className="h-10 w-10 mx-auto text-amber-500" />
              <p className="text-sm text-muted-foreground">{error}</p>
              <Button variant="outline" size="sm" onClick={() => fetchDevices()}>{getLocalizedString('إعادة المحاولة', 'Réessayer', 'Retry', lang)}</Button>
            </CardContent>
          </Card>
        ) : loading ? (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {[0, 1, 2].map((i) => (
              <Card key={i}><CardContent className="p-5 space-y-3">
                <div className="h-10 w-10 animate-pulse rounded-xl bg-muted" />
                <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
                <div className="h-3 w-1/3 animate-pulse rounded bg-muted" />
              </CardContent></Card>
            ))}
          </div>
        ) : branchFilteredDevices.length === 0 ? (
          <Card className="border-dashed">
            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
              <div className="p-3 rounded-2xl bg-muted"><Search className="h-6 w-6 text-muted-foreground" /></div>
              <p className="font-semibold">{getLocalizedString('لا توجد أجهزة بعد', 'Aucun appareil', 'No devices yet', lang)}</p>
              <p className="text-sm text-muted-foreground max-w-md">
                {getLocalizedString(
                  'افتح تطبيق بلاصتي على الشاشة أو الكيوسك وسيظهر هنا تلقائياً، أو أضف جهازاً يدوياً.',
                  'Ouvrez l\'app BLASTI sur l\'écran ou le kiosque — il apparaîtra ici automatiquement.',
                  'Open the BLASTI app on the screen or kiosk — it appears here automatically, or add one manually.',
                  lang,
                )}
              </p>
              <Button size="sm" className="gap-1.5" onClick={() => openAdd('TV')}>
                <Plus className="h-4 w-4" />
                {getLocalizedString('إضافة جهاز', 'Ajouter un appareil', 'Add device', lang)}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {branchFilteredDevices.map((device) => (
              <ManagerDeviceCard
                key={device.id}
                device={device}
                lang={lang}
                busy={busyDeviceId === device.id}
                printers={registeredPrinters}
                onSetDefaultPrinter={(printerId) => handleSetKioskDefaultPrinter(device, printerId)}
                onQuickRefresh={() => sendCommand(device, 'REFRESH')}
                onPreview={() => setTvPreviewDevice(device)}
                onCast={() => handleCastRegistered(device)}
                onCredentials={() => openKioskCredentials(device)}
                onEdit={() => openEdit(device)}
                onPair={() => handlePair(device)}
                onUnpair={() => setConfirmState({ kind: 'unpair', device })}
                onCommand={(ct) => { setCommandDevice(device); setCommandType(ct); }}
                onToggleEnable={() => handleToggleEnable(device)}
                onDelete={() => setConfirmState({ kind: 'delete', device })}
              />
            ))}
          </div>
        )}

        {/* ── Dialogs ── */}
        <EditDeviceDialog
          open={formOpen} lang={lang} rtl={rtl} t={t} submitting={formSubmitting}
          editing={editingDevice} form={form} branches={branches}
          printers={registeredPrinters}
          onFormChange={(patch) => setForm((prev) => ({ ...prev, ...patch }))}
          onOpenChange={(o) => { setFormOpen(o); if (!o) setEditingDevice(null); }}
          onSubmit={submitForm}
          onPreviewTv={(device, layout) => window.open(buildTvUrl(device, layout), '_blank')}
        />

        <PairDeviceDialog
          open={!!pairingDevice} lang={lang} rtl={rtl}
          device={pairingDevice} pairingCode={pairingCode}
          pairingCodeCopied={pairingCodeCopied} pairingLoading={pairingLoading}
          pairingTimer={pairingTimer}
          onOpenChange={(o) => { if (!o) { setPairingDevice(null); setPairingCode(''); } }}
          onCopyPairingCode={() => copyText(pairingCode, getLocalizedString('تم نسخ الرمز', 'Code copié', 'Code copied', lang))}
        />

        <CommandDialog
          open={!!commandDevice} lang={lang} rtl={rtl}
          device={commandDevice} commandType={commandType} commandSending={commandSending}
          onOpenChange={(o) => { if (!o) setCommandDevice(null); }}
          onCommandTypeChange={setCommandType}
          onSend={handleSendCommand}
        />

        <ConfirmDialog
          open={!!confirmState} lang={lang} rtl={rtl}
          title={confirmState?.kind === 'delete'
            ? getLocalizedString('حذف الجهاز', 'Supprimer l\'appareil', 'Delete device', lang)
            : getLocalizedString('فك ربط الجهاز', 'Dissocier l\'appareil', 'Unpair device', lang)}
          message={confirmState?.kind === 'delete'
            ? getLocalizedString('سيُحذف الجهاز نهائياً من وكالتك. لا يمكن التراجع.', 'Cet appareil sera définitivement supprimé.', 'This device will be permanently removed from your agency.', lang)
            : getLocalizedString('سيتم فك ربط الجهاز وفصله فوراً. سيلزم إعادة الربط.', 'L\'appareil sera dissocié et devra être réappairé.', 'The device will be unpaired and disconnected immediately. It will need to be re-paired.', lang)}
          confirmLabel={confirmState?.kind === 'delete'
            ? getLocalizedString('حذف', 'Supprimer', 'Delete', lang)
            : getLocalizedString('فك الربط', 'Dissocier', 'Unpair', lang)}
          icon={confirmState?.kind === 'delete' ? 'trash' : 'unplug'}
          loading={confirmLoading}
          onOpenChange={(o) => { if (!o) setConfirmState(null); }}
          onConfirm={confirmState?.kind === 'delete' ? handleConfirmDelete : handleConfirmUnpair}
        />

        <KioskCredDialog
          open={!!kioskCredDevice} lang={lang} rtl={rtl}
          device={kioskCredDevice} loading={kioskCredLoading}
          pairingCode={kioskPairingCode} token={kioskToken}
          tokenVisible={kioskTokenVisible} copiedField={kioskCopied}
          onOpenChange={(o) => { if (!o) setKioskCredDevice(null); }}
          onTokenVisibleChange={setKioskTokenVisible}
          onCopyField={(text, field) => copyText(text, t('kioskCredentialsCopied'))}
          onRegenerate={handleRegenerateKioskCred}
        />

        <CreateKioskDialog
          open={createKioskOpen} lang={lang} rtl={rtl}
          loading={createKioskLoading}
          name={createKioskName} branchId={createKioskBranchId} branches={branches}
          result={createKioskResult}
          onOpenChange={(o) => { setCreateKioskOpen(o); if (!o) { setCreateKioskResult(null); setCreateKioskName(''); } }}
          onNameChange={setCreateKioskName}
          onBranchIdChange={setCreateKioskBranchId}
          onSubmit={handleCreateKiosk}
          onCopyField={(text) => copyText(text)}
        />

        <TvPreviewDialog
          open={!!tvPreviewDevice} lang={lang} rtl={rtl}
          device={tvPreviewDevice}
          boardUrl={tvPreviewDevice ? buildTvUrl(tvPreviewDevice) : genericTvUrl}
          designUrls={designPreviewUrls}
          onOpenChange={(o) => { if (!o) setTvPreviewDevice(null); }}
          onCopyUrl={(url) => copyText(url)}
        />

        <TvQrDialog
          open={tvQrOpen} lang={lang} rtl={rtl} url={lanTvUrl}
          onOpenChange={setTvQrOpen}
          onCopyUrl={() => copyText(lanTvUrl)}
        />
      </div>
    </TooltipProvider>
  );
}

// ─── Connected device card ──────────────────────────────────────────────────

function ManagerDeviceCard({
  device, lang, busy, printers, onSetDefaultPrinter,
  onQuickRefresh, onPreview, onCast, onCredentials, onEdit, onPair, onUnpair, onCommand,
  onToggleEnable, onDelete,
}: {
  device: AgencyDevice;
  lang: string;
  busy: boolean;
  /** 0.6.104 — agency's registered printers (per-kiosk default selector). */
  printers: AgencyDevice[];
  /** 0.6.104 — persist the kiosk default-printer assignment ('' = agency default). */
  onSetDefaultPrinter: (printerId: string) => void;
  onQuickRefresh: () => void;
  onPreview: () => void;
  /** 0.6.96 — direct board cast to a registered TV (CAST_URL command). */
  onCast?: () => void;
  onCredentials: () => void;
  onEdit: () => void;
  onPair: () => void;
  onUnpair: () => void;
  onCommand: (ct: CommandType) => void;
  onToggleEnable: () => void;
  onDelete: () => void;
}) {
  const { t } = useLanguage();
  const typeCfg = DEVICE_TYPE_CONFIG[device.type] ?? DEVICE_TYPE_CONFIG.APP;
  const statusCfg = STATUS_CONFIG[device.status];
  const Icon = typeCfg.icon;
  const isTvLike = device.type === 'TV' || device.type === 'DISPLAY';
  const isKiosk = device.type === 'KIOSK';
  const layoutCfg = SCREEN_LAYOUT_CONFIG[device.screenLayout];
  // 0.6.104 — kiosk default-printer assignment: current printer row (null
  // when unassigned → the kiosk uses the agency-level DefaultPrinter).
  const assignedPrinterId = isKiosk ? kioskAssignedPrinterId(device) : '';
  const assignedPrinter = assignedPrinterId ? printers.find((p) => p.id === assignedPrinterId) ?? null : null;
  const printerTag = `${t('dmKioskPrinterTag')}: ${
    assignedPrinter ? getLocalizedName(assignedPrinter, lang) : t('dmKioskPrinterAgencyDefault')
  }`;

  return (
    <motion.div layout initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
      <Card className={`h-full transition-shadow hover:shadow-md ${device.status === 'DISABLED' ? 'opacity-60' : ''}`}>
        <CardContent className="flex h-full flex-col gap-3 p-4">
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2.5 min-w-0">
              <div className={`p-2 rounded-lg shrink-0 ${typeCfg.color}`}>
                <Icon className="h-5 w-5" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-semibold">{getLocalizedName(device, lang)}</p>
                <p className="text-[11px] text-muted-foreground truncate">
                  {getLocalizedLabel(typeCfg, lang)}
                  {device.branch ? ` · ${device.branch.name}` : ''}
                </p>
              </div>
            </div>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" size="icon" className="h-8 w-8 shrink-0" aria-label="device actions">
                  <Settings className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem onClick={onEdit}>
                  <Settings className="h-4 w-4 me-2" />
                  {getLocalizedString('تعديل', 'Modifier', 'Edit', lang)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={onPair}>
                  <QrCode className="h-4 w-4 me-2" />
                  {getLocalizedString('رمز الربط', 'Code de jumelage', 'Pairing code', lang)}
                </DropdownMenuItem>
                {device.status !== 'DISABLED' ? (
                  <DropdownMenuItem onClick={onToggleEnable}>
                    <X className="h-4 w-4 me-2" />
                    {getLocalizedString('تعطيل', 'Désactiver', 'Disable', lang)}
                  </DropdownMenuItem>
                ) : (
                  <DropdownMenuItem onClick={onToggleEnable}>
                    <CheckCheck className="h-4 w-4 me-2" />
                    {getLocalizedString('تفعيل', 'Activer', 'Enable', lang)}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onCommand('REFRESH')}>
                  <RefreshCw className="h-4 w-4 me-2" />
                  {getLocalizedString('تحديث', 'Rafraîchir', 'Refresh', lang)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand('CLEAR_CACHE')}>
                  <RefreshCw className="h-4 w-4 me-2" />
                  {getLocalizedString('مسح الذاكرة', 'Vider le cache', 'Clear cache', lang)}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onCommand('REBOOT')} className="text-red-600 dark:text-red-400">
                  <Square className="h-4 w-4 me-2" />
                  {getLocalizedString('إعادة تشغيل', 'Redémarrer', 'Reboot', lang)}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                {device.pairingCode && (
                  <DropdownMenuItem onClick={onUnpair} className="text-orange-600 dark:text-orange-400">
                    <Unplug className="h-4 w-4 me-2" />
                    {getLocalizedString('فك الربط', 'Dissocier', 'Unpair', lang)}
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={onDelete} className="text-red-600 dark:text-red-400">
                  <Trash2 className="h-4 w-4 me-2" />
                  {getLocalizedString('حذف', 'Supprimer', 'Delete', lang)}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {/* Status + meta row */}
          <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
            <Badge variant="secondary" className={`gap-1 ${statusCfg.color}`}>
              <StatusDot status={device.status} />
              {getLocalizedLabel(statusCfg, lang)}
            </Badge>
            {device.ipAddress && (
              <span className="inline-flex items-center gap-1 rounded-md bg-muted px-1.5 py-0.5 font-mono" dir="ltr">
                {device.connectionType === 'WIFI' ? <Wifi className="h-3 w-3" /> : <Cable className="h-3 w-3" />}
                {device.ipAddress}
              </span>
            )}
            {isTvLike && layoutCfg?.isTvDesign && (
              <span className="inline-flex items-center gap-1 rounded-md bg-emerald-100 px-1.5 py-0.5 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                <MonitorPlay className="h-3 w-3" />
                {getLocalizedLabel(layoutCfg, lang)}
              </span>
            )}
            {/* 0.6.104 — current default-printer assignment on kiosk cards */}
            {isKiosk && (
              <span className="inline-flex items-center gap-1 rounded-md bg-sky-100 px-1.5 py-0.5 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400 max-w-full">
                <Printer className="h-3 w-3 shrink-0" />
                <span className="truncate">{printerTag}</span>
              </span>
            )}
          </div>

          {/* 0.6.104 — per-kiosk default printer (Fault: the kiosk must print
              on the printer registered/attached to its branch). Compact
              select over the agency's registered printers; "Agency default"
              clears the assignment so the agency-level DefaultPrinter wins. */}
          {isKiosk && (
            <div className="flex items-center gap-2">
              <span className="text-[11px] text-muted-foreground shrink-0">{t('dmKioskPrinterDefault')}</span>
              {printers.length === 0 ? (
                <span className="text-[11px] text-amber-600 dark:text-amber-400 truncate">{t('dmKioskPrinterNoRegistered')}</span>
              ) : (
                <Select
                  value={assignedPrinterId || 'agency-default'}
                  onValueChange={(v) => onSetDefaultPrinter(v === 'agency-default' ? '' : v)}
                  disabled={busy}
                >
                  <SelectTrigger className="h-7 flex-1 min-w-0 text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="agency-default">{t('dmKioskPrinterAgencyDefault')}</SelectItem>
                    {printers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {getLocalizedName(p, lang)} · {p.connectionType}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          )}

          <p className="text-[11px] text-muted-foreground mt-auto">
            {device.lastHeartbeatAt
              ? getLocalizedString('آخر ظهور', 'Dernière activité', 'Last seen', lang) + `: ${timeSince(device.lastHeartbeatAt)}`
              : getLocalizedString('لم يتصل بعد', 'Jamais connecté', 'Never connected', lang)}
          </p>

          {/* Quick actions */}
          <div className="flex items-center gap-1.5">
            <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" disabled={busy || device.status === 'OFFLINE'} onClick={onQuickRefresh}>
              {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
              {getLocalizedString('تحديث', 'Rafraîchir', 'Refresh', lang)}
            </Button>
            {isTvLike && (
              <>
                <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={onPreview}>
                  <ExternalLink className="h-3 w-3" />
                  {getLocalizedString('معاينة', 'Aperçu', 'Preview', lang)}
                </Button>
                {/* 0.6.96 — direct cast: the TV's BLASTI board app navigates to
                    the board (CAST_URL command) — no browser, no Chromecast tab. */}
                {onCast && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 flex-1 gap-1 text-xs border-cyan-300/60 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-900/50 dark:text-cyan-400 dark:hover:bg-cyan-950/30"
                    disabled={busy}
                    onClick={onCast}
                  >
                    {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Cast className="h-3 w-3" />}
                    {getLocalizedString('بث', 'Diffuser', 'Cast', lang)}
                  </Button>
                )}
              </>
            )}
            {isKiosk && (
              <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={onCredentials}>
                <QrCode className="h-3 w-3" />
                {getLocalizedString('بيانات الدخول', 'Identifiants', 'Credentials', lang)}
              </Button>
            )}
            {!device.pairingCode && (
              <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={onPair}>
                <QrCode className="h-3 w-3" />
                {getLocalizedString('ربط', 'Associer', 'Pair', lang)}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ─── Discovered (unregistered) device card ──────────────────────────────────

/** Icon per discovered type (DEVICE_TYPE_CONFIG icons are injected lazily). */
function DiscoveredTypeIcon({ device }: { device: RealDiscoveredDevice }) {
  const cfg = device.type !== 'UNKNOWN' ? DEVICE_TYPE_CONFIG[device.type as keyof typeof DEVICE_TYPE_CONFIG] : null;
  if (cfg && cfg.icon) {
    const Icon = cfg.icon;
    return <Icon className="h-4 w-4" />;
  }
  if (device.connectionType === 'USB') return <Usb className="h-4 w-4" />;
  return <RadioTower className="h-4 w-4" />;
}

function DiscoveredCard({
  device, lang, busy, tvSaved, isDefaultPrinter,
  connecting, connectVerified, printingTest, pairRequested,
  registeredPeripheral, savedAsDevice,
  onSaveTv, onCast, onPair, onSavePrinter, onSavePrinterAsDevice, onRegisterPeripheral, onTestPrinter, onPrintTest, onConnect, onDismiss,
}: {
  device: RealDiscoveredDevice;
  lang: string;
  busy: boolean;
  tvSaved: boolean;
  isDefaultPrinter: boolean;
  connecting: boolean;
  connectVerified: 'verified' | 'failed' | undefined;
  printingTest: boolean;
  /** 0.6.96 — pairing request already sent from this card. */
  pairRequested?: boolean;
  /** 0.6.100 — this USB peripheral printer is already registered. */
  registeredPeripheral?: boolean;
  /** 0.6.105 — this printer already exists as a registered PRINTER device. */
  savedAsDevice?: boolean;
  onSaveTv: () => void;
  onCast: () => void;
  /** 0.6.96 — request pairing from a discovered BLASTI card. */
  onPair: () => void;
  onSavePrinter: () => void;
  /** 0.6.105 — save the printer as a real connected PRINTER device row. */
  onSavePrinterAsDevice: () => void;
  /** 0.6.100 — register a host-attached USB printer as a shared branch printer. */
  onRegisterPeripheral: () => void;
  onTestPrinter: () => void;
  onPrintTest: () => void;
  onConnect: () => void;
  onDismiss: () => void;
}) {
  const isTv = device.type === 'TV';
  const isPrinter = device.type === 'PRINTER';
  const isPeripheralPrinter = isPrinter && device.source === 'peripheral-report';
  // 0.6.101 — a printer card at 127.0.0.1 is attached to THIS PC (the scan's
  // Phase-5 local enumeration). Show it like a peripheral, not a loopback IP.
  const isLocalPrinter = isPrinter && device.ip === '127.0.0.1';
  const isConnectable = !!device.ip && (device.port ?? 0) > 0 && device.connectionType !== 'USB'
    // 0.6.92 — ROUTER removed: the gateway is never a connectable peer.
    // PORT > 0 required: a BLASTI phone announcing itself via the UDP pairing
    // beacon has NO http server to probe (port 0) — it pairs through the
    // pairing-request flow, not the connect probe.
    && ['PC', 'APP', 'KIOSK', 'PHONE', 'IOT', 'UNKNOWN'].includes(device.type);
  const sourceCfg = DISCOVERY_SOURCE_CONFIG[device.source];
  const SourceIcon = sourceCfg?.icon ?? RadioTower;
  const typeCfg = device.type !== 'UNKNOWN' ? DEVICE_TYPE_CONFIG[device.type as keyof typeof DEVICE_TYPE_CONFIG] : null;
  const confidence = typeof device.confidence === 'number' ? device.confidence : undefined;
  const isBlasti = device.category === 'BLASTI';

  return (
    <div className={`flex items-center gap-2.5 rounded-xl border bg-background px-3 py-2.5 ${isBlasti ? 'border-emerald-300/60 dark:border-emerald-900/50' : ''}`}>
      <div className={`p-2 rounded-lg shrink-0 ${typeCfg?.color ?? sourceCfg?.color ?? 'bg-muted'}`}>
        <DiscoveredTypeIcon device={device} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 min-w-0">
          <p className="truncate text-sm font-medium">{device.name}</p>
          {device.cached && device.status !== 'ONLINE' && (
            <span className="shrink-0 rounded-full bg-muted px-1.5 py-px text-[9px] text-muted-foreground">
              {getLocalizedString('سابق', 'cache', 'cached', lang)}
            </span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-wrap text-[11px] text-muted-foreground">
          <span className="truncate" dir="ltr">
            {isLocalPrinter
              ? getLocalizedString('موصولة بهذا الحاسوب', 'Attaché à ce PC', 'Attached to this PC', lang)
              : device.ip
                ? `${device.ip}${device.port ? `:${device.port}` : ''}`
                : (device.cupsName || 'USB')}
          </span>
          {/* 0.6.86 — ALWAYS surface a type chip (even UNKNOWN) so every scan
              result answers "is this a computer / phone / printer?". The
              classifier now types bare hosts via TTL + hostname heuristics. */}
          <span className={`rounded-full px-1.5 py-px text-[9px] ${typeCfg?.color ?? 'bg-muted text-muted-foreground'}`}>
            {typeCfg
              ? getLocalizedLabel(typeCfg, lang)
              : getLocalizedString('جهاز', 'Appareil', 'Device', lang)}
          </span>
          {/* 0.6.86 — manufacturer/model line (HP · LaserJet M404 …) */}
          {(device.manufacturer || device.model) && (
            <span className="truncate max-w-[180px]" dir="ltr">
              {device.manufacturer}{device.manufacturer && device.model ? ' · ' : ''}{device.model}
            </span>
          )}
          {/* 0.6.102 — STRICT result-filter chips (audit requirement). The
              manager's discovery results are exactly: PC WITH BLASTI DESKTOP
              APP · PHONE WITH BLASTI APP · PHONE/TABLET WITH BLASTI APP IN
              KIOSK MODE · printers/TVs. The announcing surface decides the
              chip; a generic type chip alone could not separate a kiosk-mode
              tablet from a staff phone (both arrive as 'blasti-phone'). */}
          {isBlasti && device.blastiMode === 'kiosk' && (
            <span className="rounded-full bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400 px-1.5 py-px text-[9px]">
              {getLocalizedString('هاتف/لوحي — وضع الكيوسك', 'Téléphone/Tablette — Mode kiosque', 'Phone/Tablet — BLASTI Kiosk Mode', lang)}
            </span>
          )}
          {isBlasti && device.blastiMode === 'desktop' && (
            <span className="rounded-full bg-violet-100 text-violet-700 dark:bg-violet-950/40 dark:text-violet-400 px-1.5 py-px text-[9px]">
              {getLocalizedString('حاسوب — تطبيق بلاستي', 'PC — App BLASTI', 'PC — BLASTI Desktop App', lang)}
            </span>
          )}
          {isBlasti && device.blastiMode === 'phone' && (
            <span className="rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950/40 dark:text-rose-400 px-1.5 py-px text-[9px]">
              {getLocalizedString('هاتف — تطبيق بلاستي', 'Téléphone — App BLASTI', 'Phone — BLASTI App', lang)}
            </span>
          )}
          {/* 0.6.96 — self-announced platform chip (the app SHARED this info) */}
          {device.platform && (
            <span className="rounded-full bg-muted px-1.5 py-px text-[9px] uppercase" dir="ltr">
              {device.platform}
            </span>
          )}
          {/* 0.6.100 — CASCADE PERIPHERAL chip: this printer hangs off another PC */}
          {isPeripheralPrinter && (
            <span className="rounded-full bg-sky-100 text-sky-700 dark:bg-sky-950/40 dark:text-sky-400 px-1.5 py-px text-[9px]" dir="ltr">
              USB · {getLocalizedString('عبر', 'via', 'via', lang)} {device.hostName || device.hostIp || device.ip}
            </span>
          )}
          {typeof confidence === 'number' && (
            <span className={`rounded-full px-1.5 py-px text-[9px] ${
              confidence >= 85
                ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                : confidence >= 60
                  ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'
                  : 'bg-muted text-muted-foreground'
            }`}>
              {confidence}%
            </span>
          )}
          {' · '}
          <SourceIcon className="inline h-3 w-3" /> {sourceCfg?.labelEn ?? device.source}
          {isDefaultPrinter ? ` · ${getLocalizedString('افتراضية', 'défaut', 'default', lang)}` : ''}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 flex-wrap justify-end">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
        {/* 0.6.96 — PAIRING REQUEST BUTTON on discovery results: every active
            BLASTI app card (desktop / kiosk / phone beacon) gets a one-click
            pairing request — no more "visible but unpairable" beacon cards.
            0.6.103 — PRINTERS are excluded: a printer does not run the BLASTI
            app and can never accept a pairing request; linking a printer means
            saving it as the branch default or registering it as a shared
            peripheral, NOT pairing. The old Pair button on printer cards sent
            requests no printer could answer ("الطابعة لا يمكن ربطها"). */}
        {isBlasti && device.type !== 'TV' && device.type !== 'PRINTER' && (
          <Button
            variant="outline"
            size="sm"
            className={`h-7 gap-1 text-xs ${pairRequested ? 'border-emerald-300 text-emerald-700 dark:text-emerald-400' : 'border-emerald-300/60 text-emerald-700 hover:bg-emerald-50 dark:border-emerald-900/50 dark:text-emerald-400 dark:hover:bg-emerald-950/30'}`}
            disabled={busy || pairRequested}
            onClick={onPair}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
            {pairRequested
              ? getLocalizedString('أُرسل الطلب', 'Envoyé', 'Sent', lang)
              : getLocalizedString('طلب ربط', 'Associer', 'Pair', lang)}
          </Button>
        )}
        {isTv && (
          <>
            {!tvSaved && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onSaveTv}>
                {getLocalizedString('حفظ', 'Enregistrer', 'Save', lang)}
              </Button>
            )}
            <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onCast}>
              <Cast className="h-3 w-3" />
              {getLocalizedString('بث', 'Diffuser', 'Cast', lang)}
            </Button>
          </>
        )}
        {isPrinter && (
          <>
            {/* 0.6.100 — REGISTER a host-attached USB printer (shared printing) */}
            {isPeripheralPrinter && !registeredPeripheral && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs border-sky-300/60 text-sky-700 hover:bg-sky-50 dark:border-sky-900/50 dark:text-sky-400 dark:hover:bg-sky-950/30"
                onClick={onRegisterPeripheral}
              >
                <Usb className="h-3 w-3" />
                {getLocalizedString('تسجيل', 'Enregistrer', 'Register', lang)}
              </Button>
            )}
            {registeredPeripheral && (
              <span className="rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 px-1.5 py-px text-[9px]">
                {getLocalizedString('مسجّلة ✓', 'Enregistrée ✓', 'Registered ✓', lang)}
              </span>
            )}
            {/* 0.6.105 — SAVE AS CONNECTED DEVICE: every printer card (local
                USB, network or peripheral-report) can now be saved as a real
                PRINTER device row. This is what feeds the agency's registered
                printer list — and therefore the per-kiosk "Default printer"
                selector on the kiosk cards below. */}
            {!isPeripheralPrinter && !savedAsDevice && (
              <Button
                variant="outline"
                size="sm"
                className="h-7 gap-1 text-xs border-amber-300/60 text-amber-700 hover:bg-amber-50 dark:border-amber-900/50 dark:text-amber-400 dark:hover:bg-amber-950/30"
                disabled={busy}
                onClick={onSavePrinterAsDevice}
              >
                <Printer className="h-3 w-3" />
                {getLocalizedString('حفظ كجهاز', 'Enregistrer l\'appareil', 'Save as device', lang)}
              </Button>
            )}
            {savedAsDevice && !isPeripheralPrinter && (
              <span className="rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 px-1.5 py-px text-[9px]">
                {getLocalizedString('محفوظة كجهاز ✓', 'Appareil ✓', 'Saved as device ✓', lang)}
              </span>
            )}
            {!isPeripheralPrinter && !isDefaultPrinter && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onSavePrinter}>
                {getLocalizedString('تعيين', 'Définir', 'Set', lang)}
              </Button>
            )}
            {!isPeripheralPrinter && (
              <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onTestPrinter}>
                {getLocalizedString('اختبار', 'Tester', 'Test', lang)}
              </Button>
            )}
            {!isPeripheralPrinter && (device.ip || device.cupsName) && (
              <Button variant="outline" size="sm" className="h-7 gap-1 text-xs" onClick={onPrintTest} disabled={printingTest} title={isLocalPrinter ? 'OS print service' : 'ESC/POS'}>
                {printingTest ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                {getLocalizedString('صفحة اختبار', 'page test', 'test page', lang)}
              </Button>
            )}
          </>
        )}
        {isConnectable && (
          <Button
            variant="outline"
            size="sm"
            className={`h-7 gap-1 text-xs ${connectVerified === 'verified' ? 'border-emerald-300 text-emerald-700 dark:text-emerald-400' : connectVerified === 'failed' ? 'border-red-200 text-red-600' : ''}`}
            onClick={onConnect}
            disabled={connecting}
          >
            {connecting ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plug className="h-3 w-3" />}
            {connectVerified === 'verified'
              ? getLocalizedString('متصل', 'Connecté', 'Connected', lang)
              : connectVerified === 'failed'
                ? getLocalizedString('غير متاح', 'Injoignable', 'Unreachable', lang)
                : getLocalizedString('اتصال', 'Connecter', 'Connect', lang)}
          </Button>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDismiss} aria-label="dismiss">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
