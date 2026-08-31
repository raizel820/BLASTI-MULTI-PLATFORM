'use client'
import { apiFetch } from '@/lib/api-fetch';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';
import { useAppStore } from '@/store/use-app-store';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { TooltipProvider } from '@/components/ui/tooltip';
import { motion } from 'framer-motion';
import {
  Monitor,
  RefreshCw,
  Copy,
  Radio,
  QrCode,
  Cast,
  Cable,
  Settings,
  ExternalLink,
  Unplug,
  Loader2,
} from 'lucide-react';
import { toast } from 'sonner';
import { useDiscoveryService, useDiscoveryAutoScan } from '@/hooks/use-discovery-service';

// ─── Sub-components ───────────────────────────────────────────────────────
import { initDeviceTypeIcons } from './devices/types';
import {
  type AgencyDevice,
  type RealDiscoveredDevice,
  type Branch,
  type DeviceType,
  type DeviceStatus,
  type ConnectionType,
  type CommandType,
  type ScreenLayout,
  type DisplaySettings,
  API_BASE,
  PORT_Q,
  PAIRING_EXPIRE_MS,
  DEVICE_TYPE_CONFIG,
  fadeUp,
  getLocalizedString,
  getLocalizedName,
} from './devices/types';

import { NetworkDiscoveryPanel } from './devices/network-discovery-panel';
import { DeviceGrid } from './devices/device-card';
import { DeviceDetailSheet } from './devices/device-detail-sheet';
import {
  EditDeviceDialog,
  PairDeviceDialog,
  CommandDialog,
  DeleteConfirmDialog,
  RebootConfirmDialog,
  KioskCredentialsDialog,
  CreateKioskDialog,
  TvPreviewDialog,
  TvQrDialog,
} from './devices/device-dialogs';

// Initialize lucide icons in type config
initDeviceTypeIcons();

// ─── Main Component ─────────────────────────────────────────────────────────

export function AgencyDevices() {
  const { user } = useAppStore();
  const { t, lang } = useLanguage();
  const realtime = useRealtime();
  const agencyId = user?.agencyId;
  const rtl = isRTL(lang);

  // ─── State ──────────────────────────────────────────────────────────────
  const [devices, setDevices] = useState<AgencyDevice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [testingPrinterId, setTestingPrinterId] = useState<string | null>(null);
  const [printerTestResult, setPrinterTestResult] = useState<Record<string, 'online' | 'offline' | 'error'>>({});

  // ─── Discovery Service (new) ───────────────────────────────────────────
  const { scanState, discoveredDevices: realDiscoveredDevices, serviceAvailable: discoveryServiceAvailable, startScan: discoveryStartScan, stopScan: discoveryStopScan, protocols } = useDiscoveryService(agencyId);
  const { autoScanEnabled: v2AutoScan, setAutoScanEnabled: setDiscoveryAutoScan } = useDiscoveryAutoScan();
  const [dismissedDiscoveryIds, setDismissedDiscoveryIds] = useState<Set<string>>(new Set());

  // Filter out dismissed devices (defined after fetchDevices to avoid circular ref)
  // We'll define discoveredDevices memo after fetchDevices is declared

  const handleDismissDiscoveryDevice = useCallback((deviceId: string) => {
    setDismissedDiscoveryIds((prev) => new Set(prev).add(deviceId));
  }, []);

  // ─── Unpaired Devices (waiting for discovery) ───────────────────────────
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
    statusChangedAt?: string | null;
    createdAt: string;
  }

  const [unpairedDevices, setUnpairedDevices] = useState<UnpairedDevice[]>([]);
  const [pairingRequestId, setPairingRequestId] = useState<string | null>(null);

  // Dialogs
  const [editDialogOpen, setEditDialogOpen] = useState(false);
  const [pairDialogOpen, setPairDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [commandDialogOpen, setCommandDialogOpen] = useState(false);
  const [rebootConfirmOpen, setRebootConfirmOpen] = useState(false);
  const [kioskCredDialogOpen, setKioskCredDialogOpen] = useState(false);
  const [kioskCredDevice, setKioskCredDevice] = useState<AgencyDevice | null>(null);
  const [kioskCredLoading, setKioskCredLoading] = useState(false);
  const [kioskCredPairingCode, setKioskCredPairingCode] = useState('');
  const [kioskCredToken, setKioskCredToken] = useState('');
  const [kioskCredTokenVisible, setKioskCredTokenVisible] = useState(false);
  const [kioskCredCopied, setKioskCredCopied] = useState<string | null>(null);

  // TV Preview dialog
  const [tvPreviewOpen, setTvPreviewOpen] = useState(false);
  const [tvPreviewDevice, setTvPreviewDevice] = useState<AgencyDevice | null>(null);
  const [tvUrlCopied, setTvUrlCopied] = useState(false);
  const [tvQrDialogOpen, setTvQrDialogOpen] = useState(false);

  // Create Kiosk Credentials dialog
  const [createKioskDialogOpen, setCreateKioskDialogOpen] = useState(false);
  const [createKioskLoading, setCreateKioskLoading] = useState(false);
  const [createKioskName, setCreateKioskName] = useState('');
  const [createKioskNameAr, setCreateKioskNameAr] = useState('');
  const [createKioskNameFr, setCreateKioskNameFr] = useState('');
  const [createKioskBranchId, setCreateKioskBranchId] = useState('');
  const [createKioskResult, setCreateKioskResult] = useState<{ pairingCode: string; deviceToken: string; deviceName: string } | null>(null);
  const [createKioskResultVisible, setCreateKioskResultVisible] = useState(false);
  const [createKioskResultCopied, setCreateKioskResultCopied] = useState<string | null>(null);

  // Detail sheet
  const [detailDeviceId, setDetailDeviceId] = useState<string | null>(null);
  const detailDevice = devices.find((d) => d.id === detailDeviceId) ?? null;
  const [tokenRevealed, setTokenRevealed] = useState(false);

  // Form state - Add/Edit
  const [formName, setFormName] = useState('');
  const [formNameAr, setFormNameAr] = useState('');
  const [formNameFr, setFormNameFr] = useState('');
  const [formType, setFormType] = useState<DeviceType>('TV');
  const [formConnectionType, setFormConnectionType] = useState<ConnectionType>('LAN');
  const [formIpAddress, setFormIpAddress] = useState('');
  const [formPort, setFormPort] = useState('');
  const [formAutoDiscovery, setFormAutoDiscovery] = useState(true);
  const [formScreenLayout, setFormScreenLayout] = useState<ScreenLayout>('QUEUE_BOARD');
  const [formBranchId, setFormBranchId] = useState<string>('');
  const [formServiceFilter, setFormServiceFilter] = useState('');
  const [formSubmitting, setFormSubmitting] = useState(false);

  // Edit-specific form state
  const [editingDevice, setEditingDevice] = useState<AgencyDevice | null>(null);
  const [formStatus, setFormStatus] = useState<DeviceStatus>('OFFLINE');
  const [formDisplaySettings, setFormDisplaySettings] = useState<DisplaySettings>({});

  // Pair state
  const [pairingDevice, setPairingDevice] = useState<AgencyDevice | null>(null);
  const [pairingCode, setPairingCode] = useState('');
  const [pairingLoading, setPairingLoading] = useState(false);
  const [pairingCodeCopied, setPairingCodeCopied] = useState(false);
  const [pairingTimer, setPairingTimer] = useState(PAIRING_EXPIRE_MS);

  // Delete state
  const [deletingDevice, setDeletingDevice] = useState<AgencyDevice | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);

  // Unpair state
  const [unpairDevice, setUnpairDevice] = useState<AgencyDevice | null>(null);
  const [unpairLoading, setUnpairLoading] = useState(false);
  const [unpairDialogOpen, setUnpairDialogOpen] = useState(false);

  // Command state
  const [commandDevice, setCommandDevice] = useState<AgencyDevice | null>(null);
  const [commandType, setCommandType] = useState<CommandType>('REFRESH');
  const [commandPayload, setCommandPayload] = useState('');
  const [commandSending, setCommandSending] = useState(false);

  // Token display after creation (used by Create Kiosk dialog)
  const [createdToken, setCreatedToken] = useState<string | null>(null);
  const [createdPairingCode, setCreatedPairingCode] = useState<string | null>(null);
  const [tokenRevealedForAdd, setTokenRevealedForAdd] = useState(false);

  // Branches for selector
  const [branches, setBranches] = useState<Branch[]>([]);

  // Refs for cleanup
  const fetchDevicesTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // ─── Data Fetching ──────────────────────────────────────────────────────

  const fetchDevices = useCallback(async (silent = false) => {
    if (!agencyId) return;
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await apiFetch(API_BASE);
      if (!res.ok) throw new Error('Failed to load devices');
      const data = await res.json();
      if (data.success) {
        setDevices(data.devices ?? []);
      } else {
        throw new Error(data.error || 'Unknown error');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'An error occurred');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [agencyId]);

  const fetchBranches = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency/branches?agencyId=${agencyId}&${PORT_Q}`);
      if (res.ok) {
        const data = await res.json();
        setBranches(data.branches ?? []);
      }
    } catch {
      // Silent
    }
  }, [agencyId]);

  useEffect(() => {
    fetchDevices();
    fetchBranches();
  }, [fetchDevices, fetchBranches]);

  // Debounced fetch for realtime events
  const fetchDevicesDebounced = useCallback(() => {
    if (!agencyId) return;
    if (fetchDevicesTimerRef.current) clearTimeout(fetchDevicesTimerRef.current);
    fetchDevicesTimerRef.current = setTimeout(() => {
      fetchDevices(true);
    }, 500);
  }, [agencyId, fetchDevices]);

  // Realtime subscriptions
  useEffect(() => {
    if (!agencyId) return;
    const unsubRegistered = realtime.subscribe('device:registered', () => {
      fetchDevicesDebounced();
      toast.info(getLocalizedString('تم تسجيل جهاز جديد', 'Nouvel appareil enregistré', 'New device registered', lang));
    });
    const unsubStatusChanged = realtime.subscribe('device:status-changed', () => {
      fetchDevicesDebounced();
    });
    const unsubOnline = realtime.subscribe('device:online', () => {
      fetchDevicesDebounced();
    });
    const unsubDeviceConnected = realtime.subscribe('agency-device:connected', () => {
      fetchDevicesDebounced();
    });
    return () => {
      unsubRegistered();
      unsubStatusChanged();
      unsubOnline();
      unsubDeviceConnected();
    };
  }, [agencyId, fetchDevicesDebounced, realtime, lang]);

  // Fetch unpaired devices (waiting for discovery) every 10 seconds
  useEffect(() => {
    if (!agencyId) return;
    let cancelled = false;
    const fetchUnpaired = async () => {
      try {
        const res = await apiFetch(`${API_BASE}/unpaired`);
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled && data.success) {
          setUnpairedDevices(data.devices ?? []);
        }
      } catch {
        // Silent — unpaired devices are a nice-to-have
      }
    };
    fetchUnpaired();
    const interval = setInterval(fetchUnpaired, 10_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [agencyId]);

  // ─── Discovery Handlers (after fetchDevices is defined) ───────────
  const discoveredDevices = useMemo(
    () => realDiscoveredDevices.filter((d) => !dismissedDiscoveryIds.has(d.id)),
    [realDiscoveredDevices, dismissedDiscoveryIds],
  );

  // ─── Saved TVs + Default Printer state ──────────────────────────────────
  const [savedTvIps, setSavedTvIps] = useState<Set<string>>(new Set());
  const [savingTvId, setSavingTvId] = useState<string | null>(null);
  const [castingId, setCastingId] = useState<string | null>(null);
  const [savingPrinterId, setSavingPrinterId] = useState<string | null>(null);
  const [defaultPrinterIp, setDefaultPrinterIp] = useState<string | null>(null);

  // Fetch saved TVs (for marking which discovered TVs are already saved)
  const fetchSavedTvs = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/saved-tvs?${PORT_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && Array.isArray(data.savedTvs)) {
        setSavedTvIps(new Set(data.savedTvs.map((tv: { ip: string }) => tv.ip)));
      }
    } catch {
      // Silent
    }
  }, [agencyId]);

  // Fetch the default printer (for marking which discovered printer is default)
  const fetchDefaultPrinter = useCallback(async () => {
    if (!agencyId) return;
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/default-printer?${PORT_Q}`);
      if (!res.ok) return;
      const data = await res.json();
      if (data.success && data.defaultPrinter) {
        setDefaultPrinterIp(data.defaultPrinter.ip || null);
      } else {
        setDefaultPrinterIp(null);
      }
    } catch {
      // Silent
    }
  }, [agencyId]);

  // Initial fetch of saved TVs + default printer
  useEffect(() => {
    fetchSavedTvs();
    fetchDefaultPrinter();
  }, [fetchSavedTvs, fetchDefaultPrinter]);

  // Save a discovered TV for later operation (cast, open, HDMI)
  const handleSaveTv = useCallback(async (device: RealDiscoveredDevice) => {
    setSavingTvId(device.id);
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/saved-tvs?${PORT_Q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name,
          nameAr: device.nameAr,
          nameFr: device.nameFr,
          ip: device.ip,
          port: device.port,
          mac: device.mac,
          manufacturer: device.manufacturer || device.macVendor,
          model: device.model,
          ssdpLocation: device.ssdpLocation,
          mdnsService: device.mdnsService,
          source: device.source,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(t('dmSavedTvToast'));
        setSavedTvIps((prev) => new Set(prev).add(device.ip));
      } else {
        toast.error(data.error || getLocalizedString('فشل حفظ التلفاز', 'Échec de l\'enregistrement', 'Failed to save TV', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء الحفظ', 'Erreur lors de l\'enregistrement', 'Error saving TV', lang));
    } finally { setSavingTvId(null); }
  }, [lang, t]);

  // Cast the BLASTI TV board to a discovered TV
  const handleCastTv = useCallback(async (device: RealDiscoveredDevice) => {
    setCastingId(device.id);
    try {
      const res = await apiFetch(`/api/agency-devices/discovery/cast?${PORT_Q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ip: device.ip,
          port: device.port,
          manufacturer: device.manufacturer || device.macVendor,
          name: device.name,
          ssdpLocation: device.ssdpLocation,
        }),
      });
      const data = await res.json();
      if (data.success) {
        if (data.castKind === 'url') {
          // No native cast API worked — open the TV board URL in a new tab
          // so the user can navigate to it on the TV's browser or cast it.
          if (data.tvBoardUrl) window.open(data.tvBoardUrl, '_blank');
          toast.info(t('dmCastTvUrlToast'));
        } else {
          // Native cast (Samsung Tizen / Roku) succeeded
          toast.success(t('dmCastTvToast'));
        }
      } else {
        toast.error(data.error || getLocalizedString('فشل البث', 'Échec de la diffusion', 'Cast failed', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء البث', 'Erreur lors de la diffusion', 'Error casting to TV', lang));
    } finally { setCastingId(null); }
  }, [lang, t]);

  // Save a discovered printer as the default printer for this agency
  // (kiosks + desktop apps on the same network will use it)
  const handleSavePrinter = useCallback(async (device: RealDiscoveredDevice) => {
    setSavingPrinterId(device.id);
    try {
      const isUsb = device.connectionType === 'USB' || !device.ip;
      const res = await apiFetch(`/api/agency-devices/discovery/default-printer?${PORT_Q}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: device.name,
          nameAr: device.nameAr,
          nameFr: device.nameFr,
          ip: device.ip || undefined,
          port: device.port || 9100,
          mac: device.mac,
          manufacturer: device.manufacturer || device.macVendor,
          model: device.model,
          cupsName: device.cupsName,
          cupsUri: device.cupsUri,
          usbVendorId: device.usbVendorId,
          usbProductId: device.usbProductId,
          connectionType: isUsb ? 'USB' : (device.connectionType === 'WIFI' ? 'WIFI' : 'LAN'),
          source: device.source,
        }),
      });
      const data = await res.json();
      if (data.success) {
        toast.success(t('dmSavePrinterToast'));
        setDefaultPrinterIp(device.ip || null);
      } else {
        toast.error(data.error || getLocalizedString('فشل تعيين الطابعة', 'Échec de la configuration', 'Failed to set default printer', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء الحفظ', 'Erreur lors de l\'enregistrement', 'Error saving printer', lang));
    } finally { setSavingPrinterId(null); }
  }, [lang, t]);

  const handleTestDiscoveryPrinter = useCallback(async (device: RealDiscoveredDevice) => {
    setTestingPrinterId(device.id);
    try {
      // Use discovery service probe endpoint for unregistered devices (direct IP test)
      const res = await apiFetch(`/api/probe?XTransformPort=3010`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: device.ip, port: device.port, timeout: 3000 }),
      });
      const data = await res.json();
      if (data.reachable) {
        setPrinterTestResult((prev) => ({ ...prev, [device.id]: 'online' }));
        toast.success(t('dmPrinterOnline'));
      } else {
        setPrinterTestResult((prev) => ({ ...prev, [device.id]: 'offline' }));
        toast.error(t('dmPrinterOffline'));
      }
    } catch {
      setPrinterTestResult((prev) => ({ ...prev, [device.id]: 'error' }));
      toast.error(t('dmPrinterOffline'));
    } finally { setTestingPrinterId(null); }
  }, [t]);

  // Send pairing request to an unpaired device
  const handleSendPairingRequest = useCallback(async (deviceId: string) => {
    setPairingRequestId(deviceId);
    try {
      const res = await apiFetch(`${API_BASE}/${deviceId}/pairing-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(
          'تم إرسال طلب الربط بنجاح',
          'Demande de jumelage envoyée',
          'Pairing request sent successfully',
          lang,
        ));
        setUnpairedDevices((prev) => prev.filter((d) => d.id !== deviceId));
        fetchDevices(true);
      } else {
        toast.error(data.error || getLocalizedString(
          'فشل إرسال طلب الربط',
          "Échec de l'envoi de la demande",
          'Failed to send pairing request',
          lang,
        ));
      }
    } catch {
      toast.error(getLocalizedString(
        'حدث خطأ أثناء إرسال الطلب',
        "Erreur lors de l'envoi",
        'Error sending request',
        lang,
      ));
    } finally {
      setPairingRequestId(null);
    }
  }, [lang, fetchDevices]);

  // Pairing timer
  useEffect(() => {
    if (pairDialogOpen && pairingCode) {
      setPairingTimer(PAIRING_EXPIRE_MS);
      const id = setInterval(() => {
        setPairingTimer((prev) => {
          if (prev <= 1000) { clearInterval(id); return 0; }
          return prev - 1000;
        });
      }, 1000);
      return () => clearInterval(id);
    }
  }, [pairDialogOpen, pairingCode]);

  useEffect(() => {
    if (pairDialogOpen && pairingCode && pairingTimer <= 0) {
      toast.warning(getLocalizedString('انتهت صلاحية كود الربط', 'Le code de jumelage a expiré', 'Pairing code expired', lang));
    }
  }, [pairDialogOpen, pairingCode, pairingTimer]);

  // ─── Handlers ────────────────────────────────────────────────────────────

  const resetForm = () => {
    setFormName(''); setFormNameAr(''); setFormNameFr('');
    setFormType('TV'); setFormConnectionType('LAN');
    setFormIpAddress(''); setFormPort('');
    setFormAutoDiscovery(true); setFormScreenLayout('QUEUE_BOARD');
    setFormBranchId(''); setFormServiceFilter('');
    setFormStatus('OFFLINE'); setFormDisplaySettings({});
    setEditingDevice(null); setCreatedToken(null);
    setCreatedPairingCode(null); setTokenRevealedForAdd(false);
  };

  const openEditDialog = (device: AgencyDevice) => {
    setEditingDevice(device); setFormName(device.name); setFormNameAr(device.nameAr || '');
    setFormNameFr(device.nameFr || ''); setFormType(device.type);
    setFormConnectionType(device.connectionType); setFormIpAddress(device.ipAddress || '');
    setFormPort(device.port?.toString() || ''); setFormAutoDiscovery(device.autoDiscovery);
    setFormScreenLayout(device.screenLayout); setFormBranchId(device.branchId || '');
    setFormServiceFilter(device.serviceFilter || ''); setFormStatus(device.status);
    setFormDisplaySettings(typeof device.displaySettings === 'string' ? JSON.parse(device.displaySettings || '{}') : (device.displaySettings as DisplaySettings) || {});
    setEditDialogOpen(true);
  };

  const handleEditDevice = async () => {
    if (!editingDevice || !formName.trim()) return;
    setFormSubmitting(true);
    try {
      const body: Record<string, unknown> = {
        name: formName.trim(), nameAr: formNameAr.trim() || undefined, nameFr: formNameFr.trim() || undefined,
        type: formType, status: formStatus, connectionType: formConnectionType,
        ipAddress: formIpAddress.trim() || undefined, port: formPort ? parseInt(formPort, 10) : undefined,
        autoDiscovery: formAutoDiscovery, screenLayout: formScreenLayout,
        branchId: formBranchId && formBranchId !== 'none' ? formBranchId : null,
        serviceFilter: formServiceFilter.trim() || undefined, displaySettings: formDisplaySettings,
      };
      const res = await apiFetch(`${API_BASE}/${editingDevice.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم تحديث الجهاز بنجاح', 'Appareil mis à jour', 'Device updated successfully', lang));
        setEditDialogOpen(false); resetForm(); fetchDevices();
      } else {
        toast.error(data.error || getLocalizedString('فشل تحديث الجهاز', 'Échec de la mise à jour', 'Failed to update device', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ أثناء التحديث', 'Erreur lors de la mise à jour', 'Error updating device', lang));
    } finally { setFormSubmitting(false); }
  };

  const handlePair = async (device: AgencyDevice) => {
    setPairingDevice(device); setPairingCode(''); setPairingCodeCopied(false); setPairDialogOpen(true); setPairingLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success && data.pairingCode) { setPairingCode(data.pairingCode); }
      else { toast.error(data.error || getLocalizedString('فشل إنشاء رمز الربط', 'Échec de la génération du code', 'Failed to generate pairing code', lang)); setPairDialogOpen(false); }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang)); setPairDialogOpen(false);
    } finally { setPairingLoading(false); }
  };

  const copyPairingCode = () => {
    if (!pairingCode) return;
    navigator.clipboard.writeText(pairingCode).then(() => {
      setPairingCodeCopied(true); toast.success(getLocalizedString('تم نسخ الرمز', 'Code copié', 'Code copied', lang));
      setTimeout(() => setPairingCodeCopied(false), 2000);
    }).catch(() => { toast.error(getLocalizedString('فشل النسخ', 'Échec de copie', 'Copy failed', lang)); });
  };

  const openDeleteDialog = (device: AgencyDevice) => { setDeletingDevice(device); setDeleteDialogOpen(true); };

  const handleDeleteDevice = async () => {
    if (!deletingDevice) return;
    setDeleteLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${deletingDevice.id}`, { method: 'DELETE' });
      if (!res.ok) { const data = await res.json().catch(() => ({})); console.error('[DeviceManager] Delete failed:', res.status, data); toast.error(data.error || getLocalizedString('فشل الحذف', 'Échec de la suppression', 'Delete failed', lang)); return; }
      const data = await res.json();
      console.log('[DeviceManager] Delete response:', data);
      if (data.success) { toast.success(getLocalizedString('تم حذف الجهاز', 'Appareil supprimé', 'Device deleted', lang)); setDeleteDialogOpen(false); setDeletingDevice(null); if (detailDeviceId === deletingDevice.id) setDetailDeviceId(null); fetchDevices(); }
      else { toast.error(data.error || getLocalizedString('فشل الحذف', 'Échec de la suppression', 'Delete failed', lang)); }
    } catch (err) { console.error('[DeviceManager] Delete exception:', err); toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang)); }
    finally { setDeleteLoading(false); }
  };

  const openUnpairDialog = (device: AgencyDevice) => {
    setUnpairDevice(device);
    setUnpairDialogOpen(true);
  };

  const handleUnpairDevice = async () => {
    if (!unpairDevice) return;
    setUnpairLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${unpairDevice.id}/unpair`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString('تم فك ربط الجهاز بنجاح', 'Appareil dissocié avec succès', 'Device unpaired successfully', lang));
        setUnpairDialogOpen(false);
        setUnpairDevice(null);
        if (detailDeviceId === unpairDevice.id) setDetailDeviceId(null);
        fetchDevices();
        // Also refresh unpaired list
        const unpairedRes = await apiFetch(`${API_BASE}/unpaired`);
        if (unpairedRes.ok) {
          const unpairedData = await unpairedRes.json();
          if (unpairedData.success) setUnpairedDevices(unpairedData.devices ?? []);
        }
      } else {
        toast.error(data.error || getLocalizedString('فشل فك الربط', 'Échec de la dissociation', 'Failed to unpair device', lang));
      }
    } catch {
      toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang));
    } finally {
      setUnpairLoading(false);
    }
  };

  const openCommandDialog = (device: AgencyDevice) => { setCommandDevice(device); setCommandType('REFRESH'); setCommandPayload(''); setCommandSending(false); setCommandDialogOpen(true); };

  const handleSendCommand = async () => {
    if (!commandDevice) return;
    if (commandType === 'REBOOT') { setCommandDialogOpen(false); setRebootConfirmOpen(true); return; }
    await sendCommand();
  };

  const sendCommand = async () => {
    if (!commandDevice) return;
    setCommandSending(true);
    try {
      const body: Record<string, unknown> = {
        type: commandType,
        payload: commandType === 'CONFIG_UPDATE' && commandPayload.trim() ? JSON.parse(commandPayload.trim()) : undefined,
      };
      const res = await apiFetch(`${API_BASE}/${commandDevice.id}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) { toast.success(getLocalizedString('تم إرسال الأمر', 'Commande envoyée', 'Command sent', lang)); setCommandDialogOpen(false); setRebootConfirmOpen(false); fetchDevices(); }
      else { toast.error(data.error || getLocalizedString('فشل إرسال الأمر', 'Échec de l\'envoi', 'Failed to send command', lang)); }
    } catch { toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang)); }
    finally { setCommandSending(false); }
  };

  const handleToggleEnable = async (device: AgencyDevice) => {
    try {
      const newStatus = device.status === 'DISABLED' ? 'OFFLINE' : 'DISABLED';
      const res = await apiFetch(`${API_BASE}/${device.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: newStatus }) });
      const data = await res.json();
      if (data.success) {
        toast.success(getLocalizedString(newStatus === 'DISABLED' ? 'تم تعطيل الجهاز' : 'تم تفعيل الجهاز', newStatus === 'DISABLED' ? 'Appareil désactivé' : 'Appareil activé', newStatus === 'DISABLED' ? 'Device disabled' : 'Device enabled', lang));
        fetchDevices();
      }
    } catch { toast.error(getLocalizedString('حدث خطأ', 'Une erreur est survenue', 'An error occurred', lang)); }
  };

  const handleQuickRefresh = async (device: AgencyDevice) => {
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/command`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'REFRESH' }) });
      const data = await res.json();
      if (data.success) { toast.success(getLocalizedString('جاري تحديث الجهاز', 'Appareil en cours de rafraîchissement', 'Refreshing device...', lang)); fetchDevices(); }
    } catch { /* silent */ }
  };

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text).then(() => { toast.success(label); }).catch(() => { toast.error(getLocalizedString('فشل النسخ', 'Échec de copie', 'Copy failed', lang)); });
  };

  // Kiosk Credentials
  const openKioskCredentials = async (device: AgencyDevice) => {
    setKioskCredDevice(device); setKioskCredPairingCode(device.pairingCode || '');
    setKioskCredToken(''); setKioskCredTokenVisible(false); setKioskCredCopied(null);
    setKioskCredDialogOpen(true); setKioskCredLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${device.id}/kiosk-credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) { setKioskCredPairingCode(data.pairingCode); setKioskCredToken(data.deviceToken); if (data.regenerated) fetchDevices(); }
      else { toast.error(data.error || getLocalizedString('فشل', 'Échec', 'Failed', lang)); setKioskCredDialogOpen(false); }
    } catch { toast.error(getLocalizedString('حدث خطأ', 'Erreur', 'Error', lang)); setKioskCredDialogOpen(false); }
    finally { setKioskCredLoading(false); }
  };

  const handleRegenerateKioskCred = async () => {
    if (!kioskCredDevice) return;
    setKioskCredLoading(true);
    try {
      const res = await apiFetch(`${API_BASE}/${kioskCredDevice.id}/kiosk-credentials/regenerate`, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const data = await res.json();
      if (data.success) { setKioskCredPairingCode(data.pairingCode); setKioskCredToken(data.deviceToken); setKioskCredTokenVisible(false); toast.success(getLocalizedString('تم إعادة إنشاء البيانات', 'Identifiants régénérés', 'Credentials regenerated', lang)); fetchDevices(); }
      else { toast.error(data.error || getLocalizedString('فشل', 'Échec', 'Failed', lang)); }
    } catch { toast.error(getLocalizedString('حدث خطأ', 'Erreur', 'Error', lang)); }
    finally { setKioskCredLoading(false); }
  };

  const copyKioskCredField = (text: string, field: string) => {
    navigator.clipboard.writeText(text).then(() => { setKioskCredCopied(field); toast.success(t('kioskCredentialsCopied')); setTimeout(() => setKioskCredCopied(null), 2000); }).catch(() => { toast.error(getLocalizedString('فشل النسخ', 'Échec de copie', 'Copy failed', lang)); });
  };

  // TV Preview
  const getTvBoardUrl = (device: AgencyDevice) => {
    const baseUrl = window.location.origin;
    const params = new URLSearchParams({ mode: 'device', type: 'TV' });
    if (agencyId) params.set('agencyId', agencyId);
    if (device.displaySettings && typeof device.displaySettings === 'object') {
      try { Object.entries(device.displaySettings as Record<string, unknown>).forEach(([k, v]) => { if (v !== undefined && v !== null) params.set(`ds_${k}`, String(v)); }); } catch { /* ignore */ }
    }
    if (device.branchId) params.set('branchId', device.branchId);
    return `${baseUrl}/?${params.toString()}`;
  };

  const openTvPreview = (device: AgencyDevice) => { setTvPreviewDevice(device); setTvPreviewOpen(true); setTvUrlCopied(false); };

  const copyTvUrl = async () => {
    if (!tvPreviewDevice) return;
    try { await navigator.clipboard.writeText(getTvBoardUrl(tvPreviewDevice)); setTvUrlCopied(true); setTimeout(() => setTvUrlCopied(false), 2000); }
    catch { toast.error(getLocalizedString('فشل النسخ', 'Échec de copie', 'Copy failed', lang)); }
  };

  // Chromecast
  const handleCastToChromecast = useCallback(async () => {
    const nav = navigator as any;
    if (!nav.presentation || !nav.presentation.request) {
      toast.error(getLocalizedString('المتصفح لا يدعم البث. استخدم Chrome أو Edge مع Chromecast.', 'Navigateur incompatible. Utilisez Chrome ou Edge avec Chromecast.', 'Browser does not support casting. Use Chrome/Edge with Chromecast.', lang));
      return;
    }
    try {
      const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`;
      const presentationRequest = new nav.presentation.Request(url, { id: 'blasti-tv-board', title: 'BLASTI Queue Display' });
      await presentationRequest.start();
      toast.success(getLocalizedString('تم البث بنجاح إلى الشاشة', 'Diffusion réussie vers l\'écran', 'Casting started successfully', lang));
      presentationRequest.onend = () => { toast.info(getLocalizedString('تم إنهاء البث', 'Diffusion terminée', 'Casting ended', lang)); };
    } catch (err: any) {
      if (err.name === 'NotAllowedError') { toast.info(getLocalizedString('تم إلغاء البث', 'Diffusion annulée', 'Cast cancelled', lang)); }
      else { toast.error(getLocalizedString('فشل البث: تأكد من اتصال Chromecast بنفس الشبكة', 'Échec: vérifiez que Chromecast est sur le même réseau', 'Cast failed: ensure Chromecast is on the same network', lang)); }
    }
  }, [agencyId, lang]);

  // Create Kiosk
  const openCreateKioskDialog = () => {
    setCreateKioskName(''); setCreateKioskNameAr(''); setCreateKioskNameFr('');
    setCreateKioskBranchId(''); setCreateKioskResult(null); setCreateKioskResultVisible(false);
    setCreateKioskResultCopied(null); setCreateKioskDialogOpen(true);
  };

  const handleCreateKiosk = async () => {
    if (!createKioskName.trim()) { toast.error(getLocalizedString('يرجى إدخال اسم الكيوسك', 'Veuillez entrer le nom du kiosque', 'Please enter a kiosk name', lang)); return; }
    setCreateKioskLoading(true);
    try {
      const body = { name: createKioskName.trim(), nameAr: createKioskNameAr.trim() || undefined, nameFr: createKioskNameFr.trim() || undefined, type: 'KIOSK', connectionType: 'MANUAL' as const, branchId: createKioskBranchId || undefined, autoDiscovery: false, screenLayout: 'SERVICE_SELECTOR' as const };
      const res = await apiFetch(API_BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const data = await res.json();
      if (data.success) {
        setCreateKioskResult({ pairingCode: data.device?.pairingCode || '', deviceToken: data.deviceToken || '', deviceName: createKioskName.trim() });
        toast.success(getLocalizedString('تم إنشاء بيانات الكيوسك بنجاح', 'Identifiants du kiosque créés', 'Kiosk credentials created', lang)); fetchDevices();
      } else { toast.error(data.error || getLocalizedString('فشل إنشاء الكيوسك', 'Échec de la création', 'Failed to create kiosk', lang)); }
    } catch { toast.error(getLocalizedString('حدث خطأ أثناء الإنشاء', 'Erreur lors de la création', 'Error creating kiosk', lang)); }
    finally { setCreateKioskLoading(false); }
  };

  const copyCreateKioskField = (text: string, field: string) => {
    navigator.clipboard.writeText(text).then(() => { setCreateKioskResultCopied(field); toast.success(getLocalizedString('تم النسخ', 'Copié', 'Copied', lang)); setTimeout(() => setCreateKioskResultCopied(null), 2000); }).catch(() => { toast.error(getLocalizedString('فشل النسخ', 'Échec de copie', 'Copy failed', lang)); });
  };

  // ─── Derived ────────────────────────────────────────────────────────────

  const onlineCount = devices.filter((d) => d.status === 'ONLINE').length;
  const offlineCount = devices.filter((d) => d.status === 'OFFLINE' || d.status === 'DISABLED').length;
  const totalCount = devices.length;

  // ─── Render ──────────────────────────────────────────────────────────────

  if (!agencyId) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Card className="w-full max-w-md mx-4">
          <CardContent className="p-8 text-center space-y-3">
            <Settings className="h-12 w-12 mx-auto text-muted-foreground" />
            <h3 className="text-lg font-semibold">{getLocalizedString('لا توجد وكالة مرتبطة', 'Aucune agence assignée', 'No Agency Assigned', lang)}</h3>
            <p className="text-sm text-muted-foreground">{getLocalizedString('يرجى ربط حسابك بوكالة للوصول إلى إعدادات الأجهزة', 'Veuillez lier votre compte à une agence pour accéder aux paramètres des appareils', 'Please link your account to an agency to access device settings', lang)}</p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={300}>
      <div className="space-y-6 p-4 md:p-6 max-w-7xl mx-auto" dir={rtl ? 'rtl' : 'ltr'}>
        {/* Header */}
        <motion.div variants={fadeUp} initial="hidden" animate="visible" className="space-y-4">
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-lg">
                <Monitor className="h-6 w-6" />
              </div>
              <div>
                <h1 className="text-2xl font-bold tracking-tight">{t('devicesConnection')}</h1>
                <p className="text-sm text-muted-foreground">{getLocalizedString('إدارة التلفزيونات، الكيوسكات، وأجهزة العرض المتصلة بوكالتك', 'Gérez les téléviseurs, kiosques et écrans connectés à votre agence', 'Manage TVs, kiosks, and display devices connected to your agency', lang)}</p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              {agencyId && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button size="sm" className="gap-1.5 bg-gradient-to-r from-cyan-500 to-blue-500 hover:from-cyan-600 hover:to-blue-600 text-white shadow-md">
                      <Cast className="h-4 w-4" />
                      {getLocalizedString('بث إلى شاشة', 'Diffuser', 'Cast to Screen', lang)}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="w-64">
                    <DropdownMenuLabel>{getLocalizedString('خيارات البث', 'Options de diffusion', 'Cast Options', lang)}</DropdownMenuLabel>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`; window.open(url, '_blank'); }}>
                      <ExternalLink className="h-4 w-4 mr-2" />
                      <div><div>{getLocalizedString('فتح في تبويب جديد', 'Nouvel onglet', 'Open in New Tab', lang)}</div><div className="text-xs text-muted-foreground">{getLocalizedString('للأجهزة الذكية مع متصفح', 'Pour Smart TV avec navigateur', 'For smart TVs with browser', lang)}</div></div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={handleCastToChromecast}>
                      <Cast className="h-4 w-4 mr-2" />
                      <div><div>{getLocalizedString('بث Chromecast', 'Diffuser Chromecast', 'Chromecast Cast', lang)}</div><div className="text-xs text-muted-foreground">{getLocalizedString('يتطلب جهاز Chromecast متصل', 'Nécessite Chromecast', 'Requires Chromecast device', lang)}</div></div>
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => {
                      const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`;
                      const electronApi = (window as any).electronAPI;
                      if (electronApi && electronApi.openTvScreen) { electronApi.openTvScreen({ url }); toast.success(getLocalizedString('تم فتح شاشة العرض على HDMI', 'Écran ouvert sur HDMI', 'TV screen opened on HDMI', lang)); }
                      else { navigator.clipboard.writeText(url); toast.info(getLocalizedString('تم نسخ الرابط — افتحه في تطبيق سطح المكتب BLASTI', 'Lien copié — ouvrez-le dans l\'app desktop BLASTI', 'URL copied — open in BLASTI desktop app', lang)); }
                    }}>
                      <Cable className="h-4 w-4 mr-2" />
                      <div><div>{getLocalizedString('شاشة HDMI', 'Écran HDMI', 'HDMI Screen', lang)}</div><div className="text-xs text-muted-foreground">{getLocalizedString('عبر تطبيق سطح المكتب', 'Via app de bureau', 'Via desktop app', lang)}</div></div>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => { const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`; navigator.clipboard.writeText(url); toast.success(getLocalizedString('تم نسخ رابط الشاشة', 'Lien copié', 'Screen URL copied', lang)); }}>
                      <Copy className="h-4 w-4 mr-2" />
                      {getLocalizedString('نسخ رابط الشاشة', 'Copier le lien', 'Copy Screen URL', lang)}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => setTvQrDialogOpen(true)}>
                      <QrCode className="h-4 w-4 mr-2" />
                      {getLocalizedString('عرض رمز QR', 'Afficher QR', 'Show QR Code', lang)}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              )}
              <Button size="sm" onClick={() => setTvQrDialogOpen(true)} className="gap-1.5 bg-gradient-to-r from-violet-500 to-purple-500 hover:from-violet-600 hover:to-purple-600 text-white shadow-md">
                <QrCode className="h-4 w-4" />
                {getLocalizedString('رابط التلفاز', 'Lien TV', 'TV Link', lang)}
              </Button>
              <Button size="sm" onClick={openCreateKioskDialog} className="gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white shadow-md">
                {getLocalizedString('إنشاء بيانات كيوسك', 'Créer identifiants kiosque', 'Create Kiosk Credentials', lang)}
              </Button>
              <Button variant="outline" size="sm" onClick={() => { discoveryStartScan(); }} className="gap-1.5">
                <Radio className="h-4 w-4" />
                {getLocalizedString('بحث في الشبكة', 'Recherche réseau', 'Scan Network', lang)}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => fetchDevices()} className="gap-1.5">
                <RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              </Button>
            </div>
          </div>

          {/* Stats */}
          <div className="grid grid-cols-3 gap-3 max-w-md">
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-500" />
              <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{onlineCount}</span>
              <span className="text-xs text-muted-foreground">{getLocalizedString('متصل', 'En ligne', 'Online', lang)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-gray-400" />
              <span className="text-sm font-medium">{offlineCount}</span>
              <span className="text-xs text-muted-foreground">{getLocalizedString('غير متصل', 'Hors ligne', 'Offline', lang)}</span>
            </div>
            <div className="flex items-center gap-2 rounded-lg border bg-card px-3 py-2">
              <span className="h-2.5 w-2.5 rounded-full bg-primary" />
              <span className="text-sm font-medium">{totalCount}</span>
              <span className="text-xs text-muted-foreground">{getLocalizedString('الكل', 'Total', 'Total', lang)}</span>
            </div>
          </div>
        </motion.div>

        {/* Network Discovery Panel (new real discovery) */}
        <NetworkDiscoveryPanel
          scanState={scanState}
          discoveredDevices={discoveredDevices}
          onStartScan={discoveryStartScan}
          onStopScan={discoveryStopScan}
          onAutoScanChange={setDiscoveryAutoScan}
          onSaveTv={handleSaveTv}
          onCast={handleCastTv}
          onSavePrinter={handleSavePrinter}
          onTestPrinter={handleTestDiscoveryPrinter}
          autoScanEnabled={v2AutoScan}
          serviceAvailable={discoveryServiceAvailable}
          savedTvIps={savedTvIps}
          savingTvId={savingTvId}
          castingId={castingId}
          savingPrinterId={savingPrinterId}
          defaultPrinterIp={defaultPrinterIp}
          testingPrinterId={testingPrinterId}
          printerTestResults={printerTestResult}
          onDismissDevice={handleDismissDiscoveryDevice}
          protocols={protocols}
          unpairedDevices={unpairedDevices}
          pairingRequestId={pairingRequestId}
          onSendPairingRequest={handleSendPairingRequest}
        />

        {/* Device Cards Grid */}
        <DeviceGrid
          devices={devices}
          loading={loading}
          error={error}
          lang={lang}
          onRetry={() => fetchDevices()}
          onScanNetwork={() => { discoveryStartScan(); }}
          onDetail={(d) => { setDetailDeviceId(d.id); setTokenRevealed(false); }}
          onEdit={openEditDialog}
          onPair={handlePair}
          onDelete={openDeleteDialog}
          onCommand={openCommandDialog}
          onQuickRefresh={handleQuickRefresh}
          onToggleEnable={handleToggleEnable}
          onTvPreview={openTvPreview}
          onKioskCredentials={openKioskCredentials}
          onUnpair={openUnpairDialog}
        />

        {/* Device Detail Sheet */}
        {detailDevice && (
          <DeviceDetailSheet
            device={detailDevice}
            lang={lang}
            rtl={rtl}
            tokenRevealed={tokenRevealed}
            onTokenRevealedChange={setTokenRevealed}
            onTabChange={() => {}}
            onPair={handlePair}
            onCommand={openCommandDialog}
            onEdit={openEditDialog}
            onDelete={openDeleteDialog}
            onCopy={copyToClipboard}
            onUnpair={openUnpairDialog}
            onClose={() => setDetailDeviceId(null)}
          />
        )}

        {/* ─── All Dialogs ──────────────────────────────────────────────── */}
        <EditDeviceDialog
          open={editDialogOpen}
          lang={lang}
          rtl={rtl}
          t={t}
          submitting={formSubmitting}
          tokenRevealed={false}
          formName={formName} formNameAr={formNameAr} formNameFr={formNameFr}
          formType={formType} formConnectionType={formConnectionType}
          formIpAddress={formIpAddress} formPort={formPort}
          formAutoDiscovery={formAutoDiscovery} formScreenLayout={formScreenLayout}
          formBranchId={formBranchId} formServiceFilter={formServiceFilter}
          formStatus={formStatus} formDisplaySettings={formDisplaySettings}
          branches={branches} editingDevice={editingDevice}
          onOpenChange={setEditDialogOpen}
          onFormNameChange={setFormName} onFormNameArChange={setFormNameAr} onFormNameFrChange={setFormNameFr}
          onFormTypeChange={setFormType} onFormConnectionTypeChange={setFormConnectionType}
          onFormIpAddressChange={setFormIpAddress} onFormPortChange={setFormPort}
          onFormAutoDiscoveryChange={setFormAutoDiscovery} onFormScreenLayoutChange={setFormScreenLayout}
          onFormBranchIdChange={setFormBranchId} onFormServiceFilterChange={setFormServiceFilter}
          onFormStatusChange={setFormStatus} onFormDisplaySettingsChange={setFormDisplaySettings}
          onSubmit={handleEditDevice} onReset={resetForm}
        />

        <PairDeviceDialog
          open={pairDialogOpen} lang={lang} rtl={rtl}
          device={pairingDevice} pairingCode={pairingCode}
          pairingCodeCopied={pairingCodeCopied} pairingLoading={pairingLoading}
          pairingTimer={pairingTimer}
          onOpenChange={(o) => { setPairDialogOpen(o); if (!o) { setPairingDevice(null); setPairingCode(''); setPairingCodeCopied(false); } }}
          onCopyPairingCode={copyPairingCode}
        />

        <CommandDialog
          open={commandDialogOpen} lang={lang} rtl={rtl}
          device={commandDevice} commandType={commandType}
          commandPayload={commandPayload} commandSending={commandSending}
          onOpenChange={(o) => { setCommandDialogOpen(o); if (!o) { setCommandDevice(null); setCommandPayload(''); } }}
          onCommandTypeChange={setCommandType} onCommandPayloadChange={setCommandPayload}
          onSend={handleSendCommand}
        />

        <RebootConfirmDialog
          open={rebootConfirmOpen} lang={lang} rtl={rtl}
          device={commandDevice} sending={commandSending}
          onOpenChange={setRebootConfirmOpen} onConfirm={sendCommand}
        />

        <DeleteConfirmDialog
          open={deleteDialogOpen} lang={lang} rtl={rtl}
          device={deletingDevice} loading={deleteLoading}
          onOpenChange={(o) => { setDeleteDialogOpen(o); if (!o) setDeletingDevice(null); }}
          onConfirm={handleDeleteDevice}
        />

        {/* Unpair Confirmation Dialog */}
        {unpairDialogOpen && unpairDevice && (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => { if (!unpairLoading) { setUnpairDialogOpen(false); setUnpairDevice(null); } }}>
            <div className="bg-background rounded-xl p-6 max-w-sm w-full mx-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center gap-3 mb-4">
                <div className="h-10 w-10 rounded-lg bg-orange-100 flex items-center justify-center">
                  <Unplug className="h-5 w-5 text-orange-600" />
                </div>
                <div>
                  <h3 className="text-lg font-semibold">{getLocalizedString('فك ربط الجهاز', 'Dissocier l\'appareil', 'Unpair Device', lang)}</h3>
                  <p className="text-sm text-muted-foreground">{getLocalizedName(unpairDevice, lang)}</p>
                </div>
              </div>
              <p className="text-sm text-muted-foreground mb-6">
                {getLocalizedString(
                  'سيتم فك ربط هذا الجهاز من وكالتك وفصل الاتصال فوراً. سيحتاج الجهاز إلى إعادة الربط للاتصال مرة أخرى.',
                  'Cet appareil sera dissocié de votre agence et déconnecté immédiatement. Il devra être réappairé pour se reconnecter.',
                  'This device will be unpaired from your agency and disconnected immediately. It will need to be re-paired to reconnect.',
                  lang,
                )}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => { setUnpairDialogOpen(false); setUnpairDevice(null); }} disabled={unpairLoading}>
                  {t('cancel') || 'Cancel'}
                </Button>
                <Button className="flex-1 bg-orange-500 hover:bg-orange-600 text-white" onClick={handleUnpairDevice} disabled={unpairLoading}>
                  {unpairLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Unplug className="h-4 w-4" />}
                  {getLocalizedString('فك الربط', 'Dissocier', 'Unpair', lang)}
                </Button>
              </div>
            </div>
          </div>
        )}

        <CreateKioskDialog
          open={createKioskDialogOpen} lang={lang} rtl={rtl} t={t}
          loading={createKioskLoading}
          name={createKioskName} nameAr={createKioskNameAr} nameFr={createKioskNameFr}
          branchId={createKioskBranchId}
          result={createKioskResult} resultVisible={createKioskResultVisible}
          resultCopiedField={createKioskResultCopied} branches={branches}
          onOpenChange={(o) => { setCreateKioskDialogOpen(o); if (!o) { setCreateKioskResult(null); setCreateKioskName(''); } }}
          onNameChange={setCreateKioskName} onNameArChange={setCreateKioskNameAr} onNameFrChange={setCreateKioskNameFr}
          onBranchIdChange={setCreateKioskBranchId} onResultVisibleChange={setCreateKioskResultVisible}
          onSubmit={handleCreateKiosk} onCopyField={copyCreateKioskField}
        />

        <KioskCredentialsDialog
          open={kioskCredDialogOpen} lang={lang} rtl={rtl}
          device={kioskCredDevice} loading={kioskCredLoading}
          pairingCode={kioskCredPairingCode} token={kioskCredToken}
          tokenVisible={kioskCredTokenVisible} copiedField={kioskCredCopied} t={t}
          onOpenChange={(o) => { setKioskCredDialogOpen(o); if (!o) { setKioskCredDevice(null); setKioskCredPairingCode(''); setKioskCredToken(''); setKioskCredCopied(null); } }}
          onTokenVisibleChange={setKioskCredTokenVisible}
          onCopyField={copyKioskCredField} onRegenerate={handleRegenerateKioskCred}
        />

        <TvPreviewDialog
          open={tvPreviewOpen} lang={lang} rtl={rtl}
          device={tvPreviewDevice} urlCopied={tvUrlCopied} agencyId={agencyId ?? ''}
          onOpenChange={(o) => { setTvPreviewOpen(o); if (!o) { setTvPreviewDevice(null); setTvUrlCopied(false); } }}
          onCopyUrl={copyTvUrl} getTvBoardUrl={getTvBoardUrl}
        />

        <TvQrDialog
          open={tvQrDialogOpen} lang={lang} agencyId={agencyId ?? ''}
          onOpenChange={setTvQrDialogOpen}
          onCopyUrl={() => {
            const url = `${window.location.origin}/?mode=device&type=TV&agencyId=${agencyId}`;
            navigator.clipboard.writeText(url);
            toast.success(getLocalizedString('تم نسخ الرابط', 'Lien copié', 'URL copied', lang));
          }}
        />
      </div>
    </TooltipProvider>
  );
}