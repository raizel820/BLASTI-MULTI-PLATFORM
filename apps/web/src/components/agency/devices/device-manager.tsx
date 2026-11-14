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
import { useAppStore } from '@/store/use-app-store';
import { useRealtime } from '@/hooks/use-realtime';
import { apiFetch } from '@/lib/api-fetch';
import { unwrapListPayload } from '@/lib/list-payload';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuContent,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { motion } from 'framer-motion';
import {
  Monitor, RefreshCw, Copy, Radio, QrCode, Cast, Cable, ExternalLink,
  Loader2, Tv, Printer, Plus, Settings, Square, CheckCheck, Wifi,
  AlertTriangle, RadioTower, Usb, X, Search, MonitorPlay, Trash2, Unplug,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDiscoveryService } from '@/hooks/use-discovery-service';

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
}

const EMPTY_FORM: DeviceFormState = {
  name: '', nameAr: '', nameFr: '',
  type: 'TV', connectionType: 'LAN',
  ipAddress: '', port: '',
  autoDiscovery: true, screenLayout: 'TV_CLASSIC',
  branchId: '', serviceFilter: '',
  status: 'OFFLINE', displaySettings: {},
};

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

  const [savedTvIps, setSavedTvIps] = useState<Set<string>>(new Set());
  const [defaultPrinterIp, setDefaultPrinterIp] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);

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

  // Unpaired polling (10s)
  useEffect(() => {
    if (!agencyId) return;
    const interval = setInterval(fetchUnpaired, 10_000);
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
  const onlineCount = devices.filter((d) => d.status === 'ONLINE').length;
  const needsAttention = devices.filter((d) => d.status === 'OFFLINE' || d.status === 'DISABLED').length;
  const visibleDiscovered = useMemo(
    () => discoveredDevices.filter((d) => !dismissedIds.has(d.id) && d.ip !== '127.0.0.1'),
    [discoveredDevices, dismissedIds],
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
          mediaUrl: genericTvUrl,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.castKind === 'url') {
          if (data.tvBoardUrl) window.open(data.tvBoardUrl, '_blank');
          toast.info(getLocalizedString(
            'تعذر البث المباشر — افتح الرابط في متصفح التلفاز',
            'Diffusion directe impossible — ouvrez le lien sur la TV',
            'Direct cast unavailable — open the link on the TV browser',
            lang,
          ));
        } else {
          toast.success(getLocalizedString('تم البث بنجاح', 'Diffusion réussie', 'Cast successful', lang));
        }
      } else {
        toast.error(data.error || getLocalizedString('فشل البث', 'Échec de la diffusion', 'Cast failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء البث', 'Erreur de diffusion', 'Error casting', lang));
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

  const handleTestPrinter = async (device: RealDiscoveredDevice) => {
    setBusyDeviceId(device.id);
    try {
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

  const handleSendPairingRequest = async (deviceId: string) => {
    setBusyDeviceId(deviceId);
    try {
      const res = await apiFetch(`${API_BASE}/${deviceId}/pairing-request`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم إرسال طلب الربط', 'Demande de jumelage envoyée', 'Pairing request sent', lang));
        setUnpairedDevices((prev) => prev.filter((d) => d.id !== deviceId));
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString('فشل إرسال الطلب', "Échec de l'envoi", 'Request failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally { setBusyDeviceId(null); }
  };

  // ─── Handlers: cast menu ─────────────────────────────────────────────────
  const handleChromecast = useCallback(async () => {
    const nav = navigator as unknown as { presentation?: { request: (url: string, opts?: unknown) => { start: () => Promise<void>; onend?: () => void } } };
    if (!nav.presentation?.request) {
      toast.error(getLocalizedString(
        'المتصفح لا يدعم البث — استخدم Chrome أو Edge',
        'Navigateur incompatible — utilisez Chrome ou Edge',
        'Browser does not support casting — use Chrome/Edge',
        lang,
      ));
      return;
    }
    try {
      const request = nav.presentation.request(genericTvUrl, { id: 'blasti-tv-board' });
      await request.start();
      toast.success(getLocalizedString('تم بدء البث', 'Diffusion démarrée', 'Casting started', lang));
    } catch {
      toast.info(getLocalizedString('تم إلغاء البث', 'Diffusion annulée', 'Cast cancelled', lang));
    }
  }, [genericTvUrl, lang]);

  const handleHdmi = useCallback(() => {
    const electronApi = (window as unknown as { electronAPI?: { openTvScreen?: (o: { url: string }) => void } }).electronAPI;
    if (electronApi?.openTvScreen) {
      electronApi.openTvScreen({ url: genericTvUrl });
      toast.success(getLocalizedString('تم فتح الشاشة على HDMI', 'Écran ouvert sur HDMI', 'Screen opened on HDMI', lang));
    } else {
      navigator.clipboard.writeText(genericTvUrl).then(() => {
        toast.info(getLocalizedString('تم نسخ الرابط — افتحه في تطبيق سطح المكتب', 'Lien copié — ouvrez-le dans l\'app desktop', 'URL copied — open in the desktop app', lang));
      });
    }
  }, [genericTvUrl, lang]);

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
              {/* Cast menu */}
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="sm" className="gap-1.5 bg-gradient-to-r from-cyan-500 to-teal-500 hover:from-cyan-600 hover:to-teal-600 text-white shadow-md">
                    <Cast className="h-4 w-4" />
                    {getLocalizedString('بث إلى شاشة', 'Diffuser', 'Cast', lang)}
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="w-64">
                  <DropdownMenuLabel>{getLocalizedString('خيارات البث', 'Options de diffusion', 'Cast options', lang)}</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => window.open(genericTvUrl, '_blank')}>
                    <ExternalLink className="h-4 w-4 me-2" />
                    <div>
                      <div>{getLocalizedString('فتح في متصفح التلفاز', 'Ouvrir dans le navigateur TV', 'Open in TV browser', lang)}</div>
                      <div className="text-xs text-muted-foreground">{getLocalizedString('للشاشات الذكية', 'Pour Smart TV', 'For smart TVs', lang)}</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleChromecast}>
                    <Cast className="h-4 w-4 me-2" />
                    <div>
                      <div>{getLocalizedString('بث Google Cast', 'Diffuser via Google Cast', 'Google Cast', lang)}</div>
                      <div className="text-xs text-muted-foreground">Chromecast / Android TV</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={handleHdmi}>
                    <Cable className="h-4 w-4 me-2" />
                    <div>
                      <div>{getLocalizedString('شاشة HDMI', 'Écran HDMI', 'HDMI screen', lang)}</div>
                      <div className="text-xs text-muted-foreground">{getLocalizedString('أي شاشة عبر سطح المكتب', 'Tout écran via le desktop', 'Any screen via desktop app', lang)}</div>
                    </div>
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => copyText(genericTvUrl)}>
                    <Copy className="h-4 w-4 me-2" />
                    {getLocalizedString('نسخ رابط الشاشة', 'Copier le lien', 'Copy screen URL', lang)}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setTvQrOpen(true)}>
                    <QrCode className="h-4 w-4 me-2" />
                    {getLocalizedString('عرض رمز QR', 'Afficher le QR', 'Show QR code', lang)}
                  </DropdownMenuItem>
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
        </motion.div>

        {/* ── Branch PCs / LAN master ── */}
        <LanMasterCard agencyId={agencyId} lang={lang} />

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
                      {t(getScanPhaseLabelKey(scanState.phase))}
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
                        onSaveTv={() => handleSaveTv(d)}
                        onCast={() => handleCastTv(d)}
                        onSavePrinter={() => handleSavePrinter(d)}
                        onTestPrinter={() => handleTestPrinter(d)}
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
        ) : filteredDevices.length === 0 ? (
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
            {filteredDevices.map((device) => (
              <ManagerDeviceCard
                key={device.id}
                device={device}
                lang={lang}
                busy={busyDeviceId === device.id}
                onQuickRefresh={() => sendCommand(device, 'REFRESH')}
                onPreview={() => setTvPreviewDevice(device)}
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
          open={tvQrOpen} lang={lang} rtl={rtl} url={genericTvUrl}
          onOpenChange={setTvQrOpen}
          onCopyUrl={() => copyText(genericTvUrl)}
        />
      </div>
    </TooltipProvider>
  );
}

// ─── Connected device card ──────────────────────────────────────────────────

function ManagerDeviceCard({
  device, lang, busy,
  onQuickRefresh, onPreview, onCredentials, onEdit, onPair, onUnpair, onCommand,
  onToggleEnable, onDelete,
}: {
  device: AgencyDevice;
  lang: string;
  busy: boolean;
  onQuickRefresh: () => void;
  onPreview: () => void;
  onCredentials: () => void;
  onEdit: () => void;
  onPair: () => void;
  onUnpair: () => void;
  onCommand: (ct: CommandType) => void;
  onToggleEnable: () => void;
  onDelete: () => void;
}) {
  const typeCfg = DEVICE_TYPE_CONFIG[device.type] ?? DEVICE_TYPE_CONFIG.APP;
  const statusCfg = STATUS_CONFIG[device.status];
  const Icon = typeCfg.icon;
  const isTvLike = device.type === 'TV' || device.type === 'DISPLAY';
  const isKiosk = device.type === 'KIOSK';
  const layoutCfg = SCREEN_LAYOUT_CONFIG[device.screenLayout];

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
          </div>

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
              <Button variant="outline" size="sm" className="h-7 flex-1 gap-1 text-xs" onClick={onPreview}>
                <ExternalLink className="h-3 w-3" />
                {getLocalizedString('معاينة', 'Aperçu', 'Preview', lang)}
              </Button>
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

function DiscoveredCard({
  device, lang, busy, tvSaved, isDefaultPrinter,
  onSaveTv, onCast, onSavePrinter, onTestPrinter, onDismiss,
}: {
  device: RealDiscoveredDevice;
  lang: string;
  busy: boolean;
  tvSaved: boolean;
  isDefaultPrinter: boolean;
  onSaveTv: () => void;
  onCast: () => void;
  onSavePrinter: () => void;
  onTestPrinter: () => void;
  onDismiss: () => void;
}) {
  const isTv = device.type === 'TV';
  const isPrinter = device.type === 'PRINTER';
  const sourceCfg = DISCOVERY_SOURCE_CONFIG[device.source];
  const SourceIcon = sourceCfg?.icon ?? RadioTower;

  return (
    <div className="flex items-center gap-2.5 rounded-xl border bg-background px-3 py-2.5">
      <div className={`p-2 rounded-lg shrink-0 ${sourceCfg?.color ?? 'bg-muted'}`}>
        {isPrinter ? <Printer className="h-4 w-4" /> : isTv ? <Tv className="h-4 w-4" /> : device.connectionType === 'USB' ? <Usb className="h-4 w-4" /> : <RadioTower className="h-4 w-4" />}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{device.name}</p>
        <p className="text-[11px] text-muted-foreground truncate" dir="ltr">
          {device.ip ? `${device.ip}${device.port ? `:${device.port}` : ''}` : (device.cupsName || 'USB')}
          {' · '}
          <SourceIcon className="inline h-3 w-3" /> {sourceCfg?.labelEn ?? device.source}
          {isDefaultPrinter ? ` · ${getLocalizedString('افتراضية', 'défaut', 'default', lang)}` : ''}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {busy && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
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
            {!isDefaultPrinter && (
              <Button variant="outline" size="sm" className="h-7 text-xs" onClick={onSavePrinter}>
                {getLocalizedString('تعيين', 'Définir', 'Set', lang)}
              </Button>
            )}
            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={onTestPrinter}>
              {getLocalizedString('اختبار', 'Tester', 'Test', lang)}
            </Button>
          </>
        )}
        <Button variant="ghost" size="icon" className="h-7 w-7" onClick={onDismiss} aria-label="dismiss">
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}
