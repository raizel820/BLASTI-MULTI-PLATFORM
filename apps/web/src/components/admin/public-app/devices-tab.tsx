'use client';

/**
 * TAB 4 — Devices (install telemetry).
 *
 * - 5 stat cards from GET /api/app-installs/stats totals
 * - "Devices by version" table (stats.byVersion) — how many ACTIVE devices
 *   run each version
 * - 30-day install/updates timeline (pure-div bar viz, no chart lib)
 * - Full devices table (GET /api/app-installs/devices) with platform /
 *   activity / debounced-search filters
 * - Recent activity feed (stats.recentEvents) with color-coded events
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { apiFetch } from '@/lib/api-fetch';
import { useLanguage } from '@/hooks/use-language';
import { useDebounce } from '@/hooks/use-debounce';
import {
  MonitorSmartphone,
  Activity,
  CalendarClock,
  Download,
  RefreshCcw,
  Search,
  AlertTriangle,
  HardDriveDownload,
  ArrowUpCircle,
  PackageOpen,
  CircleDot,
  HeartPulse,
  Laptop,
  Smartphone,
  Apple,
  Globe,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  PLATFORM_META,
  formatDate,
  platformLabel,
  relativeTime,
  type DeviceRow,
  type InstallStats,
} from './shared';
import { INSTALLER_PLATFORMS } from '@/lib/admin-upload';

const SEARCH_DEBOUNCE_MS = 300;

/** Event color/icon palette — emerald/amber/orange/stone (no indigo/blue). */
function eventStyle(eventType: string): { icon: typeof Download; className: string } {
  switch (eventType) {
    case 'INSTALL':
      return { icon: HardDriveDownload, className: 'text-emerald-600 bg-emerald-500/10' };
    case 'UPDATE':
      return { icon: ArrowUpCircle, className: 'text-amber-600 bg-amber-500/10' };
    case 'REINSTALL':
      return { icon: PackageOpen, className: 'text-orange-600 bg-orange-500/10' };
    default:
      return { icon: HeartPulse, className: 'text-stone-500 bg-stone-500/10' };
  }
}

type EventLabelKey = 'publicAppEventInstall' | 'publicAppEventUpdate' | 'publicAppEventReinstall' | 'publicAppEventHeartbeat';

function eventLabelKey(eventType: string): EventLabelKey {
  switch (eventType) {
    case 'INSTALL':
      return 'publicAppEventInstall';
    case 'UPDATE':
      return 'publicAppEventUpdate';
    case 'REINSTALL':
      return 'publicAppEventReinstall';
    default:
      return 'publicAppEventHeartbeat';
  }
}

function platformSmallIcon(platform: string | null | undefined) {
  switch (platform) {
    case 'android':
    case 'android-debug':
      return Smartphone;
    case 'ios':
      return Apple;
    case 'electron':
    case 'windows':
      return Laptop;
    case 'mac':
      return Laptop;
    case 'linux':
      return Globe;
    default:
      return MonitorSmartphone;
  }
}

export function DevicesTab() {
  const { t, lang } = useLanguage();

  const [stats, setStats] = useState<InstallStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(true);
  const [statsError, setStatsError] = useState<string | null>(null);

  // Devices filters
  const [devices, setDevices] = useState<DeviceRow[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(true);
  const [devicesError, setDevicesError] = useState<string | null>(null);
  const [devicePlatform, setDevicePlatform] = useState('all');
  const [deviceActivity, setDeviceActivity] = useState('all');
  const [searchInput, setSearchInput] = useState('');
  const debouncedSearch = useDebounce(searchInput, SEARCH_DEBOUNCE_MS);

  const fetchStats = useCallback(async (isRefresh = false) => {
    if (!isRefresh) setStatsLoading(true);
    try {
      const res = await apiFetch('/api/app-installs/stats');
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setStats(data);
        setStatsError(null);
      } else {
        setStatsError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setStatsError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setStatsLoading(false);
    }
  }, []);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      const params = new URLSearchParams({
        platform: devicePlatform,
        activeWithin: deviceActivity,
        search: debouncedSearch.trim(),
      });
      const res = await apiFetch(`/api/app-installs/devices?${params.toString()}`);
      const data = await res.json().catch(() => null);
      if (res.ok && data?.success) {
        setDevices(data.devices || []);
        setDevicesError(null);
      } else {
        setDevicesError(data?.error || `HTTP ${res.status}`);
      }
    } catch (err) {
      setDevicesError(err instanceof Error ? err.message : 'Network error');
    } finally {
      setDevicesLoading(false);
    }
  }, [devicePlatform, deviceActivity, debouncedSearch]);

  useEffect(() => {
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    fetchDevices();
  }, [fetchDevices]);

  const totals = stats?.totals;

  const statCards = useMemo(
    () => [
      { key: 'devices', label: t('publicAppStatDevices'), value: totals?.devices ?? 0, icon: MonitorSmartphone },
      { key: 'active7', label: t('publicAppStatActive7'), value: totals?.active7d ?? 0, icon: Activity },
      { key: 'active30', label: t('publicAppStatActive30'), value: totals?.active30d ?? 0, icon: CalendarClock },
      { key: 'installs', label: t('publicAppStatInstalls'), value: totals?.installsTotal ?? 0, icon: Download },
      { key: 'updates', label: t('publicAppStatUpdates'), value: totals?.updatesTotal ?? 0, icon: RefreshCcw },
    ],
    [t, totals],
  );

  /** Max bar value for the timeline viz. */
  const timelineMax = useMemo(
    () => Math.max(1, ...(stats?.timeline || []).map((p) => p.installs + p.updates)),
    [stats],
  );

  return (
    <div className="space-y-4">
      {/* ─── Stat cards ─── */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {statsLoading &&
          statCards.map((s) => <Skeleton key={s.key} className="h-[92px] rounded-xl" aria-busy="true" />)}
        {!statsLoading &&
          statCards.map((s, idx) => {
            const Icon = s.icon;
            return (
              <motion.div
                key={s.key}
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3, delay: idx * 0.05 }}
              >
                <Card className="h-full overflow-hidden">
                  <CardContent className="p-4">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-muted-foreground leading-tight">{s.label}</span>
                      <Icon className="h-4 w-4 text-primary shrink-0" />
                    </div>
                    <p className="text-2xl font-bold mt-2 font-mono" dir="ltr">
                      {s.value.toLocaleString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US')}
                    </p>
                  </CardContent>
                </Card>
              </motion.div>
            );
          })}
      </div>

      {statsError && (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-6 text-center">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-destructive font-medium">{t('publicAppLoadFailed')}</p>
          <p className="text-xs text-muted-foreground" dir="ltr">{statsError}</p>
          <Button variant="outline" size="sm" onClick={() => fetchStats(true)}>
            {t('publicAppRetry')}
          </Button>
        </div>
      )}

      {/* ─── Devices by version + timeline ─── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('publicAppByVersionTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('publicAppByVersionDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-9 w-full" />
                <Skeleton className="h-9 w-3/4" />
              </div>
            ) : !stats || stats.byVersion.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">{t('publicAppNoVersionData')}</p>
            ) : (
              <div className="max-h-[280px] overflow-y-auto custom-scrollbar rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="text-xs">{t('publicAppColPlatform')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColVersion')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColDevices')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppStatActive7')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {stats.byVersion.map((row) => {
                      const Icon = platformSmallIcon(row.platform);
                      return (
                        <TableRow key={`${row.platform}|${row.version}`}>
                          <TableCell>
                            <div className="flex items-center gap-2 min-w-0">
                              <Icon className="h-3.5 w-3.5 text-primary shrink-0" />
                              <span className="text-xs truncate">{platformLabel(row.platform, lang)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">{row.version}</TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">{row.devices}</TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">{row.active7d}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">{t('publicAppTimelineTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('publicAppTimelineDesc')}</CardDescription>
          </CardHeader>
          <CardContent>
            {statsLoading ? (
              <Skeleton className="h-24 w-full" aria-busy="true" />
            ) : (
              <>
                <div className="flex items-end gap-[3px] h-24" role="img" aria-label={t('publicAppTimelineTitle')}>
                  {(stats?.timeline || []).map((point) => {
                    const total = point.installs + point.updates;
                    const h = total === 0 ? 2 : Math.max(6, Math.round((total / timelineMax) * 92));
                    return (
                      <Tooltip key={point.date}>
                        <TooltipTrigger asChild>
                          <div
                            className="flex-1 rounded-sm bg-primary/70 hover:bg-primary transition-colors min-w-[6px]"
                            style={{ height: `${h}px` }}
                          />
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          <p dir="ltr">{point.date}</p>
                          <p>
                            {t('publicAppStatInstalls')}: {point.installs}
                          </p>
                          <p>
                            {t('publicAppStatUpdates')}: {point.updates}
                          </p>
                        </TooltipContent>
                      </Tooltip>
                    );
                  })}
                </div>
                <div className="flex justify-between text-[10px] text-muted-foreground mt-1.5" dir="ltr">
                  <span>{stats?.timeline?.[0]?.date}</span>
                  <span>{stats?.timeline?.[stats.timeline.length - 1]?.date}</span>
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ─── Recent activity feed ─── */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t('publicAppRecentActivity')}</CardTitle>
        </CardHeader>
        <CardContent>
          {statsLoading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-8 w-full" />
              <Skeleton className="h-8 w-5/6" />
            </div>
          ) : !stats || stats.recentEvents.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-4">{t('publicAppNoActivity')}</p>
          ) : (
            <ul className="max-h-[220px] overflow-y-auto custom-scrollbar space-y-1.5 pe-1">
              {stats.recentEvents.map((event) => {
                const style = eventStyle(event.eventType);
                const Icon = style.icon;
                const PIcon = platformSmallIcon(event.platform);
                return (
                  <li key={event.id} className="flex items-center gap-2.5 rounded-md border px-2.5 py-2 min-h-[44px]">
                    <span className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${style.className}`}>
                      <Icon className="h-3.5 w-3.5" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-xs font-medium">{t(eventLabelKey(event.eventType))}</span>
                        <PIcon className="h-3 w-3 text-muted-foreground" />
                        <span className="text-xs text-muted-foreground font-mono" dir="ltr">
                          {event.version ? `v${event.version}` : ''}
                        </span>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{event.label || event.deviceId}</p>
                    </div>
                    <TooltipProvider>
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">
                            {relativeTime(event.createdAt, t)}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent className="text-xs">
                          {formatDate(event.createdAt, lang)}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ─── Devices table ─── */}
      <Card>
        <CardHeader className="space-y-3">
          <div>
            <CardTitle className="text-base">{t('publicAppDevicesTitle')}</CardTitle>
            <CardDescription className="text-xs">{t('publicAppDevicesDesc')}</CardDescription>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppFilterPlatform')}</Label>
              <Select value={devicePlatform} onValueChange={setDevicePlatform}>
                <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppFilterPlatform')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('publicAppFilterAll')}</SelectItem>
                  {INSTALLER_PLATFORMS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {platformLabel(p, lang)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppFilterActivity')}</Label>
              <Select value={deviceActivity} onValueChange={setDeviceActivity}>
                <SelectTrigger className="h-10 text-sm" aria-label={t('publicAppFilterActivity')}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">{t('publicAppActivityAll')}</SelectItem>
                  <SelectItem value="7">{t('publicAppActivity7')}</SelectItem>
                  <SelectItem value="30">{t('publicAppActivity30')}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">{t('publicAppSearchDevices')}</Label>
              <div className="relative">
                <Search className="absolute start-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  placeholder={t('publicAppSearchDevices')}
                  className="h-10 ps-8 text-sm"
                />
              </div>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {devicesError && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-5 text-center">
              <AlertTriangle className="h-6 w-6 text-destructive" />
              <p className="text-xs text-destructive font-medium" dir="ltr">{devicesError}</p>
              <Button variant="outline" size="sm" onClick={fetchDevices}>
                {t('publicAppRetry')}
              </Button>
            </div>
          )}

          {devicesLoading ? (
            <div className="space-y-2" aria-busy="true">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-2/3" />
            </div>
          ) : !devicesError && devices.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-10 text-center">
              <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center">
                <CircleDot className="h-6 w-6 text-muted-foreground" />
              </div>
              <p className="text-sm font-medium">{t('publicAppNoDevices')}</p>
              <p className="text-xs text-muted-foreground max-w-sm">{t('publicAppNoDevicesHint')}</p>
            </div>
          ) : (
            !devicesError && (
              <div className="max-h-[440px] overflow-y-auto custom-scrollbar rounded-lg border">
                <Table>
                  <TableHeader className="sticky top-0 bg-background z-10">
                    <TableRow>
                      <TableHead className="text-xs">{t('publicAppColLabel')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColPlatform')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColVersion')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColOs')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColInstalls')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColFirstSeen')}</TableHead>
                      <TableHead className="text-xs">{t('publicAppColLastActive')}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {devices.map((d) => {
                      const PIcon = platformSmallIcon(d.platform);
                      return (
                        <TableRow key={d.id}>
                          <TableCell className="max-w-[160px]">
                            <span className="text-xs font-medium truncate block" title={d.deviceId}>
                              {d.label || d.deviceId}
                            </span>
                          </TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1.5 min-w-0">
                              <PIcon className="h-3.5 w-3.5 text-primary shrink-0" />
                              <span className="text-xs truncate">{platformLabel(d.platform, lang)}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">
                            {d.appVersion ? `v${d.appVersion}` : '—'}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {d.osName ? `${d.osName}${d.osVersion ? ` ${d.osVersion}` : ''}` : '—'}
                          </TableCell>
                          <TableCell className="text-xs font-mono" dir="ltr">
                            {d.installCount ?? 0}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap">
                            {formatDate(d.firstSeenAt, lang)}
                          </TableCell>
                          <TableCell>
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="text-xs whitespace-nowrap cursor-default">
                                    {relativeTime(d.lastActiveAt, t)}
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="text-xs">
                                  {formatDate(d.lastActiveAt, lang)}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )
          )}
        </CardContent>
      </Card>
    </div>
  );
}
