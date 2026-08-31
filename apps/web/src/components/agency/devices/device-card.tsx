'use client';

import { useState, useMemo } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Monitor,
  Edit3,
  RefreshCw,
  Trash2,
  QrCode,
  Terminal,
  Eye,
  EyeOff,
  KeyRound,
  Timer,
  WifiOff,
  Search,
  XCircle,
  Radio,
  Smartphone,
  Unplug,
} from 'lucide-react';
import { useLanguage } from '@/hooks/use-language';
import {
  type AgencyDevice,
  DEVICE_TYPE_CONFIG,
  STATUS_CONFIG,
  CONNECTION_TYPE_CONFIG,
  SCREEN_LAYOUT_CONFIG,
  HeartbeatIndicator,
  ConnectionQualityBar,
  ScreenLayoutIcon,
  getHeartbeatLabel,
  formatUptime,
  isRecentlyAlive,
  getConnectionQuality,
  getLocalizedName,
  getLocalizedLabel,
  getLocalizedString,
  staggerContainer,
  staggerItem,
  fadeUp,
} from './types';

// ── Status Filter Tabs ───────────────────────────────────────────────

type StatusFilter = 'ALL' | 'ONLINE' | 'OFFLINE' | 'PAIRING' | 'DISABLED';
type TypeFilter = 'ALL' | 'TV' | 'KIOSK' | 'PRINTER' | 'DISPLAY' | 'APP';

// ── Device Card ──────────────────────────────────────────────────────

interface DeviceCardProps {
  device: AgencyDevice;
  lang: string;
  onDetail: (device: AgencyDevice) => void;
  onEdit: (device: AgencyDevice) => void;
  onPair: (device: AgencyDevice) => void;
  onDelete: (device: AgencyDevice) => void;
  onCommand: (device: AgencyDevice) => void;
  onQuickRefresh: (device: AgencyDevice) => void;
  onToggleEnable: (device: AgencyDevice) => void;
  onUnpair: (device: AgencyDevice) => void;
  onTvPreview: (device: AgencyDevice) => void;
  onKioskCredentials: (device: AgencyDevice) => void;
  index: number;
}

function DeviceCard({
  device,
  lang,
  onDetail,
  onEdit,
  onPair,
  onDelete,
  onCommand,
  onQuickRefresh,
  onToggleEnable,
  onUnpair,
  onTvPreview,
  onKioskCredentials,
  index,
}: DeviceCardProps) {
  const typeConfig = DEVICE_TYPE_CONFIG[device.type];
  const statusConfig = STATUS_CONFIG[device.status];
  const TypeIcon = typeConfig.icon;
  const connConfig = CONNECTION_TYPE_CONFIG[device.connectionType];
  const ConnIcon = connConfig.icon;
  const hb = getHeartbeatLabel(device.lastHeartbeatAt);
  const uptime = formatUptime(device.totalUptimeSec);
  const quality = getConnectionQuality(device);

  const gradientByType: Record<string, string> = {
    TV: 'bg-gradient-to-r from-emerald-500 to-teal-400',
    KIOSK: 'bg-gradient-to-r from-teal-500 to-cyan-400',
    DISPLAY: 'bg-gradient-to-r from-cyan-500 to-sky-400',
    PRINTER: 'bg-gradient-to-r from-amber-500 to-orange-400',
    APP: 'bg-gradient-to-r from-violet-500 to-purple-400',
  };

  return (
    <motion.div
      variants={staggerItem}
      custom={index}
      initial="hidden"
      animate="visible"
      whileHover={{ y: -3, scale: 1.01 }}
      transition={{ duration: 0.25 }}
    >
      <Card
        className="rounded-xl overflow-hidden hover:shadow-lg transition-all duration-200 border-border/60 cursor-pointer group"
        onClick={() => onDetail(device)}
      >
        {/* Gradient top bar */}
        <div className={`h-1.5 w-full transition-colors ${
          gradientByType[device.type] ?? 'bg-muted'
        }`} />
        <CardContent className="p-4 space-y-3">
          {/* Top row: Icon, Name, Status */}
          <div className="flex items-start gap-3">
            <div className={`p-2.5 rounded-lg ${typeConfig.color} shrink-0 shadow-sm`}>
              <TypeIcon className="h-5 w-5" />
            </div>
            <div className="flex-1 min-w-0 space-y-1">
              <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm truncate">
                  {getLocalizedName(device, lang)}
                </h3>
                {/* Pulse status indicator */}
                {isRecentlyAlive(device.lastHeartbeatAt) && (
                  <span className="relative flex h-2 w-2 shrink-0">
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full opacity-75 bg-emerald-500" />
                    <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 flex-wrap">
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${typeConfig.color}`}>
                  {getLocalizedLabel(typeConfig, lang)}
                </Badge>
                <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${statusConfig.color}`}>
                  {getLocalizedLabel(statusConfig, lang)}
                </Badge>
              </div>
            </div>
          </div>

          {/* Connection quality */}
          <ConnectionQualityBar quality={quality.quality} />

          {/* Info row */}
          <div className="space-y-1.5 text-xs text-muted-foreground">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <HeartbeatIndicator lastHeartbeatAt={device.lastHeartbeatAt} />
                <span className={hb.color}>
                  {hb.text === 'heartbeatAlive'
                    ? getLocalizedString('نشط الآن', 'En vie', 'Alive now', lang)
                    : hb.text === 'neverConnected'
                      ? getLocalizedString('لم يتصل أبداً', 'Jamais connecté', 'Never connected', lang)
                      : `${getLocalizedString('آخر ظهور', 'Vu il y a', 'Last seen', lang)} ${hb.text.split('|')[1]}`
                  }
                </span>
              </div>
            </div>
            {uptime !== '—' && (
              <div className="flex items-center gap-1.5">
                <Timer className="h-3 w-3" />
                <span>
                  {getLocalizedString('مدة التشغيل', 'Temps de fonctionnement', 'Uptime', lang)}: {uptime}
                </span>
              </div>
            )}
          </div>

          {/* Connection type + Screen Layout badges */}
          <div className="flex items-center gap-1.5 flex-wrap">
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
              <ConnIcon className="h-3 w-3" />
              {getLocalizedLabel(connConfig, lang)}
            </Badge>
            <Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-1">
              <ScreenLayoutIcon layout={device.screenLayout} className="h-3 w-3" />
              {getLocalizedLabel(SCREEN_LAYOUT_CONFIG[device.screenLayout], lang)}
            </Badge>
          </div>

          {/* Quick Actions */}
          <div className="flex items-center gap-1 pt-1 border-t border-border/40">
            {(device.type === 'TV' || device.type === 'DISPLAY') && (
              <Button
                variant="ghost"
                size="sm"
                onClick={(e) => { e.stopPropagation(); onTvPreview(device); }}
                className="h-7 gap-1.5 px-2 text-cyan-600 dark:text-cyan-400 hover:bg-cyan-50 dark:hover:bg-cyan-950/20"
              >
                <Monitor className="h-3.5 w-3.5" />
                <span className="text-[11px] font-medium">{getLocalizedString('شاشة العرض', 'Écran', 'Display', lang)}</span>
              </Button>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onEdit(device); }} className="h-7 w-7 p-0">
                  <Edit3 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{getLocalizedString('تعديل', 'Modifier', 'Edit', lang)}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onPair(device); }} className="h-7 w-7 p-0">
                  <QrCode className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{getLocalizedString('ربط', 'Associer', 'Pair', lang)}</TooltipContent>
            </Tooltip>
            {device.type === 'KIOSK' && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onKioskCredentials(device); }} className="h-7 w-7 p-0 text-amber-600 dark:text-amber-400">
                    <KeyRound className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{getLocalizedString('بيانات الكيوسك', 'Identifiants kiosque', 'Kiosk Credentials', lang)}</TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onCommand(device); }} className="h-7 w-7 p-0">
                  <Terminal className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{getLocalizedString('إرسال أمر', 'Envoyer une commande', 'Send Command', lang)}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onQuickRefresh(device); }} className="h-7 w-7 p-0">
                  <RefreshCw className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{getLocalizedString('تحديث', 'Rafraîchir', 'Refresh', lang)}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onToggleEnable(device); }} className="h-7 w-7 p-0">
                  {device.status === 'DISABLED' ? (
                    <Eye className="h-3.5 w-3.5 text-emerald-500" />
                  ) : (
                    <EyeOff className="h-3.5 w-3.5 text-red-500" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {device.status === 'DISABLED'
                  ? getLocalizedString('تفعيل', 'Activer', 'Enable', lang)
                  : getLocalizedString('تعطيل', 'Désactiver', 'Disable', lang)}
              </TooltipContent>
            </Tooltip>
            {device.status !== 'DISABLED' && device.agencyId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onUnpair(device); }} className="h-7 w-7 p-0 text-orange-500 hover:text-orange-600 hover:bg-orange-50 dark:hover:bg-orange-950/20">
                    <Unplug className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>{getLocalizedString('فك الربط', 'Dissocier', 'Unpair', lang)}</TooltipContent>
              </Tooltip>
            )}
            <div className="flex-1" />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button variant="ghost" size="sm" onClick={(e) => { e.stopPropagation(); onDelete(device); }} className="h-7 w-7 p-0 text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950/20">
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent>{getLocalizedString('حذف', 'Supprimer', 'Delete', lang)}</TooltipContent>
            </Tooltip>
          </div>
        </CardContent>
      </Card>
    </motion.div>
  );
}

// ── Filter Bar ───────────────────────────────────────────────────────

function FilterBar({
  lang,
  searchQuery,
  onSearchChange,
  typeFilter,
  onTypeFilterChange,
  statusFilter,
  onStatusFilterChange,
  devices,
}: {
  lang: string;
  searchQuery: string;
  onSearchChange: (q: string) => void;
  typeFilter: TypeFilter;
  onTypeFilterChange: (f: TypeFilter) => void;
  statusFilter: StatusFilter;
  onStatusFilterChange: (f: StatusFilter) => void;
  devices: AgencyDevice[];
}) {
  const { t } = useLanguage();

  const typeFilters: { value: TypeFilter; label: string; icon: typeof Monitor; count: number }[] = [
    { value: 'ALL', label: t('dmFilterAll'), icon: Monitor, count: devices.length },
    { value: 'TV', label: getLocalizedLabel(DEVICE_TYPE_CONFIG.TV, lang), icon: DEVICE_TYPE_CONFIG.TV.icon, count: devices.filter((d) => d.type === 'TV').length },
    { value: 'KIOSK', label: getLocalizedLabel(DEVICE_TYPE_CONFIG.KIOSK, lang), icon: DEVICE_TYPE_CONFIG.KIOSK.icon, count: devices.filter((d) => d.type === 'KIOSK').length },
    { value: 'PRINTER', label: getLocalizedLabel(DEVICE_TYPE_CONFIG.PRINTER, lang), icon: DEVICE_TYPE_CONFIG.PRINTER.icon, count: devices.filter((d) => d.type === 'PRINTER').length },
    { value: 'DISPLAY', label: getLocalizedLabel(DEVICE_TYPE_CONFIG.DISPLAY, lang), icon: DEVICE_TYPE_CONFIG.DISPLAY.icon, count: devices.filter((d) => d.type === 'DISPLAY').length },
    { value: 'APP', label: getLocalizedLabel(DEVICE_TYPE_CONFIG.APP, lang), icon: DEVICE_TYPE_CONFIG.APP.icon, count: devices.filter((d) => d.type === 'APP').length },
  ];

  const statusFilters: { value: StatusFilter; label: string; count: number; color: string }[] = [
    { value: 'ALL', label: t('dmFilterAll'), count: devices.length, color: '' },
    { value: 'ONLINE', label: t('dmFilterOnline'), count: devices.filter((d) => d.status === 'ONLINE').length, color: 'bg-emerald-500' },
    { value: 'OFFLINE', label: t('dmFilterOffline'), count: devices.filter((d) => d.status === 'OFFLINE').length, color: 'bg-gray-400' },
    { value: 'PAIRING', label: t('dmFilterPairing'), count: devices.filter((d) => d.status === 'PAIRING').length, color: 'bg-amber-500' },
    { value: 'DISABLED', label: t('dmFilterDisabled'), count: devices.filter((d) => d.status === 'DISABLED').length, color: 'bg-red-500' },
  ];

  return (
    <div className="space-y-3">
      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={searchQuery}
          onChange={(e) => onSearchChange(e.target.value)}
          placeholder={t('dmSearchDevices')}
          className="ps-9 h-9"
        />
      </div>

      {/* Type filter tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {typeFilters.map((f) => {
          const Icon = f.icon;
          const active = typeFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => onTypeFilterChange(f.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {f.label}
              <span className={`text-[10px] ${active ? 'bg-white/20' : 'bg-muted-foreground/20'} rounded-full px-1.5 py-0.5`}>
                {f.count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Status filter tabs */}
      <div className="flex items-center gap-1.5 overflow-x-auto pb-1">
        {statusFilters.map((f) => {
          const active = statusFilter === f.value;
          return (
            <button
              key={f.value}
              onClick={() => onStatusFilterChange(f.value)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-medium whitespace-nowrap transition-all ${
                active
                  ? 'bg-primary text-primary-foreground shadow-sm'
                  : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {f.color && <span className={`h-2 w-2 rounded-full ${f.color}`} />}
              {f.label}
              <span className={`text-[10px] ${active ? 'bg-white/20' : 'bg-muted-foreground/20'} rounded-full px-1.5 py-0.5`}>
                {f.count}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Device Grid Wrapper ──────────────────────────────────────────────

interface DeviceGridProps {
  devices: AgencyDevice[];
  loading: boolean;
  error: string | null;
  lang: string;
  onRetry: () => void;
  onScanNetwork: () => void;
  onDetail: (device: AgencyDevice) => void;
  onEdit: (device: AgencyDevice) => void;
  onPair: (device: AgencyDevice) => void;
  onDelete: (device: AgencyDevice) => void;
  onCommand: (device: AgencyDevice) => void;
  onQuickRefresh: (device: AgencyDevice) => void;
  onToggleEnable: (device: AgencyDevice) => void;
  onUnpair: (device: AgencyDevice) => void;
  onTvPreview: (device: AgencyDevice) => void;
  onKioskCredentials: (device: AgencyDevice) => void;
}

export function DeviceGrid({
  devices,
  loading,
  error,
  lang,
  onRetry,
  onScanNetwork,
  onDetail,
  onEdit,
  onPair,
  onDelete,
  onCommand,
  onQuickRefresh,
  onToggleEnable,
  onUnpair,
  onTvPreview,
  onKioskCredentials,
}: DeviceGridProps) {
  const { t } = useLanguage();

  const [searchQuery, setSearchQuery] = useState('');
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');

  // Filter devices
  const filteredDevices = useMemo(() => {
    let result = devices;
    if (typeFilter !== 'ALL') {
      result = result.filter((d) => d.type === typeFilter);
    }
    if (statusFilter !== 'ALL') {
      result = result.filter((d) => d.status === statusFilter);
    }
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter((d) =>
        d.name.toLowerCase().includes(q) ||
        (d.nameAr && d.nameAr.includes(q)) ||
        (d.nameFr && d.nameFr.toLowerCase().includes(q)) ||
        (d.ipAddress && d.ipAddress.includes(q)),
      );
    }
    return result;
  }, [devices, typeFilter, statusFilter, searchQuery]);

  if (loading && devices.length === 0) {
    return (
      <div className="space-y-4">
        <div className="space-y-3">
          <Skeleton className="h-9 w-64" />
          <div className="flex gap-2">
            {[1, 2, 3, 4].map((i) => (
              <Skeleton key={i} className="h-8 w-20 rounded-full" />
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <Card key={i} className="rounded-xl">
              <div className="h-1.5 w-full bg-muted" />
              <CardContent className="p-4 space-y-3">
                <div className="flex items-start gap-3">
                  <Skeleton className="h-9 w-9 rounded-lg" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-3/4" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
                <Skeleton className="h-2 w-full" />
                <div className="space-y-1.5">
                  <Skeleton className="h-3 w-2/3" />
                  <Skeleton className="h-3 w-1/2" />
                </div>
                <div className="flex gap-1 pt-1 border-t border-border/40">
                  <Skeleton className="h-7 w-7" />
                  <Skeleton className="h-7 w-7" />
                  <Skeleton className="h-7 w-7" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <Card className="rounded-xl">
        <CardContent className="p-8 text-center space-y-3">
          <XCircle className="h-10 w-10 mx-auto text-red-500" />
          <p className="text-muted-foreground">{error}</p>
          <Button variant="outline" onClick={onRetry} className="gap-1.5">
            <RefreshCw className="h-4 w-4" />
            {getLocalizedString('إعادة المحاولة', 'Réessayer', 'Retry', lang)}
          </Button>
        </CardContent>
      </Card>
    );
  }

  if (devices.length === 0) {
    return (
      <motion.div variants={fadeUp} initial="hidden" animate="visible">
        <Card className="rounded-xl border-dashed">
          <CardContent className="p-12 text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-2xl bg-emerald-50 dark:bg-emerald-950/30 flex items-center justify-center">
              <WifiOff className="h-8 w-8 text-emerald-500" />
            </div>
            <h3 className="text-lg font-semibold">
              {getLocalizedString('لا توجد أجهزة مسجلة', 'Aucun appareil enregistré', 'No Devices Registered', lang)}
            </h3>
            <p className="text-sm text-muted-foreground max-w-md mx-auto">
              {getLocalizedString(
                'ابحث في الشبكة المحلية لاكتشاف التلفزيونات والكيوسكات والطابعات المتصلة بوكالتك',
                'Recherchez sur le réseau local pour découvrir les téléviseurs, kiosques et imprimantes connectés à votre agence',
                'Scan your local network to discover TVs, kiosks, and printers connected to your agency',
                lang,
              )}
            </p>
            <div className="flex items-center justify-center gap-2 pt-2">
              <Button onClick={onScanNetwork} className="gap-1.5 bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white">
                <Radio className="h-4 w-4" />
                {getLocalizedString('بحث في الشبكة', 'Recherche réseau', 'Scan Network', lang)}
              </Button>
            </div>
          </CardContent>
        </Card>
      </motion.div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <FilterBar
        lang={lang}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        typeFilter={typeFilter}
        onTypeFilterChange={setTypeFilter}
        statusFilter={statusFilter}
        onStatusFilterChange={setStatusFilter}
        devices={devices}
      />

      {/* Grid */}
      {filteredDevices.length === 0 ? (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="text-center py-12"
        >
          <Search className="h-10 w-10 mx-auto text-muted-foreground/50 mb-3" />
          <p className="text-sm text-muted-foreground">{t('dmNoResults')}</p>
        </motion.div>
      ) : (
        <motion.div
          variants={staggerContainer}
          initial="hidden"
          animate="visible"
          className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4"
        >
          <AnimatePresence mode="popLayout">
            {filteredDevices.map((device, index) => (
              <DeviceCard
                key={device.id}
                device={device}
                lang={lang}
                onDetail={onDetail}
                onEdit={onEdit}
                onPair={onPair}
                onDelete={onDelete}
                onCommand={onCommand}
                onQuickRefresh={onQuickRefresh}
                onToggleEnable={onToggleEnable}
                onUnpair={onUnpair}
                onTvPreview={onTvPreview}
                onKioskCredentials={onKioskCredentials}
                index={index}
              />
            ))}
          </AnimatePresence>
        </motion.div>
      )}
    </div>
  );
}