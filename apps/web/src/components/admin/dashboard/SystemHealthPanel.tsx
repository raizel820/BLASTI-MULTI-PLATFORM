'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useCallback, useRef } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useLanguage } from '@/hooks/use-language';
import {
  Activity,
  Building2,
  Database,
  Globe,
  Server,
  UserCheck,
  Users,
  Wifi,
  WifiOff,
  Clock,
  Zap,
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import type { AdminStats } from './types';

interface SystemHealthPanelProps {
  stats: AdminStats | null;
}

interface HealthData {
  status: string;
  service: string;
  version: string;
  connections: number;
  totalConnections: number;
  totalEventsEmitted: number;
  uptime: number;
  rooms: number;
}

type HealthStatus = 'healthy' | 'degraded' | 'down';

interface HealthState {
  status: HealthStatus;
  apiResponseTime: number | null;
  lastChecked: Date | null;
  dbConnected: boolean | null;
  wsConnections: number;
  serverUptime: number;
  error: string | null;
}

function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (parts.length === 0) parts.push(`${secs}s`);
  return parts.join(' ');
}

function getStatusColor(status: HealthStatus) {
  switch (status) {
    case 'healthy':
      return {
        dot: 'bg-emerald-500',
        ring: 'ring-emerald-500/20',
        bg: 'bg-emerald-50 dark:bg-emerald-900/10',
        border: 'border-emerald-200/50 dark:border-emerald-800/30',
        text: 'text-emerald-700 dark:text-emerald-400',
        badge: 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800',
        ping: 'bg-emerald-400',
        solid: 'bg-emerald-500',
      };
    case 'degraded':
      return {
        dot: 'bg-amber-500',
        ring: 'ring-amber-500/20',
        bg: 'bg-amber-50 dark:bg-amber-900/10',
        border: 'border-amber-200/50 dark:border-amber-800/30',
        text: 'text-amber-700 dark:text-amber-400',
        badge: 'bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-400 border-amber-200 dark:border-amber-800',
        ping: 'bg-amber-400',
        solid: 'bg-amber-500',
      };
    case 'down':
      return {
        dot: 'bg-red-500',
        ring: 'ring-red-500/20',
        bg: 'bg-red-50 dark:bg-red-900/10',
        border: 'border-red-200/50 dark:border-red-800/30',
        text: 'text-red-700 dark:text-red-400',
        badge: 'bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400 border-red-200 dark:border-red-800',
        ping: 'bg-red-400',
        solid: 'bg-red-500',
      };
  }
}

export function SystemHealthPanel({ stats }: SystemHealthPanelProps) {
  const { t } = useLanguage();

  const [health, setHealth] = useState<HealthState>({
    status: 'healthy',
    apiResponseTime: null,
    lastChecked: null,
    dbConnected: null,
    wsConnections: 0,
    serverUptime: 0,
    error: null,
  });

  const consecutiveFailures = useRef(0);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    const startTime = Date.now();
    try {
      const res = await apiFetch('/health?XTransformPort=3003', {
        signal: AbortSignal.timeout(5000),
      });
      const responseTime = Date.now() - startTime;

      if (!res.ok) {
        consecutiveFailures.current++;
        setHealth((prev) => ({
          ...prev,
          status: consecutiveFailures.current >= 3 ? 'down' : 'degraded',
          lastChecked: new Date(),
          error: `API returned ${res.status}`,
        }));
        return;
      }

      const data: HealthData = await res.json();
      consecutiveFailures.current = 0;

      // Determine health status
      let status: HealthStatus = 'healthy';
      if (data.status !== 'ok') {
        status = 'degraded';
      }

      setHealth({
        status,
        apiResponseTime: responseTime,
        lastChecked: new Date(),
        dbConnected: data.status === 'ok', // If API responds, DB is likely connected
        wsConnections: data.connections,
        serverUptime: data.uptime,
        error: null,
      });
    } catch (err) {
      consecutiveFailures.current++;
      setHealth((prev) => ({
        ...prev,
        status: consecutiveFailures.current >= 3 ? 'down' : 'degraded',
        lastChecked: new Date(),
        error: err instanceof Error ? err.message : 'Connection failed',
      }));
    }
  }, []);

  useEffect(() => {
    checkHealth();
    pollIntervalRef.current = setInterval(checkHealth, 30000);
    return () => {
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [checkHealth]);

  const colors = getStatusColor(health.status);
  const overallLabel =
    health.status === 'healthy'
      ? t('systemStatusOnline' as any)
      : health.status === 'degraded'
        ? t('degraded')
        : t('systemDown' as any);

  return (
    <>
      {/* System Status Live Banner */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <div className={`flex items-center gap-2.5 px-4 py-3 rounded-xl ${colors.bg} border ${colors.border}`}>
          {/* Pulsing status dot */}
          <span className="relative flex h-3 w-3">
            {health.status !== 'down' ? (
              <>
                <span className={`animate-ping absolute inline-flex h-full w-full rounded-full ${colors.ping} opacity-75`} />
                <span className={`relative inline-flex rounded-full h-3 w-3 ${colors.solid}`} />
              </>
            ) : (
              <span className="relative inline-flex rounded-full h-3 w-3 bg-red-500" />
            )}
          </span>
          <span className={`text-sm font-medium ${colors.text}`}>{t('systemUptime')}</span>
          <Badge variant="outline" className={`ms-auto text-[10px] font-medium ${colors.badge}`}>
            {overallLabel}
          </Badge>
          <div className="flex items-center gap-1 ms-2">
            {health.status !== 'down' ? (
              <Wifi className={`h-3.5 w-3.5 ${colors.text.replace('text-', 'text-').replace('700', '500')}`} />
            ) : (
              <WifiOff className="h-3.5 w-3.5 text-red-500" />
            )}
            <span className={`text-[10px] ${colors.text}`}>{overallLabel}</span>
          </div>
        </div>
      </motion.div>

      {/* System Health Panel */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <Card className="border-0 shadow-sm bg-white dark:bg-gray-900/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-900/50">
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between">
              <CardTitle className="text-base flex items-center gap-2">
                <Activity className="h-4 w-4 text-emerald-600" />
                {t('systemHealth')}
              </CardTitle>
              {health.lastChecked && (
                <span className="text-[10px] text-muted-foreground">
                  {t('lastChecked' as any)}: {health.lastChecked.toLocaleTimeString()}
                </span>
              )}
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* API Health */}
              <div className={`flex items-center gap-3 p-3 rounded-xl ${health.status === 'healthy' ? 'bg-emerald-50 dark:bg-emerald-900/10' : health.status === 'degraded' ? 'bg-amber-50 dark:bg-amber-900/10' : 'bg-red-50 dark:bg-red-900/10'}`}>
                <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm ${
                  health.status === 'healthy'
                    ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40'
                    : health.status === 'degraded'
                      ? 'bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40'
                      : 'bg-gradient-to-br from-red-200 to-red-300 dark:from-red-900/40 dark:to-red-800/40'
                }`}>
                  <Globe className={`h-4 w-4 ${
                    health.status === 'healthy' ? 'text-emerald-600 dark:text-emerald-400'
                      : health.status === 'degraded' ? 'text-amber-600 dark:text-amber-400'
                        : 'text-red-600 dark:text-red-400'
                  }`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${colors.dot}`} />
                    <span className="text-xs text-muted-foreground truncate">{t('apiHealth' as any)}</span>
                  </div>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={health.status}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className="text-sm font-bold text-foreground"
                    >
                      {health.apiResponseTime !== null
                        ? `${health.apiResponseTime}ms`
                        : health.error
                          ? t('unreachable' as any)
                          : '—'}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>

              {/* Database Status */}
              <div className={`flex items-center gap-3 p-3 rounded-xl ${
                health.dbConnected === null
                  ? 'bg-gray-50 dark:bg-gray-900/10'
                  : health.dbConnected
                    ? 'bg-emerald-50 dark:bg-emerald-900/10'
                    : 'bg-red-50 dark:bg-red-900/10'
              }`}>
                <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 shadow-sm ${
                  health.dbConnected === null
                    ? 'bg-gradient-to-br from-gray-200 to-gray-300 dark:from-gray-800/40 dark:to-gray-700/40'
                    : health.dbConnected
                      ? 'bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40'
                      : 'bg-gradient-to-br from-red-200 to-red-300 dark:from-red-900/40 dark:to-red-800/40'
                }`}>
                  <Database className={`h-4 w-4 ${
                    health.dbConnected === null
                      ? 'text-gray-500 dark:text-gray-400'
                      : health.dbConnected
                        ? 'text-emerald-600 dark:text-emerald-400'
                        : 'text-red-600 dark:text-red-400'
                  }`} />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className={`h-1.5 w-1.5 rounded-full flex-shrink-0 ${
                      health.dbConnected === null
                        ? 'bg-gray-400'
                        : health.dbConnected
                          ? 'bg-emerald-500'
                          : 'bg-red-500'
                    }`} />
                    <span className="text-xs text-muted-foreground truncate">{t('databaseStatus' as any)}</span>
                  </div>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={String(health.dbConnected)}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      className={`text-sm font-bold ${
                        health.dbConnected === null
                          ? 'text-muted-foreground'
                          : health.dbConnected
                            ? 'text-emerald-600 dark:text-emerald-400'
                            : 'text-red-600 dark:text-red-400'
                      }`}
                    >
                      {health.dbConnected === null
                        ? t('checking' as any)
                        : health.dbConnected
                          ? t('connected' as any)
                          : t('disconnected' as any)}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>

              {/* WebSocket Connections */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-teal-50 dark:bg-teal-900/10">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Zap className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-500 flex-shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{t('wsConnections' as any)}</span>
                  </div>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={health.wsConnections}
                      initial={{ opacity: 0, scale: 0.8 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.8 }}
                      className="text-sm font-bold text-foreground"
                    >
                      {health.wsConnections}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>

              {/* Server Uptime */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-sky-50 dark:bg-sky-900/10">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-sky-200 to-sky-300 dark:from-sky-900/40 dark:to-sky-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Clock className="h-4 w-4 text-sky-600 dark:text-sky-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-sky-500 flex-shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{t('serverUptime' as any)}</span>
                  </div>
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={Math.floor(health.serverUptime / 60)} // re-animate every minute
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className="text-sm font-bold text-foreground font-mono"
                    >
                      {health.serverUptime > 0 ? formatUptime(health.serverUptime) : '—'}
                    </motion.p>
                  </AnimatePresence>
                </div>
              </div>

              {/* Active Users Today */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-emerald-50 dark:bg-emerald-900/10">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <UserCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 flex-shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{t('activeUsersToday')}</span>
                  </div>
                  <p className="text-sm font-bold text-foreground">{stats?.totalUsers ?? stats?.dailyReservations ?? 0}</p>
                </div>
              </div>

              {/* Total Agencies */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-teal-50 dark:bg-teal-900/10">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Building2 className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-teal-500 flex-shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{t('totalAgencies')}</span>
                  </div>
                  <p className="text-sm font-bold text-foreground">{stats?.totalAgencies ?? 0}</p>
                </div>
              </div>

              {/* Active Queues */}
              <div className="flex items-center gap-3 p-3 rounded-xl bg-amber-50 dark:bg-amber-900/10">
                <div className="h-9 w-9 rounded-lg bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40 flex items-center justify-center flex-shrink-0 shadow-sm">
                  <Users className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-amber-500 flex-shrink-0" />
                    <span className="text-xs text-muted-foreground truncate">{t('activeQueues')}</span>
                  </div>
                  <p className="text-sm font-bold text-foreground">{stats?.activeQueues ?? 0}</p>
                </div>
              </div>
            </div>

            {/* Error message */}
            <AnimatePresence>
              {health.error && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="mt-3 px-3 py-2 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800/30"
                >
                  <p className="text-xs text-red-600 dark:text-red-400">{health.error}</p>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>
    </>
  );
}
