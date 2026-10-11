'use client';

import { useMemo, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Skeleton } from '@/components/ui/skeleton';
import { Progress } from '@/components/ui/progress';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Radar,
  Wifi,
  WifiOff,
  Loader2,
  CheckCircle2,
  XCircle,
  Plus,
  Printer,
  Clock,
  Smartphone,
  Globe,
  X,
  Radio,
  Cast,
  Signal,
  Send,
  Usb,
  Router as RouterIcon,
  Cpu,
  Tv,
  Tablet,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import {
  type RealDiscoveredDevice,
  type ScanState,
  type DiscoveredDeviceCategory,
  type ProtocolStatus,
  type ScanPhase,
  DEVICE_TYPE_CONFIG,
  DISCOVERY_SOURCE_CONFIG,
  DISCOVERY_CATEGORY_CONFIG,
  CONNECTION_TYPE_CONFIG,
  ConnectionQualityBar,
  fadeUp,
  staggerContainer,
  staggerItem,
  getLocalizedLabel,
  getLocalizedName,
  timeSince,
} from './types';

// ── Radar Animation ──────────────────────────────────────────────────

function RadarAnimation({ active }: { active: boolean }) {
  return (
    <div className="relative h-16 w-16 flex items-center justify-center">
      {/* Concentric rings */}
      <span className="absolute inset-0 rounded-full border border-emerald-300/30 dark:border-emerald-700/30" />
      <span className="absolute inset-2 rounded-full border border-emerald-300/40 dark:border-emerald-700/40" />
      <span className="absolute inset-4 rounded-full border border-emerald-300/50 dark:border-emerald-700/50" />
      {/* Sweep line */}
      {active && (
        <motion.span
          className="absolute inset-0 rounded-full border-t-2 border-r-2 border-emerald-500"
          animate={{ rotate: 360 }}
          transition={{ duration: 2, repeat: Infinity, ease: 'linear' }}
          style={{ transformOrigin: 'center' }}
        />
      )}
      {/* Center dot */}
      <span className="relative z-10 h-3 w-3 rounded-full bg-emerald-500" />
      {/* Ping effect when active */}
      {active && (
        <motion.span
          className="absolute inset-0 rounded-full bg-emerald-500/10"
          animate={{ scale: [1, 1.6, 1], opacity: [0.5, 0, 0.5] }}
          transition={{ duration: 2, repeat: Infinity }}
        />
      )}
    </div>
  );
}

// ── Phase Indicator ─────────────────────────────────────────────────

// Phase order must match the backend runDiscoveryScan() sequence in
// apps/api/src/lib/discovery/scanner.ts:
//   ARP → Ping → mDNS → SSDP → rDNS/NBNS → USB/CUPS → HTTP (last) → Fingerprinting → Complete
// HTTP runs LAST so that mDNS/SSDP/rDNS device names are not overwritten by
// misleading HTTP <title> values (e.g. "Adobe PDF" from a CUPS web admin).
const SCAN_PHASES: ScanPhase[] = ['arp', 'ping', 'mdns', 'ssdp', 'names', 'local', 'http', 'fingerprinting', 'complete'];

function PhaseIndicator({ phase }: { phase: ScanPhase }) {
  const { t } = useLanguage();
  const phaseLabels: Record<ScanPhase, string> = {
    idle: t('dmScanPhase'),
    arp: t('dmScanPhaseArp'),
    ping: t('dmScanPhasePing'),
    udp: t('dmScanPhaseUdp'),
    ssdp: t('dmScanPhaseSsdp'),
    mdns: t('dmScanPhaseMdns'),
    names: 'rDNS/NBNS',
    http: t('dmScanPhaseHttp'),
    https: t('dmScanPhaseHttps'),
    local: 'USB/CUPS',
    fingerprinting: t('dmScanPhaseFingerprinting'),
    complete: t('dmScanPhaseComplete'),
    error: t('dmScanPhaseError'),
  };
  const activeIndex = SCAN_PHASES.indexOf(phase);
  const isErrored = phase === 'error';

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto">
      {SCAN_PHASES.map((p, i) => {
        const isActive = i <= activeIndex && phase !== 'idle' && !isErrored;
        const isCurrent = p === phase;
        return (
          <div key={p} className="flex items-center gap-1.5">
            {i > 0 && (
              <div className={`h-px w-4 transition-colors ${isActive ? 'bg-emerald-500' : 'bg-muted'}`} />
            )}
            <div
              className={`flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium transition-all ${
                isErrored && p === phase
                  ? 'bg-red-500 text-white shadow-sm'
                  : isCurrent
                    ? 'bg-emerald-500 text-white shadow-sm'
                    : isActive
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                      : 'bg-muted text-muted-foreground'
              }`}
            >
              {isCurrent && p !== 'complete' && p !== 'error' && (
                <Loader2 className="h-3 w-3 animate-spin" />
              )}
              {isActive && !isCurrent && p !== 'error' && (
                <CheckCircle2 className="h-3 w-3" />
              )}
              {isErrored && p === phase && (
                <XCircle className="h-3 w-3" />
              )}
              {phaseLabels[p]}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Signal Strength ─────────────────────────────────────────────────

function getSignalFromLastSeen(lastSeen: number): 'excellent' | 'good' | 'fair' | 'poor' {
  const diff = Date.now() - lastSeen;
  if (diff < 5000) return 'excellent';
  if (diff < 15000) return 'good';
  if (diff < 30000) return 'fair';
  return 'poor';
}

function formatTimeAgo(timestamp: number, lang: string): string {
  const diffMs = Date.now() - timestamp;
  const diffSec = Math.floor(diffMs / 1000);
  if (diffSec < 10) return 'just now';
  if (diffSec < 60) return `${diffSec}s`;
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m`;
  return `${Math.floor(diffMin / 60)}h`;
}

// ── Discovered Device Card ──────────────────────────────────────────

function DiscoveredDeviceCard({
  device,
  lang,
  isSavingTv,
  isSavedTv,
  isCasting,
  isSavingPrinter,
  isDefaultPrinter,
  isTestingPrinter,
  printerTestResult,
  onSaveTv,
  onCast,
  onSavePrinter,
  onTestPrinter,
  onDismiss,
}: {
  device: RealDiscoveredDevice;
  lang: string;
  isSavingTv: boolean;
  isSavedTv: boolean;
  isCasting: boolean;
  isSavingPrinter: boolean;
  isDefaultPrinter: boolean;
  isTestingPrinter: boolean;
  printerTestResult: 'online' | 'offline' | 'error' | undefined;
  onSaveTv: () => void;
  onCast: () => void;
  onSavePrinter: () => void;
  onTestPrinter: () => void;
  onDismiss: () => void;
}) {
  const { t } = useLanguage();
  const isPrinter = device.type === 'PRINTER';
  const isTv = device.type === 'TV';
  // Lookup the device type config; fall back to a per-category default
  const typeConfig = (device.type !== 'UNKNOWN' && DEVICE_TYPE_CONFIG[device.type as keyof typeof DEVICE_TYPE_CONFIG]) || null;
  const TypeIcon = typeConfig?.icon ?? Globe;
  const sourceConfig = DISCOVERY_SOURCE_CONFIG[device.source];
  const SourceIcon = sourceConfig?.icon ?? Radio;
  const signal = getSignalFromLastSeen(device.lastSeen);
  const isOnline = device.status === 'ONLINE';

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95, y: -8 }}
      whileHover={{ y: -2, scale: 1.01 }}
      transition={{ duration: 0.25 }}
      className={`rounded-xl border bg-card overflow-hidden transition-shadow hover:shadow-lg ${
        isOnline ? 'border-border/60' : 'border-dashed border-muted-foreground/30'
      }`}
    >
      {/* Top gradient bar */}
      <div className={`h-1 w-full ${
        isOnline
          ? device.category === 'BLASTI'
            ? 'bg-gradient-to-r from-emerald-500 to-teal-400'
            : device.category === 'UPNP'
              ? 'bg-gradient-to-r from-amber-500 to-orange-400'
              : device.category === 'LOCAL'
                ? 'bg-gradient-to-r from-rose-500 to-pink-400'
                : 'bg-gradient-to-r from-sky-500 to-cyan-400'
          : 'bg-muted'
      }`} />

      <div className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg shrink-0 ${
            typeConfig?.color ?? 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-400'
          }`}>
            <TypeIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <h4 className="font-semibold text-sm truncate">
                {getLocalizedName(device, lang)}
              </h4>
              {!isOnline && (
                <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500">
                  STALE
                </Badge>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {typeConfig && (
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${typeConfig.color}`}>
                  {getLocalizedLabel(typeConfig, lang)}
                </Badge>
              )}
              {sourceConfig && (
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 gap-1 ${sourceConfig.color}`}>
                  <SourceIcon className="h-2.5 w-2.5" />
                  {getLocalizedLabel(sourceConfig, lang)}
                </Badge>
              )}
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            onClick={(e) => { e.stopPropagation(); onDismiss(); }}
            className="h-7 w-7 p-0 text-muted-foreground hover:text-red-500 shrink-0"
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        {/* Info row */}
        <div className="space-y-2 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {device.connectionType === 'WIFI' ? (
                <Wifi className="h-3 w-3" />
              ) : device.connectionType === 'LAN' ? (
                <Signal className="h-3 w-3" />
              ) : device.connectionType === 'USB' ? (
                <Printer className="h-3 w-3" />
              ) : (
                <Globe className="h-3 w-3" />
              )}
              {device.connectionType === 'USB' ? (
                <span className="font-mono">USB{device.usbBusDevice ? ` ${device.usbBusDevice}` : ''}</span>
              ) : (
                <span className="font-mono">{device.ip}:{device.port}</span>
              )}
            </div>
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>{formatTimeAgo(device.lastSeen, lang)}</span>
            </div>
          </div>

          {/* Signal quality — only meaningful for network devices */}
          {device.connectionType !== 'USB' && (
            <ConnectionQualityBar quality={signal} />
          )}

          {/* USB / CUPS state badges for local printers */}
          {(device.connectionType === 'USB' || device.cupsState) && (
            <div className="flex items-center gap-1.5 flex-wrap">
              {device.cupsState && (() => {
                // Map CUPS / Windows printer states to a colour + human label.
                // States produced by the scanner: idle, printing, warming_up,
                // stopped, offline, other, unknown.  Only "stopped"/"offline"
                // are genuine errors — everything else is operational.
                const st = device.cupsState;
                let cls = 'bg-gray-50 text-gray-600 dark:bg-gray-950/40 dark:text-gray-400';
                let label = st;
                if (st === 'idle') {
                  cls = 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400';
                  label = lang === 'ar' ? 'جاهز' : lang === 'fr' ? 'Prêt' : 'Idle';
                } else if (st === 'printing') {
                  cls = 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
                  label = lang === 'ar' ? 'يطبع' : lang === 'fr' ? 'Impression' : 'Printing';
                } else if (st === 'warming_up') {
                  cls = 'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400';
                  label = lang === 'ar' ? 'يسخّن' : lang === 'fr' ? 'Préparation' : 'Warming';
                } else if (st === 'stopped') {
                  cls = 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400';
                  label = lang === 'ar' ? 'موقف' : lang === 'fr' ? 'Arrêté' : 'Stopped';
                } else if (st === 'offline') {
                  cls = 'bg-red-50 text-red-700 dark:bg-red-950/40 dark:text-red-400';
                  label = lang === 'ar' ? 'غير متصل' : lang === 'fr' ? 'Hors ligne' : 'Offline';
                } else if (st === 'other' || st === 'unknown') {
                  cls = 'bg-gray-50 text-gray-500 dark:bg-gray-950/40 dark:text-gray-400';
                  label = lang === 'ar' ? 'غير معروف' : lang === 'fr' ? 'Inconnu' : 'Unknown';
                }
                return (
                  <Badge variant="outline" className={`text-[9px] px-1.5 py-0 ${cls}`}>
                    {label}
                  </Badge>
                );
              })()}
              {device.usbVendorId && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">
                  VID:{device.usbVendorId}
                </Badge>
              )}
              {device.usbProductId && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono">
                  PID:{device.usbProductId}
                </Badge>
              )}
              {device.cupsUri && (
                <Badge variant="outline" className="text-[9px] px-1.5 py-0 font-mono max-w-[200px] truncate" title={device.cupsUri}>
                  {device.cupsUri.length > 30 ? device.cupsUri.slice(0, 30) + '…' : device.cupsUri}
                </Badge>
              )}
            </div>
          )}

          {/* Extra info */}
          <div className="flex items-center gap-2 flex-wrap">
            {device.model && (
              <span className="text-[10px]">{t('dmModel')}: {device.model}</span>
            )}
            {device.manufacturer && (
              <span className="text-[10px]">{t('dmManufacturer')}: {device.manufacturer}</span>
            )}
            {device.mac && device.mac !== '00:00:00:00:00:00' && (
              <span className="text-[10px] font-mono">MAC: {device.mac}</span>
            )}
            {device.macVendor && (
              <Badge variant="outline" className="text-[9px] px-1.5 py-0">
                {device.macVendor}
              </Badge>
            )}
            {device.appVersion && (
              <span className="text-[10px]">{t('dmFirmwareVersion')}: {device.appVersion}</span>
            )}
          </div>

          {/* Capabilities */}
          {device.capabilities.length > 0 && (
            <div className="flex items-center gap-1 flex-wrap">
              {device.capabilities.slice(0, 4).map((cap) => (
                <Badge key={cap} variant="outline" className="text-[9px] px-1.5 py-0">
                  {cap}
                </Badge>
              ))}
              {device.capabilities.length > 4 && (
                <span className="text-[9px] text-muted-foreground">+{device.capabilities.length - 4}</span>
              )}
            </div>
          )}
        </div>

        {/* Action buttons — type-specific */}
        <div className="flex items-center gap-2 pt-1 flex-wrap">
          {/* TV: Save TV + Cast buttons */}
          {isTv && (
            <>
              <Button
                size="sm"
                onClick={(e) => { e.stopPropagation(); onSaveTv(); }}
                disabled={isSavingTv || isSavedTv}
                className="flex-1 gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white text-xs h-8 min-w-[110px]"
              >
                {isSavingTv ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('dmSaving')}</>
                ) : isSavedTv ? (
                  <><CheckCircle2 className="h-3.5 w-3.5" />{t('dmSavedTv')}</>
                ) : (
                  <><Plus className="h-3.5 w-3.5" />{t('dmSaveTv')}</>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => { e.stopPropagation(); onCast(); }}
                disabled={isCasting}
                className="gap-1.5 text-xs h-8 border-cyan-300 text-cyan-700 hover:bg-cyan-50 dark:border-cyan-800 dark:text-cyan-400 dark:hover:bg-cyan-950/30"
              >
                {isCasting ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('dmCasting')}</>
                ) : (
                  <><Cast className="h-3.5 w-3.5" />{t('dmCast')}</>
                )}
              </Button>
            </>
          )}

          {/* Printer: Save as Default + Test buttons */}
          {isPrinter && (
            <>
              <Button
                size="sm"
                onClick={(e) => { e.stopPropagation(); onSavePrinter(); }}
                disabled={isSavingPrinter || isDefaultPrinter}
                className="flex-1 gap-1.5 bg-gradient-to-r from-amber-500 to-orange-500 hover:from-amber-600 hover:to-orange-600 text-white text-xs h-8 min-w-[110px]"
              >
                {isSavingPrinter ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('dmSaving')}</>
                ) : isDefaultPrinter ? (
                  <><CheckCircle2 className="h-3.5 w-3.5" />{t('dmDefaultPrinter')}</>
                ) : (
                  <><Printer className="h-3.5 w-3.5" />{t('dmSavePrinter')}</>
                )}
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={(e) => { e.stopPropagation(); onTestPrinter(); }}
                disabled={isTestingPrinter}
                className="gap-1.5 text-xs h-8"
              >
                {isTestingPrinter ? (
                  <><Loader2 className="h-3.5 w-3.5 animate-spin" />{t('dmTestingPrinter')}</>
                ) : (
                  <><Signal className="h-3.5 w-3.5" />{t('dmTestPrinter')}</>
                )}
              </Button>
              {printerTestResult && (
                <Badge
                  variant="secondary"
                  className={`text-[10px] px-1.5 py-0 gap-1 ${
                    printerTestResult === 'online'
                      ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400'
                      : 'bg-red-100 text-red-700 dark:bg-red-950/40 dark:text-red-400'
                  }`}
                >
                  {printerTestResult === 'online' ? (
                    <><CheckCircle2 className="h-3 w-3" />{t('dmPrinterOnline')}</>
                  ) : (
                    <><XCircle className="h-3 w-3" />{t('dmPrinterOffline')}</>
                  )}
                </Badge>
              )}
            </>
          )}

          {/* Other types: no primary action — just dismiss */}
          {!isTv && !isPrinter && (
            <div className="text-[11px] text-muted-foreground italic flex-1">
              {t('dmNoActionHint')}
            </div>
          )}
        </div>
      </div>
    </motion.div>
  );
}

// ── Unpaired Kiosk Card (registered via API, waiting for pairing) ──

interface UnpairedKiosk {
  id: string;
  name: string;
  nameAr?: string | null;
  nameFr?: string | null;
  type: string;
  connectionType: string;
  ipAddress?: string | null;
  port?: number | null;
  lastHeartbeatAt?: string | null;
  createdAt: string;
}

function UnpairedKioskCard({
  device,
  lang,
  isSending,
  onSendPairing,
}: {
  device: UnpairedKiosk;
  lang: string;
  isSending: boolean;
  onSendPairing: () => void;
}) {
  const typeCfg = DEVICE_TYPE_CONFIG[device.type as keyof typeof DEVICE_TYPE_CONFIG] ?? DEVICE_TYPE_CONFIG.KIOSK;
  const TypeIcon = typeCfg.icon;
  const connCfg = CONNECTION_TYPE_CONFIG[device.connectionType as keyof typeof CONNECTION_TYPE_CONFIG] ?? CONNECTION_TYPE_CONFIG.LAN;
  const ConnIcon = connCfg.icon;

  return (
    <motion.div
      initial={{ opacity: 0, scale: 0.95, y: 8 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      whileHover={{ y: -2, scale: 1.01 }}
      transition={{ duration: 0.25 }}
      className="rounded-xl border-2 border-dashed border-teal-300 dark:border-teal-700 bg-gradient-to-br from-teal-50/50 to-emerald-50/50 dark:from-teal-950/20 dark:to-emerald-950/20 overflow-hidden transition-shadow hover:shadow-lg"
    >
      {/* Top accent */}
      <div className="h-1 w-full bg-gradient-to-r from-teal-400 to-emerald-400" />

      <div className="p-4 space-y-3">
        {/* Header row */}
        <div className="flex items-start gap-3">
          <div className={`p-2 rounded-lg shrink-0 ${typeCfg.color}`}>
            <TypeIcon className="h-5 w-5" />
          </div>
          <div className="flex-1 min-w-0 space-y-1">
            <h4 className="font-semibold text-sm truncate">
              {getLocalizedName(device as any, lang)}
            </h4>
            <div className="flex items-center gap-1.5 flex-wrap">
              <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${typeCfg.color}`}>
                {getLocalizedLabel(typeCfg, lang)}
              </Badge>
              <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
                <ConnIcon className="h-2.5 w-2.5" />
                {getLocalizedLabel(connCfg, lang)}
              </Badge>
              <Badge variant="secondary" className="text-[10px] px-1.5 py-0 bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400 gap-1">
                <Smartphone className="h-2.5 w-2.5" />
                {lang === 'ar' ? 'ينتظر الربط' : lang === 'fr' ? 'En attente' : 'Pairing'}
              </Badge>
            </div>
          </div>
        </div>

        {/* Info */}
        <div className="space-y-2 text-xs text-muted-foreground">
          {/* IP Address */}
          {device.ipAddress && (
            <div className="flex items-center gap-1.5 font-mono" dir="ltr">
              <Globe className="h-3 w-3 shrink-0" />
              <span>{device.ipAddress}{device.port ? `:${device.port}` : ''}</span>
            </div>
          )}
          {/* Heartbeat */}
          <div className="flex items-center gap-1.5">
            <Clock className="h-3 w-3 shrink-0" />
            <span>
              {device.lastHeartbeatAt
                ? `${lang === 'ar' ? 'آخر نشاط' : lang === 'fr' ? 'Dernière activité' : 'Last activity'}: ${timeSince(device.lastHeartbeatAt)}`
                : lang === 'ar' ? 'في انتظار الاتصال' : lang === 'fr' ? 'En attente de connexion' : 'Awaiting connection'}
            </span>
          </div>
        </div>

        {/* Action */}
        <Button
          size="sm"
          onClick={() => onSendPairing()}
          disabled={isSending}
          className="w-full gap-1.5 bg-gradient-to-r from-teal-500 to-emerald-500 hover:from-teal-600 hover:to-emerald-600 text-white text-xs h-8"
        >
          {isSending ? (
            <><Loader2 className="h-3.5 w-3.5 animate-spin" />{lang === 'ar' ? 'جاري الإرسال...' : lang === 'fr' ? 'Envoi...' : 'Sending...'}</>
          ) : (
            <><Send className="h-3.5 w-3.5" />{lang === 'ar' ? 'إرسال طلب الربط' : lang === 'fr' ? 'Envoyer la demande' : 'Send Pairing Request'}</>
          )}
        </Button>
      </div>
    </motion.div>
  );
}

// ── Category Group ──────────────────────────────────────────────────

function CategoryGroup({
  category,
  devices,
  lang,
  savingTvId,
  savedTvIps,
  castingId,
  savingPrinterId,
  defaultPrinterIp,
  testingPrinterId,
  printerTestResults,
  onSaveTv,
  onCast,
  onSavePrinter,
  onTestPrinter,
  onDismissDevice,
}: {
  category: DiscoveredDeviceCategory;
  devices: RealDiscoveredDevice[];
  lang: string;
  savingTvId: string | null;
  savedTvIps: Set<string>;
  castingId: string | null;
  savingPrinterId: string | null;
  defaultPrinterIp: string | null;
  testingPrinterId: string | null;
  printerTestResults: Record<string, 'online' | 'offline' | 'error'>;
  onSaveTv: (device: RealDiscoveredDevice) => void;
  onCast: (device: RealDiscoveredDevice) => void;
  onSavePrinter: (device: RealDiscoveredDevice) => void;
  onTestPrinter: (device: RealDiscoveredDevice) => void;
  onDismissDevice: (deviceId: string) => void;
}) {
  const { t } = useLanguage();
  const catConfig = DISCOVERY_CATEGORY_CONFIG[category];

  if (devices.length === 0) return null;

  const categoryIcons: Record<DiscoveredDeviceCategory, typeof Globe> = {
    BLASTI: Radio,
    NETWORK: Wifi,
    UPNP: Cast,
    LOCAL: Printer,
  };
  const CatIcon = categoryIcons[category];

  return (
    <motion.div variants={staggerItem} className="space-y-3">
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-md ${catConfig.color}`}>
          <CatIcon className="h-4 w-4" />
        </div>
        <span className="text-sm font-semibold">{getLocalizedLabel(catConfig, lang)}</span>
        <Badge variant="secondary" className="text-[10px]">
          {devices.length}
        </Badge>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 max-h-96 overflow-y-auto">
        <AnimatePresence>
          {devices.map((device) => (
            <DiscoveredDeviceCard
              key={device.id}
              device={device}
              lang={lang}
              isSavingTv={savingTvId === device.id}
              isSavedTv={savedTvIps.has(device.ip)}
              isCasting={castingId === device.id}
              isSavingPrinter={savingPrinterId === device.id}
              isDefaultPrinter={defaultPrinterIp === device.ip}
              isTestingPrinter={testingPrinterId === device.id}
              printerTestResult={printerTestResults[device.id]}
              onSaveTv={() => onSaveTv(device)}
              onCast={() => onCast(device)}
              onSavePrinter={() => onSavePrinter(device)}
              onTestPrinter={() => onTestPrinter(device)}
              onDismiss={() => onDismissDevice(device.id)}
            />
          ))}
        </AnimatePresence>
      </div>
    </motion.div>
  );
}

// ── Main Panel ──────────────────────────────────────────────────────

function ProtocolBadges({ protocols }: { protocols: ProtocolStatus[] }) {
  const { t } = useLanguage();
  if (protocols.length === 0) return null;
  return (
    <div className="flex items-center gap-1.5 flex-wrap">
      {protocols.map((p) => {
        const isEnabled = p.enabled && p.available;
        const isWarning = p.enabled && !p.available;
        const colorClass = isEnabled
          ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
          : isWarning
            ? 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400 border-amber-200 dark:border-amber-800'
            : 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-500 border-gray-200 dark:border-gray-700';
        const statusLabel = isEnabled
          ? t('dmProtocolReady')
          : isWarning
            ? t('dmProtocolUnavailable')
            : t('dmProtocolDisabled');
        return (
          <Badge
            key={p.name}
            variant="outline"
            className={`text-[10px] px-1.5 py-0 border ${colorClass}`}
            title={`${p.name}: ${statusLabel} — ${p.description}`}
          >
            <span className={`inline-block h-1.5 w-1.5 rounded-full me-1 ${
              isEnabled ? 'bg-emerald-500' : isWarning ? 'bg-amber-500' : 'bg-gray-400'
            }`} />
            {p.name}
          </Badge>
        );
      })}
    </div>
  );
}

// ── Device type filter for the scanner panel ───────────────────────────

type DiscoveryTypeFilter = 'ALL' | 'TV' | 'PRINTER' | 'KIOSK' | 'PHONE' | 'ROUTER' | 'IOT' | 'APP';

const DISCOVERY_TYPE_FILTERS: { value: DiscoveryTypeFilter; labelAr: string; labelEn: string; labelFr: string; icon: typeof Globe }[] = [
  { value: 'ALL', labelAr: 'الكل', labelEn: 'All', labelFr: 'Tous', icon: Globe },
  { value: 'TV', labelAr: 'تلفزيون', labelEn: 'TV', labelFr: 'Télé', icon: Tv },
  { value: 'PRINTER', labelAr: 'طابعة', labelEn: 'Printer', labelFr: 'Imprimante', icon: Printer },
  { value: 'KIOSK', labelAr: 'كيوسك', labelEn: 'Kiosk', labelFr: 'Kiosque', icon: Tablet },
  { value: 'PHONE', labelAr: 'هاتف', labelEn: 'Phone', labelFr: 'Téléphone', icon: Smartphone },
  { value: 'ROUTER', labelAr: 'راوتر', labelEn: 'Router', labelFr: 'Routeur', icon: RouterIcon },
  { value: 'IOT', labelAr: 'IoT', labelEn: 'IoT', labelFr: 'IoT', icon: Cpu },
  { value: 'APP', labelAr: 'تطبيق', labelEn: 'App', labelFr: 'App', icon: Radio },
];

function DiscoveryTypeFilterBar({
  devices,
  value,
  onChange,
  lang,
}: {
  devices: RealDiscoveredDevice[];
  value: DiscoveryTypeFilter;
  onChange: (f: DiscoveryTypeFilter) => void;
  lang: string;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const d of devices) c[d.type] = (c[d.type] || 0) + 1;
    return c;
  }, [devices]);
  return (
    <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
      {DISCOVERY_TYPE_FILTERS.map((f) => {
        const Icon = f.icon;
        const active = value === f.value;
        const count = f.value === 'ALL' ? devices.length : (counts[f.value] || 0);
        if (f.value !== 'ALL' && count === 0) return null;
        const label = lang === 'ar' ? f.labelAr : lang === 'fr' ? f.labelFr : f.labelEn;
        return (
          <button
            key={f.value}
            onClick={() => onChange(f.value)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
              active
                ? 'bg-primary text-primary-foreground shadow-sm'
                : 'bg-muted text-muted-foreground hover:bg-muted/80'
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
            {label}
            <span className={`text-[10px] ${active ? 'bg-white/20' : 'bg-muted-foreground/20'} rounded-full px-1.5 py-0.5`}>
              {count}
            </span>
          </button>
        );
      })}
    </div>
  );
}

interface NetworkDiscoveryPanelProps {
  scanState: ScanState;
  discoveredDevices: RealDiscoveredDevice[];
  onStartScan: () => void;
  onStopScan: () => void;
  onAutoScanChange: (enabled: boolean) => void;
  onSaveTv: (device: RealDiscoveredDevice) => void;
  onCast: (device: RealDiscoveredDevice) => void;
  onSavePrinter: (device: RealDiscoveredDevice) => void;
  onTestPrinter: (device: RealDiscoveredDevice) => void;
  autoScanEnabled: boolean;
  /** Set of TV IPs the agency has already saved */
  savedTvIps: Set<string>;
  /** Saved-TV operation in flight for this device ID */
  savingTvId: string | null;
  /** Cast operation in flight for this device ID */
  castingId: string | null;
  /** Save-default-printer operation in flight for this device ID */
  savingPrinterId: string | null;
  /** IP of the agency's currently-configured default printer (null if none) */
  defaultPrinterIp: string | null;
  testingPrinterId: string | null;
  printerTestResults: Record<string, 'online' | 'offline' | 'error'>;
  onDismissDevice: (deviceId: string) => void;
  serviceAvailable: boolean;
  protocols: ProtocolStatus[];
  /** Kiosks that registered via API and are waiting for pairing */
  unpairedDevices?: UnpairedKiosk[];
  /** Currently sending pairing request to this device ID */
  pairingRequestId?: string | null;
  /** Send a pairing request to an unpaired kiosk */
  onSendPairingRequest?: (deviceId: string) => void;
}

export function NetworkDiscoveryPanel({
  scanState,
  discoveredDevices,
  onStartScan,
  onStopScan,
  onAutoScanChange,
  onSaveTv,
  onCast,
  onSavePrinter,
  onTestPrinter,
  autoScanEnabled,
  savedTvIps,
  savingTvId,
  castingId,
  savingPrinterId,
  defaultPrinterIp,
  testingPrinterId,
  printerTestResults,
  onDismissDevice,
  serviceAvailable,
  protocols,
  unpairedDevices = [],
  pairingRequestId = null,
  onSendPairingRequest,
}: NetworkDiscoveryPanelProps) {
  const { t, lang } = useLanguage();
  const [typeFilter, setTypeFilter] = useState<DiscoveryTypeFilter>('ALL');

  // Filter devices by selected type, then group by category
  const grouped = useMemo(() => {
    const groups: Record<DiscoveredDeviceCategory, RealDiscoveredDevice[]> = {
      BLASTI: [],
      NETWORK: [],
      UPNP: [],
      LOCAL: [],
    };
    for (const dev of discoveredDevices) {
      if (typeFilter !== 'ALL' && dev.type !== typeFilter) continue;
      if (groups[dev.category]) {
        groups[dev.category].push(dev);
      }
    }
    return groups;
  }, [discoveredDevices, typeFilter]);

  // Stats by type
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const dev of discoveredDevices) {
      const key = dev.type;
      counts[key] = (counts[key] || 0) + 1;
    }
    return counts;
  }, [discoveredDevices]);

  const progress = scanState.totalIPs > 0
    ? Math.round((scanState.scannedIPs / scanState.totalIPs) * 100)
    : 0;

  return (
    <motion.div variants={fadeUp} initial="hidden" animate="visible">
      <Card className={`rounded-xl overflow-hidden transition-colors ${serviceAvailable ? 'border-emerald-200/60 dark:border-emerald-900/40 bg-gradient-to-br from-emerald-50/50 via-transparent to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10' : 'border-amber-200/60 dark:border-amber-900/40 bg-gradient-to-br from-amber-50/50 via-transparent to-orange-50/30 dark:from-amber-950/20 dark:to-orange-950/10'}`}>
        <div className={`h-0.5 w-full ${serviceAvailable ? 'bg-gradient-to-r from-emerald-500 via-teal-400 to-emerald-500' : 'bg-gradient-to-r from-amber-500 via-orange-400 to-amber-500'}`} />
        <CardContent className="p-4 md:p-6 space-y-4">
          {/* ── Top Bar ── */}
          <div className="flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-xl bg-emerald-100 dark:bg-emerald-950/50 text-emerald-600 dark:text-emerald-400">
                <Radar className="h-5 w-5" />
              </div>
              <div>
                <div className="flex items-center gap-2">
                  <h2 className="text-base font-semibold">{t('dmDiscoveryTitle')}</h2>
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${serviceAvailable ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400' : 'bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400'}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${serviceAvailable ? 'bg-emerald-500' : 'bg-amber-500'}`} />
                    {serviceAvailable ? (lang === 'ar' ? 'متصل' : lang === 'fr' ? 'Connecté' : 'Connected') : (lang === 'ar' ? 'غير متصل' : lang === 'fr' ? 'Déconnecté' : 'Disconnected')}
                  </span>
                </div>
                <p className="text-xs text-muted-foreground">{t('dmDiscoverySubtitle')}</p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* Auto-scan toggle */}
              <div className="flex items-center gap-2">
                <Switch
                  id="auto-scan-new"
                  checked={autoScanEnabled}
                  onCheckedChange={onAutoScanChange}
                  className="data-[state=checked]:bg-emerald-500"
                />
                <Label htmlFor="auto-scan-new" className="text-xs text-muted-foreground cursor-pointer">
                  {t('dmAutoScan')}
                </Label>
              </div>
              {/* Protocol status badges */}
              <ProtocolBadges protocols={protocols} />
              {/* Scan button */}
              <Button
                onClick={scanState.scanning ? onStopScan : onStartScan}
                disabled={!serviceAvailable && !scanState.scanning}
                className="gap-2 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white shadow-md disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {scanState.scanning ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    {t('dmStopScan')}
                  </>
                ) : (
                  <>
                    <Radar className="h-4 w-4" />
                    {t('dmStartScan')}
                  </>
                )}
              </Button>
            </div>
          </div>

          {/* ── Radar + Phase + Progress ── */}
          <div className="flex items-center gap-6">
            <RadarAnimation active={scanState.scanning} />
            <div className="flex-1 space-y-3">
              <PhaseIndicator phase={scanState.phase} />
              {(scanState.scanning || scanState.elapsed > 0) && scanState.totalIPs > 0 && (
                <div className="space-y-1.5">
                  <Progress value={progress} className="h-1.5" />
                  <div className="flex items-center gap-3 text-[11px] text-muted-foreground">
                    <span>
                      {t('dmScanProgress').replace('{scanned}', String(scanState.scannedIPs)).replace('{total}', String(scanState.totalIPs))}
                    </span>
                    {scanState.currentSubnet && (
                      <span className="font-mono text-[10px]">({scanState.currentSubnet})</span>
                    )}
                    {scanState.elapsed > 0 && (
                      <span>{t('dmElapsed').replace('{seconds}', String(Math.round(scanState.elapsed)))}</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* ── Auto-scan indicator ── */}
          {autoScanEnabled && !scanState.scanning && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-center gap-2 rounded-lg bg-emerald-100/80 dark:bg-emerald-950/40 px-3 py-2"
            >
              <motion.span
                className="h-2 w-2 rounded-full bg-emerald-500"
                animate={{ scale: [1, 1.4, 1] }}
                transition={{ duration: 1.5, repeat: Infinity }}
              />
              <span className="text-xs text-emerald-700 dark:text-emerald-400">{t('dmAutoScanEnabled')}</span>
            </motion.div>
          )}

          {/* ── Stats bar ── */}
          {(discoveredDevices.length > 0 || unpairedDevices.length > 0) && (
            <div className="flex items-center gap-2 flex-wrap">
              {discoveredDevices.length > 0 && (
                <Badge variant="secondary" className="text-xs bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400">
                  {t('dmDevicesFound').replace('{count}', String(discoveredDevices.length))}
                </Badge>
              )}
              {unpairedDevices.length > 0 && (
                <Badge variant="secondary" className="text-xs bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400 gap-1">
                  <Smartphone className="h-3 w-3" />
                  {unpairedDevices.length} {lang === 'ar' ? 'كشك ينتظر الربط' : unpairedDevices.length === 1 ? 'kiosk waiting' : 'kiosks waiting'}
                </Badge>
              )}
              {Object.entries(typeCounts).map(([type, count]) => {
                const cfg = type !== 'UNKNOWN' ? DEVICE_TYPE_CONFIG[type as keyof typeof DEVICE_TYPE_CONFIG] : null;
                return cfg ? (
                  <Badge key={type} variant="outline" className={`text-[10px] ${cfg.color}`}>
                    {getLocalizedLabel(cfg, lang)}: {count}
                  </Badge>
                ) : null;
              })}
            </div>
          )}

          {/* ── Device type filter ── */}
          {discoveredDevices.length > 0 && (
            <DiscoveryTypeFilterBar
              devices={discoveredDevices}
              value={typeFilter}
              onChange={setTypeFilter}
              lang={lang}
            />
          )}

          {/* ── Loading skeleton ── */}
          {scanState.scanning && discoveredDevices.length === 0 && (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {[1, 2, 3].map((i) => (
                <div key={i} className="rounded-xl border bg-card p-4 space-y-3">
                  <div className="h-1 w-full bg-muted rounded" />
                  <div className="flex items-center gap-3">
                    <Skeleton className="h-8 w-8 rounded-lg" />
                    <div className="flex-1 space-y-1.5">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                    </div>
                  </div>
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-8 w-full" />
                </div>
              ))}
            </div>
          )}

          {/* ── Device Groups ── */}
          {discoveredDevices.length > 0 && (
            <motion.div
              variants={staggerContainer}
              initial="hidden"
              animate="visible"
              className="space-y-6"
            >
              <CategoryGroup
                category="BLASTI"
                devices={grouped.BLASTI}
                lang={lang}
                savingTvId={savingTvId}
                savedTvIps={savedTvIps}
                castingId={castingId}
                savingPrinterId={savingPrinterId}
                defaultPrinterIp={defaultPrinterIp}
                testingPrinterId={testingPrinterId}
                printerTestResults={printerTestResults}
                onSaveTv={onSaveTv}
                onCast={onCast}
                onSavePrinter={onSavePrinter}
                onTestPrinter={onTestPrinter}
                onDismissDevice={onDismissDevice}
              />
              <CategoryGroup
                category="NETWORK"
                devices={grouped.NETWORK}
                lang={lang}
                savingTvId={savingTvId}
                savedTvIps={savedTvIps}
                castingId={castingId}
                savingPrinterId={savingPrinterId}
                defaultPrinterIp={defaultPrinterIp}
                testingPrinterId={testingPrinterId}
                printerTestResults={printerTestResults}
                onSaveTv={onSaveTv}
                onCast={onCast}
                onSavePrinter={onSavePrinter}
                onTestPrinter={onTestPrinter}
                onDismissDevice={onDismissDevice}
              />
              <CategoryGroup
                category="UPNP"
                devices={grouped.UPNP}
                lang={lang}
                savingTvId={savingTvId}
                savedTvIps={savedTvIps}
                castingId={castingId}
                savingPrinterId={savingPrinterId}
                defaultPrinterIp={defaultPrinterIp}
                testingPrinterId={testingPrinterId}
                printerTestResults={printerTestResults}
                onSaveTv={onSaveTv}
                onCast={onCast}
                onSavePrinter={onSavePrinter}
                onTestPrinter={onTestPrinter}
                onDismissDevice={onDismissDevice}
              />
              <CategoryGroup
                category="LOCAL"
                devices={grouped.LOCAL}
                lang={lang}
                savingTvId={savingTvId}
                savedTvIps={savedTvIps}
                castingId={castingId}
                savingPrinterId={savingPrinterId}
                defaultPrinterIp={defaultPrinterIp}
                testingPrinterId={testingPrinterId}
                printerTestResults={printerTestResults}
                onSaveTv={onSaveTv}
                onCast={onCast}
                onSavePrinter={onSavePrinter}
                onTestPrinter={onTestPrinter}
                onDismissDevice={onDismissDevice}
              />
            </motion.div>
          )}

          {/* ── Unpaired Kiosks (registered via API, waiting for pairing) ── */}
          {unpairedDevices.length > 0 && onSendPairingRequest && (
            <motion.div variants={staggerItem} className="space-y-3">
              <div className="flex items-center gap-2">
                <div className="p-1.5 rounded-md bg-teal-100 text-teal-600 dark:bg-teal-950/50 dark:text-teal-400">
                  <Smartphone className="h-4 w-4" />
                </div>
                <span className="text-sm font-semibold">
                  {lang === 'ar' ? 'أجهزة كشك تنتظر الربط' : lang === 'fr' ? 'Bornes en attente de jumelage' : 'Kiosks Waiting for Pairing'}
                </span>
                <Badge variant="secondary" className="text-[10px] bg-teal-100 text-teal-700 dark:bg-teal-950/40 dark:text-teal-400">
                  {unpairedDevices.length}
                </Badge>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                <AnimatePresence>
                  {unpairedDevices.map((ud) => (
                    <UnpairedKioskCard
                      key={ud.id}
                      device={ud}
                      lang={lang}
                      isSending={pairingRequestId === ud.id}
                      onSendPairing={() => onSendPairingRequest(ud.id)}
                    />
                  ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}

          {/* ── Empty state ── */}
          {!scanState.scanning && discoveredDevices.length === 0 && unpairedDevices.length === 0 && (
            <div className="text-center py-8 space-y-3">
              <div className="mx-auto w-14 h-14 rounded-2xl bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
                <WifiOff className="h-7 w-7 text-muted-foreground" />
              </div>
              <p className="text-sm text-muted-foreground max-w-sm mx-auto">
                {!serviceAvailable
                  ? (lang === 'ar' ? 'خدمة الاكتشاف غير متاحة حالياً. تأكد من تشغيل خادم الاكتشاف.' : lang === 'fr' ? 'Le service de découverte est indisponible. Vérifiez que le serveur de découverte est en cours d\'exécution.' : 'Discovery service is currently unavailable. Make sure the discovery server is running.')
                  : t('dmDiscoveryHint')}
              </p>
              {/* When service unavailable, show which protocols would be available */}
              {!serviceAvailable && protocols.length > 0 && (
                <div className="flex items-center justify-center gap-1.5 flex-wrap max-w-md mx-auto">
                  <span className="text-xs text-muted-foreground">{t('dmProtocolsAvailable')}:</span>
                  {protocols.filter((p) => p.available).map((p) => (
                    <Badge key={p.name} variant="outline" className="text-[10px] px-1.5 py-0 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400">
                      {p.name}
                    </Badge>
                  ))}
                </div>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}