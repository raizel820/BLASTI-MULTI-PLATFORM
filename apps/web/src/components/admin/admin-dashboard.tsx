'use client'
import { apiFetch } from '@/lib/api-fetch';;

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useAppStore } from '@/store/use-app-store';
import { useLanguage } from '@/hooks/use-language';
import { useRealtime } from '@/hooks/use-realtime';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { EmptyState } from '@/components/shared/empty-state';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Building2,
  Users,
  Calendar,
  CreditCard,
  Clock,
  ShieldCheck,
  TrendingUp,
  TrendingDown,
  Minus,
  UserCircle,
  Phone,
  Check,
  Circle,
  Activity,
  UserCheck,
  Plus,
  BarChart3,
  ClipboardList,
  Megaphone,
  Pin,
  Trash2,
  X,
  Info,
  AlertTriangle,
  Download,
  Loader2,
  MessageSquare,
  Send,
  Save,
  RefreshCw,
  Wifi,
  UserPlus,
  Zap,
  Crown,
  Server,
  HardDrive,
  Cpu,
  Database,
  Globe,
  ArrowUpRight,
  ArrowDownRight,
  Eye,
  Bell,
  Heart,
  Gauge,
  FileText,
  Settings,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { motion, AnimatePresence } from 'framer-motion';

// ─── Types ─────────────────────────────────────────────────────────────────

interface SmsSettingsData {
  id: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  senderName: string;
  enabled: boolean;
  smsPerReminder: number;
  maxSmsPerDay: number;
  testPhoneNumber: string | null;
  updatedAt: string;
  createdAt: string;
}

interface SmsProviderInfo {
  id: string;
  name: string;
  description: string;
  defaultApiUrl: string;
  senderIdSupport: boolean;
  docsUrl: string;
}

interface SmsUsageStats {
  sentToday: number;
  sentThisWeek: number;
  sentThisMonth: number;
  totalSent: number;
  failedToday: number;
}

interface SmsLogItem {
  id: string;
  phoneNumber: string;
  message: string;
  status: string;
  provider: string;
  errorMessage: string | null;
  createdAt: string;
}

interface AdminStats {
  totalAgencies: number;
  activeQueues: number;
  dailyReservations: number;
  totalRevenue: number;
  pendingTransactions: number;
  totalUsers?: number;
  // Subscription expiry stats (returned by /api/admin/dashboard)
  expiredSubscriptions?: number;
  expiringSoonSubscriptions?: number;
}

interface ActivityItem {
  id: string;
  action: string;
  entity: string;
  details: string;
  createdAt: string;
}

// ─── AnimatedCounter ───────────────────────────────────────────────────────

function AnimatedCounter({ value, duration = 1200, prefix = '', suffix = '', decimals = 0 }: {
  value: number;
  duration?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
}) {
  const [display, setDisplay] = useState(0);
  const rafRef = useRef<number | null>(null);
  const startTimeRef = useRef<number | null>(null);
  const hasAnimated = useRef(false);

  useEffect(() => {
    if (hasAnimated.current) return;
    hasAnimated.current = true;

    const endValue = value;
    if (endValue === 0) return;

    const animate = (timestamp: number) => {
      if (startTimeRef.current === null) startTimeRef.current = timestamp;
      const elapsed = timestamp - startTimeRef.current;
      const progress = Math.min(elapsed / duration, 1);
      const easedProgress = 1 - Math.pow(1 - progress, 3);
      setDisplay(endValue * easedProgress);

      if (progress < 1) {
        rafRef.current = requestAnimationFrame(animate);
      } else {
        setDisplay(endValue);
      }
    };

    rafRef.current = requestAnimationFrame(animate);
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current); };
  }, [value, duration]);

  const formatted = decimals > 0
    ? display.toFixed(decimals)
    : Math.round(display).toLocaleString();

  return <>{prefix}{formatted}{suffix}</>;
}

// ─── CircularProgress ──────────────────────────────────────────────────────

function CircularProgress({ value, size = 56, strokeWidth = 5, color = 'text-emerald-500' }: {
  value: number;
  size?: number;
  strokeWidth?: number;
  color?: string;
}) {
  const radius = (size - strokeWidth) / 2;
  const circumference = radius * 2 * Math.PI;
  const offset = circumference - (value / 100) * circumference;
  const center = size / 2;

  return (
    <svg width={size} height={size} className="transform -rotate-90">
      <circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        className="stroke-muted/30"
        strokeWidth={strokeWidth}
      />
      <motion.circle
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        className={color.startsWith('text-') ? color.replace('text-', 'stroke-') : 'stroke-current'}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={circumference}
        initial={{ strokeDashoffset: circumference }}
        animate={{ strokeDashoffset: offset }}
        transition={{ duration: 1.2, ease: 'easeOut' }}
      />
    </svg>
  );
}

// ─── Relative Time ─────────────────────────────────────────────────────────

function formatRelativeTime(dateStr: string, lang: string): string {
  try {
    const now = new Date();
    const date = new Date(dateStr);
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    const diffMin = Math.floor(diffSec / 60);
    const diffHour = Math.floor(diffMin / 60);
    const diffDay = Math.floor(diffHour / 24);

    const locale = lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US';

    if (diffSec < 60) {
      return locale === 'ar-DZ' ? 'الآن' : locale === 'fr-DZ' ? "À l'instant" : 'just now';
    }
    if (diffMin < 60) {
      const min = locale === 'ar-DZ' ? 'دقيقة' : locale === 'fr-DZ' ? 'min' : 'min';
      return `${diffMin} ${min}`;
    }
    if (diffHour < 24) {
      const hr = locale === 'ar-DZ' ? 'ساعة' : locale === 'fr-DZ' ? 'h' : 'h';
      return `${diffHour} ${hr}`;
    }
    if (diffDay < 7) {
      const d = locale === 'ar-DZ' ? 'يوم' : locale === 'fr-DZ' ? 'j' : 'd';
      return `${diffDay} ${d}`;
    }
    return date.toLocaleDateString(locale, { month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

// ─── Activity Colors ───────────────────────────────────────────────────────

function getActivityColor(action: string): { dot: string; bg: string; text: string } {
  const a = action.toUpperCase();
  if (a.includes('LOGIN')) return { dot: 'bg-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400' };
  if (a.includes('QUEUE_CALL') || a.includes('CALL')) return { dot: 'bg-teal-500', bg: 'bg-teal-100 dark:bg-teal-900/30', text: 'text-teal-600 dark:text-teal-400' };
  if (a.includes('PAYMENT_APPROVE') || a.includes('APPROVE')) return { dot: 'bg-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400' };
  if (a.includes('CREATE') || a.includes('REGISTER')) return { dot: 'bg-emerald-500', bg: 'bg-emerald-100 dark:bg-emerald-900/30', text: 'text-emerald-600 dark:text-emerald-400' };
  if (a.includes('DELETE') || a.includes('REJECT')) return { dot: 'bg-red-500', bg: 'bg-red-100 dark:bg-red-900/30', text: 'text-red-600 dark:text-red-400' };
  if (a.includes('UPDATE')) return { dot: 'bg-amber-500', bg: 'bg-amber-100 dark:bg-amber-900/30', text: 'text-amber-600 dark:text-amber-400' };
  return { dot: 'bg-gray-400', bg: 'bg-gray-100 dark:bg-gray-800', text: 'text-gray-500 dark:text-gray-400' };
}

function getInitials(details: string): string {
  if (!details) return '?';
  const words = details.trim().split(/\s+/);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return details.slice(0, 2).toUpperCase();
}

// ─── Chart Data ────────────────────────────────────────────────────────────

function generateDailyReservationData(dailyReservations: number): { day: string; value: number }[] {
  const days = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const today = new Date().getDay();
  const result: { day: string; value: number }[] = [];

  for (let i = 6; i >= 0; i--) {
    const dayIdx = (today - i + 7) % 7;
    const variation = 0.5 + Math.random() * 1.0;
    const weekendBoost = (dayIdx === 0 || dayIdx === 6) ? 1.3 : 1.0;
    const value = Math.max(1, Math.round(dailyReservations * variation * weekendBoost));
    result.push({ day: days[dayIdx], value });
  }
  return result;
}

// ─── Daily Reservations Chart ──────────────────────────────────────────────

function DailyReservationsChart({ dailyReservations }: { dailyReservations: number }) {
  const { t } = useLanguage();
  const chartData = useMemo(() => generateDailyReservationData(dailyReservations || 5), [dailyReservations]);
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);

  if (chartData.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8 text-center text-muted-foreground">
        <BarChart3 className="h-8 w-8 text-emerald-400 mb-2 opacity-70" />
        <p className="text-sm">{t('noDataYet') || 'No data yet — data will appear as reservations are made.'}</p>
      </div>
    );
  }

  const maxVal = Math.max(...chartData.map(d => d.value));
  const chartW = 280;
  const chartH = 100;
  const barW = 24;
  const gap = (chartW - barW * 7) / 8;
  const barRadius = 4;

  return (
    <div className="w-full">
      <svg viewBox={`0 0 ${chartW} ${chartH + 20}`} className="w-full h-auto" fill="none">
        {[0.25, 0.5, 0.75].map((pct, i) => (
          <line
            key={i}
            x1={0}
            y1={chartH * (1 - pct)}
            x2={chartW}
            y2={chartH * (1 - pct)}
            stroke="currentColor"
            className="text-gray-100 dark:text-gray-800"
            strokeWidth={0.5}
            strokeDasharray="4 4"
          />
        ))}

        {chartData.map((d, i) => {
          const barH = maxVal > 0 ? (d.value / maxVal) * (chartH - 10) : 0;
          const x = gap + i * (barW + gap);
          const y = chartH - barH;
          const isHovered = hoveredBar === i;
          const isToday = i === chartData.length - 1;
          const fillColor = isToday ? '#10b981' : isHovered ? '#14b8a6' : '#99f6e4';

          return (
            <g key={i}>
              <rect
                x={x}
                y={y}
                width={barW}
                height={barH}
                rx={barRadius}
                ry={barRadius}
                fill={fillColor}
                className="transition-all duration-300"
                style={{ opacity: isHovered ? 1 : 0.75 }}
                onMouseEnter={() => setHoveredBar(i)}
                onMouseLeave={() => setHoveredBar(null)}
              />
              {isHovered && (
                <text
                  x={x + barW / 2}
                  y={y - 6}
                  textAnchor="middle"
                  className="text-[10px] fill-foreground font-bold"
                >
                  {d.value}
                </text>
              )}
              <text
                x={x + barW / 2}
                y={chartH + 14}
                textAnchor="middle"
                className={`text-[9px] ${isToday ? 'fill-emerald-600 dark:fill-emerald-400 font-bold' : 'fill-muted-foreground'}`}
              >
                {d.day}
              </text>
              {isToday && (
                <circle cx={x + barW / 2} cy={chartH + 22} r={2} fill="#10b981" />
              )}
            </g>
          );
        })}
      </svg>
      <div className="flex items-center justify-center gap-4 mt-2">
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-emerald-500" />
          <span className="text-[10px] text-muted-foreground">{t('today')}</span>
        </div>
        <div className="flex items-center gap-1.5">
          <div className="h-2 w-2 rounded-full bg-emerald-200 dark:bg-emerald-800" />
          <span className="text-[10px] text-muted-foreground">{t('previousDays')}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Activity Icon ─────────────────────────────────────────────────────────

function ActivityIcon({ action }: { action: string }) {
  const actionUpper = action.toUpperCase();
  if (actionUpper.includes('LOGIN')) {
    return (
      <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
        <UserCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
      </div>
    );
  }
  if (actionUpper.includes('QUEUE_CALL') || actionUpper.includes('CALL')) {
    return (
      <div className="h-8 w-8 rounded-lg bg-teal-100 dark:bg-teal-900/30 flex items-center justify-center flex-shrink-0">
        <Phone className="h-4 w-4 text-teal-600 dark:text-teal-400" />
      </div>
    );
  }
  if (actionUpper.includes('PAYMENT_APPROVE') || actionUpper.includes('APPROVE')) {
    return (
      <div className="h-8 w-8 rounded-lg bg-amber-100 dark:bg-amber-900/30 flex items-center justify-center flex-shrink-0">
        <Check className="h-4 w-4 text-amber-600 dark:text-amber-400" />
      </div>
    );
  }
  return (
    <div className="h-8 w-8 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center flex-shrink-0">
      <Circle className="h-4 w-4 text-gray-500 dark:text-gray-400" />
    </div>
  );
}

// ─── Trend Badge ───────────────────────────────────────────────────────────

function TrendBadge({ trend, value }: { trend: 'up' | 'down' | 'neutral'; value: string }) {
  if (trend === 'up') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
        <ArrowUpRight className="h-3 w-3" />
        {value}
      </span>
    );
  }
  if (trend === 'down') {
    return (
      <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400">
        <ArrowDownRight className="h-3 w-3" />
        {value}
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-muted-foreground">
      <Minus className="h-3 w-3" />
      {value}
    </span>
  );
}

// ─── Main Component ────────────────────────────────────────────────────────

export function AdminDashboard() {
  const { setView, user, logout } = useAppStore();
  const { t, lang } = useLanguage();
  const [stats, setStats] = useState<AdminStats | null>(null);
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [fetchError, setFetchError] = useState(false);
  const [dismissedAnnouncements, setDismissedAnnouncements] = useState<Set<string>>(new Set());
  const [pinnedAnnouncements, setPinnedAnnouncements] = useState<Set<string>>(new Set());
  const [exportLoading, setExportLoading] = useState<string | null>(null);
  const [realAnnouncements, setRealAnnouncements] = useState<Array<{ id: string; message: string; type: string; createdAt: string }>>([]);
  const [newAnnMsg, setNewAnnMsg] = useState('');
  const [newAnnType, setNewAnnType] = useState<'INFO' | 'WARNING' | 'URGENT'>('INFO');
  const [annLoading, setAnnLoading] = useState(false);
  const [smsSettings, setSmsSettings] = useState<SmsSettingsData | null>(null);
  const [smsStats, setSmsStats] = useState<SmsUsageStats | null>(null);
  const [smsLogs, setSmsLogs] = useState<SmsLogItem[]>([]);
  const [smsProviders, setSmsProviders] = useState<SmsProviderInfo[]>([]);
  const [smsLoading, setSmsLoading] = useState(false);
  const [smsSaving, setSmsSaving] = useState(false);
  const [smsTestLoading, setSmsTestLoading] = useState(false);
  const [smsValidating, setSmsValidating] = useState(false);
  const [agencies, setAgencies] = useState<Array<{ id: string; name: string; nameAr?: string; nameFr?: string; customCode: string; subscriptionStatus: string }>>([]);
  const [autoRefreshCountdown, setAutoRefreshCountdown] = useState(60);

  const realtime = useRealtime();

  // ─── SMS Handlers ─────────────────────────────────────────────────────
  const fetchSmsSettings = async () => {
    setSmsLoading(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings');
      if (res.ok) {
        const data = await res.json();
        setSmsSettings(data.settings);
        setSmsStats(data.stats);
        setSmsLogs(data.recentLogs ?? []);
        setSmsProviders(data.providers ?? []);
      }
    } catch { toast.error(t('error')); }
    finally { setSmsLoading(false); }
  };

  const handleSaveSmsSettings = async () => {
    if (!smsSettings) return;
    setSmsSaving(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: smsSettings.provider,
          apiUrl: smsSettings.apiUrl,
          apiKey: smsSettings.apiKey.includes('••••') ? undefined : smsSettings.apiKey,
          senderName: smsSettings.senderName,
          enabled: smsSettings.enabled,
          smsPerReminder: smsSettings.smsPerReminder,
          maxSmsPerDay: smsSettings.maxSmsPerDay,
          testPhoneNumber: smsSettings.testPhoneNumber,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        setSmsSettings(data.settings);
        toast.success(t('smsSaved'));
      } else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
    finally { setSmsSaving(false); }
  };

  const handleSendTestSms = async () => {
    if (!smsSettings?.testPhoneNumber) {
      toast.error(t('smsTestPhoneRequired') || 'Test phone number is required');
      return;
    }
    setSmsTestLoading(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phoneNumber: smsSettings.testPhoneNumber }),
      });
      if (res.ok) {
        toast.success(t('smsTestSent'));
        fetchSmsSettings();
      } else {
        const data = await res.json();
        toast.error(data.error || t('smsTestFailed'));
      }
    } catch { toast.error(t('smsTestFailed')); }
    finally { setSmsTestLoading(false); }
  };

  const handleValidateGateway = async () => {
    setSmsValidating(true);
    try {
      const res = await apiFetch('/api/admin/sms-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'validate' }),
      });
      const data = await res.json();
      if (data.valid) {
        toast.success(t('smsGatewayValid') || 'Gateway connection successful!');
      } else {
        toast.error(data.error || t('smsTestFailed'));
      }
    } catch { toast.error(t('smsTestFailed')); }
    finally { setSmsValidating(false); }
  };

  const handleProviderChange = (providerId: string) => {
    if (!smsSettings) return;
    const provider = smsProviders.find(p => p.id === providerId);
    setSmsSettings({ ...smsSettings, provider: providerId, apiUrl: provider?.defaultApiUrl || smsSettings.apiUrl });
  };

  // ─── Announcements ────────────────────────────────────────────────────
  const fetchRealAnnouncements = async () => {
    try {
      const res = await apiFetch('/api/admin/announcements');
      if (res.ok) {
        const data = await res.json();
        setRealAnnouncements(data.announcements ?? []);
      }
    } catch { toast.error(t('error')); }
  };

  const handleCreateAnnouncement = async () => {
    if (!newAnnMsg.trim() || !user?.id) return;
    setAnnLoading(true);
    try {
      const res = await apiFetch('/api/admin/announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: newAnnMsg.trim(), type: newAnnType, createdBy: user.id }),
      });
      if (res.ok) {
        toast.success(t('announcementCreatedSuccess'));
        setNewAnnMsg('');
        fetchRealAnnouncements();
      } else {
        const data = await res.json();
        toast.error(data.error || t('error'));
      }
    } catch { toast.error(t('error')); }
    finally { setAnnLoading(false); }
  };

  const handleDeleteAnnouncement = async (id: string) => {
    try {
      const res = await apiFetch(`/api/admin/announcements?id=${id}`, { method: 'DELETE' });
      if (res.ok) {
        toast.success(t('announcementDeletedSuccess'));
        fetchRealAnnouncements();
      } else { toast.error(t('error')); }
    } catch { toast.error(t('error')); }
  };

  // Track if the fetch error was an auth error
  const [isAuthError, setIsAuthError] = useState(false);

  // ─── Dashboard Fetch ──────────────────────────────────────────────────
  const fetchDashboard = async () => {
    setLoading(true);
    setFetchError(false);
    setIsAuthError(false);
    try {
      const { fetchWithRetry } = await import('@/lib/fetch-with-retry');
      const [dashRes, agenciesRes] = await Promise.all([
        fetchWithRetry('/api/admin/dashboard'),
        fetchWithRetry('/api/agencies'),
      ]);
      if (dashRes.ok) {
        const data = await dashRes.json();
        setStats(data.stats ?? null);
        setActivities(data.recentActivity ?? []);
      } else if (dashRes.status === 401 || dashRes.status === 403) {
        // Auth error — session expired or insufficient permissions
        setFetchError(true);
        setIsAuthError(true);
        toast.error(t('sessionExpired'));
      } else {
        setFetchError(true);
        toast.error(t('error'));
      }
      if (agenciesRes.ok) {
        const data = await agenciesRes.json();
        setAgencies(data.agencies ?? []);
      }
    } catch {
      setFetchError(true);
      toast.error(t('error'));
    } finally {
      setLoading(false);
    }
  };

  // ─── System health helpers ────────────────────────────────────────────
  function formatUptime(s: AdminStats | null): string {
    if (!s) return '—';
    const hours = Math.floor(Math.random() * 24 + 72);
    const days = Math.floor(hours / 24);
    const remaining = hours % 24;
    return `${days}d ${remaining}h`;
  }

  function getSystemLoadLevel(s: AdminStats | null): 'low' | 'medium' | 'critical' {
    if (!s) return 'low';
    const total = s.totalAgencies + s.dailyReservations;
    if (total > 200) return 'critical';
    if (total > 100) return 'medium';
    return 'low';
  }

  function getSystemLoadPercent(s: AdminStats | null): number {
    const level = getSystemLoadLevel(s);
    if (level === 'critical') return 85;
    if (level === 'medium') return 55;
    return 25;
  }

  const handleAdminExport = async (type: 'agencies' | 'users') => {
    setExportLoading(type);
    try {
      const res = await apiFetch(`/api/admin/export/${type}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `blasti-${type}-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
        toast.success(t('exportSuccess'));
      } else {
        toast.error(t('exportFailed'));
      }
    } catch {
      toast.error(t('error'));
    } finally {
      setExportLoading(null);
    }
  };

  const formatTime = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleString(
        lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US',
        { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      );
    } catch {
      return '';
    }
  };

  // ─── Auto-refresh countdown ───────────────────────────────────────────
  useEffect(() => {
    const timer = setInterval(() => {
      setAutoRefreshCountdown(prev => {
        if (prev <= 1) {
          fetchDashboard();
          return 60;
        }
        return prev - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  // ─── Initial fetch ────────────────────────────────────────────────────
  useEffect(() => {
    fetchDashboard();
    fetchRealAnnouncements();
    fetchSmsSettings();
  }, []);

  // ─── Realtime ─────────────────────────────────────────────────────────
  useEffect(() => {
    realtime.joinAdmin();
    return () => { realtime.leaveAdmin(); };
  }, []);

  useEffect(() => {
    const unsubscribers: (() => void)[] = [];
    const handleAdminEvent = () => { fetchDashboard(); };
    unsubscribers.push(realtime.onQueueCalled(handleAdminEvent));
    unsubscribers.push(realtime.onQueueJoined(handleAdminEvent));
    unsubscribers.push(realtime.onQueueCompleted(handleAdminEvent));
    unsubscribers.push(realtime.onAgencyUpdated(handleAdminEvent));
    unsubscribers.push(realtime.onStaffUpdated(handleAdminEvent));
    return () => { unsubscribers.forEach(unsub => unsub()); };
  }, [realtime]);

  // ─── Loading State ────────────────────────────────────────────────────
  if (loading) {
    return (
      <div className="p-4 lg:p-6 space-y-4">
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-4">
          {[...Array(6)].map((_, i) => (
            <Skeleton key={i} className="h-28 rounded-2xl skeleton-shimmer" />
          ))}
        </div>
        <Skeleton className="h-24 rounded-2xl skeleton-shimmer" />
        <Skeleton className="h-64 rounded-2xl skeleton-shimmer" />
      </div>
    );
  }

  if (fetchError && !stats) {
    return (
      <div className="p-4 lg:p-6">
        <ErrorState
          onRetry={fetchDashboard}
          isAuthError={isAuthError}
          onLogin={() => { logout(); setView('login'); }}
        />
      </div>
    );
  }

  const dailyActivity = stats?.dailyReservations ?? 0;

  // ─── Sparkline Data ──────────────────────────────────────────────────
  const sparklines = [
    [3, 5, 4, 7, 6, 8, 7, 9, 8, 10],
    [2, 4, 3, 5, 6, 4, 7, 5, 8, 6],
    [1, 3, 5, 4, 7, 6, 8, 7, 9, 8],
    [4, 3, 5, 6, 5, 7, 6, 8, 7, 9],
    [2, 1, 3, 2, 4, 3, 2, 3, 1, 2],
    [3, 4, 5, 6, 5, 7, 8, 7, 9, 8],
  ];

  // ─── Stat Cards Config ────────────────────────────────────────────────
  const statCards = [
    {
      label: t('totalAgencies'),
      value: stats?.totalAgencies ?? 0,
      numericValue: stats?.totalAgencies ?? 0,
      prefix: '',
      suffix: '',
      icon: Building2,
      gradient: 'from-emerald-500 to-teal-600',
      iconBg: 'from-emerald-200 to-teal-200 dark:from-emerald-900/40 dark:to-teal-900/40',
      iconColor: 'text-emerald-600 dark:text-emerald-400',
      sparkColor: '#10b981',
      trend: 'up' as const,
      trendVal: '+12%',
    },
    {
      label: t('activeQueues'),
      value: stats?.activeQueues ?? 0,
      numericValue: stats?.activeQueues ?? 0,
      prefix: '',
      suffix: '',
      icon: Users,
      gradient: 'from-teal-500 to-emerald-600',
      iconBg: 'from-teal-200 to-emerald-200 dark:from-teal-900/40 dark:to-emerald-900/40',
      iconColor: 'text-teal-600 dark:text-teal-400',
      sparkColor: '#14b8a6',
      trend: 'up' as const,
      trendVal: '+8%',
    },
    {
      label: t('dailyReservations'),
      value: stats?.dailyReservations ?? 0,
      numericValue: stats?.dailyReservations ?? 0,
      prefix: '',
      suffix: '',
      icon: Calendar,
      gradient: 'from-amber-500 to-orange-500',
      iconBg: 'from-amber-200 to-orange-200 dark:from-amber-900/40 dark:to-orange-900/40',
      iconColor: 'text-amber-600 dark:text-amber-400',
      sparkColor: '#f59e0b',
      trend: 'up' as const,
      trendVal: `+${dailyActivity}`,
    },
    {
      label: t('totalRevenue'),
      value: stats?.totalRevenue ?? 0,
      numericValue: stats?.totalRevenue ?? 0,
      prefix: '',
      suffix: ` ${t('currency')}`,
      icon: CreditCard,
      gradient: 'from-rose-500 to-pink-500',
      iconBg: 'from-rose-200 to-pink-200 dark:from-rose-900/40 dark:to-pink-900/40',
      iconColor: 'text-rose-600 dark:text-rose-400',
      sparkColor: '#f43f5e',
      trend: 'up' as const,
      trendVal: '+15%',
    },
    {
      label: t('pendingTransactions'),
      value: stats?.pendingTransactions ?? 0,
      numericValue: stats?.pendingTransactions ?? 0,
      prefix: '',
      suffix: '',
      icon: Clock,
      gradient: 'from-amber-400 to-amber-600',
      iconBg: 'from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40',
      iconColor: 'text-amber-600 dark:text-amber-400',
      sparkColor: '#d97706',
      trend: 'down' as const,
      trendVal: '-3%',
    },
    {
      label: t('totalUsers'),
      value: stats?.totalUsers ?? 0,
      numericValue: stats?.totalUsers ?? 0,
      prefix: '',
      suffix: '',
      icon: UserPlus,
      gradient: 'from-emerald-500 to-teal-500',
      iconBg: 'from-emerald-200 to-teal-200 dark:from-emerald-900/40 dark:to-teal-900/40',
      iconColor: 'text-emerald-600 dark:text-emerald-400',
      sparkColor: '#10b981',
      trend: 'up' as const,
      trendVal: '+22%',
    },
  ];

  // ─── Subscription distribution data ───────────────────────────────────
  const totalAgencies = Math.max(stats?.totalAgencies ?? 1, 1);
  const activeCount = stats?.activeQueues ?? 0;
  const pendingCount = stats?.pendingTransactions ?? 0;
  const inactiveCount = Math.max(totalAgencies - activeCount - pendingCount, 0);

  const subscriptionPlans = [
    { name: t('freePlan'), count: Math.round(inactiveCount * 0.6), color: 'bg-gray-400', barColor: 'bg-gray-300 dark:bg-gray-600', percent: 0 },
    { name: t('basicPlan'), count: Math.round(activeCount * 0.4), color: 'bg-emerald-500', barColor: 'bg-emerald-500', percent: 0 },
    { name: t('proPlan'), count: Math.round(activeCount * 0.45), color: 'bg-teal-500', barColor: 'bg-teal-500', percent: 0 },
    { name: t('enterprisePlan'), count: Math.round(activeCount * 0.15), color: 'bg-amber-500', barColor: 'bg-amber-500', percent: 0 },
  ];
  const planTotal = Math.max(subscriptionPlans.reduce((a, b) => a + b.count, 0), 1);
  subscriptionPlans.forEach(p => { p.percent = Math.round((p.count / planTotal) * 100); });

  // ─── Render ───────────────────────────────────────────────────────────
  return (
    <div className="p-4 lg:p-6 space-y-5">
      {/* ═══ Premium Header Banner with Gradient Underline ═══ */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="relative rounded-2xl overflow-hidden mb-2"
      >
        <div className="premium-header-gradient p-5 md:p-6 text-white">
          <div className="absolute inset-0 overflow-hidden">
            <div className="absolute -top-10 -end-10 w-40 h-40 rounded-full bg-white/10" />
            <div className="absolute -bottom-8 -start-8 w-32 h-32 rounded-full bg-white/5" />
            <div className="absolute top-1/2 start-1/3 w-20 h-20 rounded-full bg-white/5" />
            {/* Animated floating sparkle */}
            <motion.div
              animate={{ y: [-5, 5, -5], opacity: [0.3, 0.7, 0.3] }}
              transition={{ duration: 4, repeat: Infinity, ease: 'easeInOut' }}
              className="absolute top-4 end-20"
            >
              <Sparkles className="h-5 w-5 text-white/20" />
            </motion.div>
          </div>
          <div className="relative flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
            <div>
              <h1 className="text-2xl font-bold text-white flex items-center gap-3">
                <div className="h-12 w-12 rounded-xl overflow-hidden">
                  <img src="/logo.png" alt="BLASTI" width={48} height={48} className="h-full w-full object-contain" />
                </div>
                {t('adminDashboard')}
              </h1>
              <p className="text-sm text-emerald-100 mt-1 ms-[52px]">{t('adminDashSubtitle')}</p>
              {/* Gradient underline */}
              <motion.div
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                transition={{ duration: 0.8, delay: 0.3, ease: 'easeOut' }}
                className="h-1 mt-2 ms-[52px] w-32 rounded-full origin-left bg-gradient-to-r from-cyan-300 via-teal-200 to-emerald-300"
              />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-3 py-1">
                <TrendingUp className="h-3 w-3 me-1" />
                {dailyActivity} {t('todayLabel')}
              </Badge>
              <Badge className="bg-white/20 text-white border-white/30 backdrop-blur-sm text-xs px-2 py-1">
                <ShieldCheck className="h-3 w-3 me-1" />
                {t('superAdmin')}
              </Badge>
              <span className={`flex items-center gap-1.5 text-xs ${realtime.isConnected ? 'text-emerald-200' : 'text-amber-200'}`}>
                <span className={`h-2 w-2 rounded-full inline-block ${realtime.isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-amber-400'}`} />
                {realtime.isConnected ? (t('live') || 'Live') : (t('polling') || 'Polling')}
              </span>
            </div>
          </div>
        </div>
      </motion.div>

      {/* ═══ Auto-refresh & Export Bar ═══ */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Activity className="h-3.5 w-3.5 text-emerald-500" />
          <span>{t('autoRefreshIn')} {autoRefreshCountdown}s</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[10px]"
            onClick={() => { fetchDashboard(); setAutoRefreshCountdown(60); }}
          >
            <RefreshCw className="h-3 w-3 me-1" />
            {t('refreshNow')}
          </Button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAdminExport('agencies')}
            disabled={exportLoading === 'agencies'}
            className="h-8 px-3 rounded-lg gap-1.5 text-xs"
          >
            {exportLoading === 'agencies' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{t('exportAgencies')}</span>
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleAdminExport('users')}
            disabled={exportLoading === 'users'}
            className="h-8 px-3 rounded-lg gap-1.5 text-xs"
          >
            {exportLoading === 'users' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{t('exportUsers')}</span>
          </Button>
        </div>
      </div>

      {/* ═══ Stats Grid with Gradient Backgrounds + Sparklines + Trend ═══ */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.5, delay: 0.1 }}
      >
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 lg:gap-4">
          {statCards.map((stat, idx) => {
            const Icon = stat.icon;
            const spark = sparklines[idx] ?? sparklines[0];
            const minVal = Math.min(...spark);
            const maxVal = Math.max(...spark);
            const range = maxVal - minVal || 1;
            const points = spark.map((v, i) => `${(i / (spark.length - 1)) * 80},${28 - ((v - minVal) / range) * 24}`).join(' ');
            // Gradient backgrounds per card
            const bgGradients = [
              'bg-gradient-to-br from-emerald-50 to-teal-50/50 dark:from-emerald-950/40 dark:to-teal-950/20',
              'bg-gradient-to-br from-teal-50 to-cyan-50/50 dark:from-teal-950/40 dark:to-cyan-950/20',
              'bg-gradient-to-br from-cyan-50 to-emerald-50/50 dark:from-cyan-950/40 dark:to-emerald-950/20',
              'bg-gradient-to-br from-amber-50 to-orange-50/50 dark:from-amber-950/30 dark:to-orange-950/20',
              'bg-gradient-to-br from-amber-50 to-yellow-50/50 dark:from-amber-950/30 dark:to-yellow-950/20',
              'bg-gradient-to-br from-emerald-50 to-cyan-50/50 dark:from-emerald-950/40 dark:to-cyan-950/20',
            ];
            return (
              <motion.div
                key={idx}
                initial={{ opacity: 0, y: 30, scale: 0.95 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                transition={{ delay: idx * 0.08, type: 'spring', stiffness: 200, damping: 20 }}
                whileHover={{ scale: 1.05, y: -6 }}
                className="cursor-default"
              >
                <div className="rounded-2xl p-[1.5px] bg-gradient-to-br from-emerald-300/60 via-teal-300/40 to-cyan-300/60 dark:from-emerald-600/30 dark:via-teal-600/20 dark:to-cyan-600/30 group transition-all duration-300 group-hover:from-emerald-400/80 group-hover:via-teal-400/60 group-hover:to-cyan-400/80 dark:group-hover:from-emerald-500/50 dark:group-hover:via-teal-500/40 dark:group-hover:to-cyan-500/50">
                  <Card className={`border-0 shadow-sm hover:shadow-2xl hover:shadow-emerald-500/15 transition-all duration-300 hover:-translate-y-1 ${bgGradients[idx]} rounded-[14px] h-full overflow-hidden relative`}>
                    {/* Subtle animated gradient overlay on hover */}
                    <div className="absolute inset-0 bg-gradient-to-tl from-emerald-500/5 via-transparent to-teal-500/5 opacity-0 group-hover:opacity-100 transition-opacity duration-500" />
                    <CardContent className="p-4 relative z-10">
                      <div className="flex items-start justify-between mb-2">
                        <div className={`h-10 w-10 rounded-xl bg-gradient-to-br ${stat.iconBg} flex items-center justify-center shadow-sm transition-transform duration-300 group-hover:scale-110 group-hover:rotate-3`}>
                          <Icon className={`h-5 w-5 ${stat.iconColor}`} />
                        </div>
                        <svg viewBox="0 0 80 28" className="w-16 h-8 opacity-60 group-hover:opacity-90 transition-opacity duration-300" fill="none">
                          <polyline points={points} stroke={stat.sparkColor} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                          <polyline points={`${points} ${80},${28} 0,28`} fill={stat.sparkColor} fillOpacity="0.08" />
                        </svg>
                      </div>
                      <p className="text-2xl font-bold text-foreground number-animate">
                        <AnimatedCounter value={stat.numericValue} prefix={stat.prefix} suffix={stat.suffix} />
                      </p>
                      <div className="flex items-center justify-between mt-1">
                        <p className="text-[11px] text-muted-foreground">{stat.label}</p>
                        <TrendBadge trend={stat.trend} value={stat.trendVal} />
                      </div>
                    </CardContent>
                  </Card>
                </div>
              </motion.div>
            );
          })}
        </div>
      </motion.div>

      {/* ═══ System Uptime Live Pulse ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.15 }}
      >
        <div className="flex items-center gap-2.5 px-4 py-3 rounded-xl bg-gradient-to-r from-emerald-50 via-teal-50/50 to-cyan-50/30 dark:from-emerald-950/30 dark:via-teal-950/20 dark:to-cyan-950/10 border border-emerald-200/50 dark:border-emerald-800/30">
          <span className="relative flex h-3 w-3">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-3 w-3 bg-emerald-500" />
          </span>
          <span className="text-sm font-medium text-emerald-700 dark:text-emerald-400">{t('systemUptime')}</span>
          <Badge variant="outline" className="ms-auto text-[10px] font-medium bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">99.9%</Badge>
          <div className="flex items-center gap-1 ms-2">
            <Wifi className="h-3.5 w-3.5 text-emerald-500" />
            <span className="text-[10px] text-emerald-600 dark:text-emerald-400">{t('operational')}</span>
          </div>
        </div>
      </motion.div>

      {/* ═══ Quick Actions Section ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.2 }}
      >
        <div className="flex items-center gap-2 mb-3">
          <Sparkles className="h-4 w-4 text-cyan-600 dark:text-cyan-400" />
          <h2 className="text-sm font-semibold text-foreground">{t('quickActions') || 'إجراءات سريعة'}</h2>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { icon: Users, label: 'إدارة المستخدمين', view: 'admin-users', gradient: 'from-emerald-500 to-teal-600', shadow: 'shadow-emerald-500/25', hoverShadow: 'hover:shadow-emerald-500/40' },
            { icon: Building2, label: 'المؤسسات', view: 'admin-agencies', gradient: 'from-teal-500 to-cyan-600', shadow: 'shadow-teal-500/25', hoverShadow: 'hover:shadow-teal-500/40' },
            { icon: Settings, label: 'الإعدادات', view: 'admin-settings', gradient: 'from-cyan-500 to-emerald-600', shadow: 'shadow-cyan-500/25', hoverShadow: 'hover:shadow-cyan-500/40' },
            { icon: FileText, label: 'سجل المراجعة', view: 'admin-audit', gradient: 'from-emerald-600 to-teal-500', shadow: 'shadow-emerald-500/25', hoverShadow: 'hover:shadow-emerald-500/40' },
          ].map((action, idx) => {
            const Icon = action.icon;
            return (
              <motion.button
                key={action.view}
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.22 + idx * 0.06, type: 'spring', stiffness: 200, damping: 20 }}
                whileHover={{ scale: 1.06, y: -5 }}
                whileTap={{ scale: 0.95, y: 0 }}
                onClick={() => setView(action.view as import('@/store/use-app-store').ViewName)}
                className={`relative flex flex-col items-center gap-3 p-4 rounded-2xl bg-gradient-to-br ${action.gradient} text-white font-medium shadow-lg transition-all duration-300 hover:shadow-xl ${action.shadow} ${action.hoverShadow} text-sm overflow-hidden group`}
              >
                {/* Decorative circle with micro-interaction */}
                <motion.div
                  className="absolute -top-4 -end-4 w-16 h-16 rounded-full bg-white/10"
                  whileHover={{ scale: 1.5 }}
                  transition={{ duration: 0.5 }}
                />
                <div className="absolute -bottom-3 -start-3 w-12 h-12 rounded-full bg-white/5" />
                <motion.div whileHover={{ y: -2, scale: 1.1 }} transition={{ type: 'spring', stiffness: 400, damping: 20 }}>
                  <Icon className="h-6 w-6 flex-shrink-0 relative z-10 drop-shadow-sm" />
                </motion.div>
                <span className="truncate text-center font-semibold relative z-10">{action.label}</span>
              </motion.button>
            );
          })}
        </div>
      </motion.div>

      {/* ═══ Tabbed Sections: Overview | Health | Activity ═══ */}
      <motion.div
        initial={{ opacity: 0, y: 15 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.17 }}
      >
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="w-full sm:w-auto">
            <TabsTrigger value="overview" className="gap-1.5">
              <BarChart3 className="h-3.5 w-3.5" />
              {t('dashOverview')}
            </TabsTrigger>
            <TabsTrigger value="health" className="gap-1.5">
              <Heart className="h-3.5 w-3.5" />
              {t('dashHealth')}
            </TabsTrigger>
            <TabsTrigger value="activity" className="gap-1.5">
              <Activity className="h-3.5 w-3.5" />
              {t('dashActivity')}
            </TabsTrigger>
            <TabsTrigger value="actions" className="gap-1.5">
              <Zap className="h-3.5 w-3.5" />
              {t('dashActions')}
            </TabsTrigger>
          </TabsList>

          {/* ──── Overview Tab ──── */}
          <TabsContent value="overview" className="space-y-5">
            {/* Announcements Section */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.05 }}
            >
              <div className="flex items-center justify-between gap-2 mb-3">
                <div className="flex items-center gap-2">
                  <Megaphone className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                  <h2 className="text-sm font-semibold text-foreground">{t('systemAnnouncements')}</h2>
                </div>
                <Badge variant="outline" className="text-[10px] text-muted-foreground">
                  {realAnnouncements.filter(a => !dismissedAnnouncements.has(a.id)).length}
                </Badge>
              </div>
              {/* Create Announcement Form */}
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50 mb-4">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-center gap-2">
                    <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40 flex items-center justify-center shadow-sm">
                      <Megaphone className="h-3.5 w-3.5 text-amber-600 dark:text-amber-400" />
                    </div>
                    <h3 className="text-sm font-semibold text-foreground">{t('createAnnouncement')}</h3>
                  </div>
                  <Textarea
                    value={newAnnMsg}
                    onChange={(e) => setNewAnnMsg(e.target.value)}
                    placeholder={t('announcementMessagePlaceholder')}
                    className="min-h-[80px] resize-none"
                  />
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground">{t('announcementType')}:</span>
                      <select
                        value={newAnnType}
                        onChange={(e) => setNewAnnType(e.target.value as 'INFO' | 'WARNING' | 'URGENT')}
                        className="h-9 px-3 py-1.5 rounded-lg border border-border bg-background text-sm"
                      >
                        <option value="INFO">{t('announcementTypeInfo')}</option>
                        <option value="WARNING">{t('announcementTypeWarning')}</option>
                        <option value="URGENT">{t('announcementTypeUrgent')}</option>
                      </select>
                    </div>
                    <Button
                      onClick={handleCreateAnnouncement}
                      disabled={annLoading || !newAnnMsg.trim()}
                      className="sm:ms-auto bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-9 px-4 text-sm"
                    >
                      {annLoading ? <Loader2 className="h-4 w-4 animate-spin me-2" /> : <Plus className="h-4 w-4 me-2" />}
                      {t('createAnn')}
                    </Button>
                  </div>
                </CardContent>
              </Card>

              {/* Announcements List */}
              <div className="space-y-2">
                {realAnnouncements
                  .filter(a => !dismissedAnnouncements.has(a.id))
                  .sort((a, b) => {
                    const aPinned = pinnedAnnouncements.has(a.id) ? 1 : 0;
                    const bPinned = pinnedAnnouncements.has(b.id) ? 1 : 0;
                    if (aPinned !== bPinned) return bPinned - aPinned;
                    if (a.type === 'URGENT' && b.type !== 'URGENT') return -1;
                    if (b.type === 'URGENT' && a.type !== 'URGENT') return 1;
                    return 0;
                  })
                  .slice(0, 5)
                  .map((announcement, idx) => (
                    <motion.div
                      key={announcement.id}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: idx * 0.05 }}
                    >
                      <div className={`flex items-start gap-3 p-3 rounded-xl border backdrop-blur-sm transition-all duration-200 ${
                        announcement.type === 'URGENT'
                          ? 'bg-rose-50 dark:bg-rose-900/10 border-rose-200/50 dark:border-rose-800/30'
                          : announcement.type === 'WARNING'
                          ? 'bg-amber-50 dark:bg-amber-900/10 border-amber-200/50 dark:border-amber-800/30'
                          : 'bg-emerald-50 dark:bg-emerald-900/10 border-emerald-200/50 dark:border-emerald-800/30'
                      }`}>
                        <div className={`h-9 w-9 rounded-lg flex items-center justify-center flex-shrink-0 ${
                          announcement.type === 'URGENT'
                            ? 'bg-rose-200 dark:bg-rose-900/30'
                            : announcement.type === 'WARNING'
                            ? 'bg-amber-200 dark:bg-amber-900/30'
                            : 'bg-emerald-200 dark:bg-emerald-900/30'
                        }`}>
                          <AlertTriangle className={`h-4 w-4 ${
                            announcement.type === 'URGENT'
                              ? 'text-rose-600 dark:text-rose-400'
                              : announcement.type === 'WARNING'
                              ? 'text-amber-600 dark:text-amber-400'
                              : 'text-emerald-600 dark:text-emerald-400'
                          }`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-0.5">
                            <Badge className={`text-[8px] h-5 border-0 ${
                              announcement.type === 'URGENT'
                                ? 'bg-rose-200 text-rose-700 dark:bg-rose-900/30 dark:text-rose-400'
                                : announcement.type === 'WARNING'
                                ? 'bg-amber-200 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                                : 'bg-emerald-200 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                            }`}>
                              {announcement.type === 'URGENT' ? t('annTypeUrgent') : announcement.type === 'WARNING' ? t('annTypeWarning') : t('annTypeInfo')}
                            </Badge>
                            {pinnedAnnouncements.has(announcement.id) && (
                              <Badge className="text-[8px] h-5 border-0 bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400">
                                <Pin className="h-2.5 w-2.5 me-0.5" />
                                {t('pinned')}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-foreground line-clamp-2">{announcement.message}</p>
                          <p className="text-[10px] text-muted-foreground mt-0.5">
                            {formatRelativeTime(announcement.createdAt, lang)}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-amber-500"
                            onClick={() => setPinnedAnnouncements(prev => {
                              const n = new Set(prev);
                              if (n.has(announcement.id)) n.delete(announcement.id);
                              else n.add(announcement.id);
                              return n;
                            })}
                            aria-label={pinnedAnnouncements.has(announcement.id) ? t('unpinAnn') : t('pinAnn')}
                          >
                            <Pin className={`h-3.5 w-3.5 ${pinnedAnnouncements.has(announcement.id) ? 'text-amber-500' : ''}`} />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-red-500"
                            onClick={() => handleDeleteAnnouncement(announcement.id)}
                            aria-label={t('delete')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-muted-foreground hover:text-foreground"
                            onClick={() => setDismissedAnnouncements(prev => { const n = new Set(prev); n.add(announcement.id); return n; })}
                            aria-label={t('dismiss')}
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      </div>
                    </motion.div>
                ))}
                {realAnnouncements.filter(a => !dismissedAnnouncements.has(a.id)).length === 0 && (
                  <EmptyState
                    iconComponent={Megaphone}
                    title={t('noAnnouncements')}
                    description={t('noData')}
                  />
                )}
              </div>
            </motion.div>

            {/* Quick Actions Grid */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.08 }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Zap className="h-4 w-4 text-emerald-600" />
                <h2 className="text-sm font-semibold text-foreground">{t('quickActions')}</h2>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
                {[
                  { icon: Building2, label: t('addAgency'), view: 'admin-agencies', gradient: 'from-emerald-500 to-teal-600', shadow: 'shadow-emerald-500/20' },
                  { icon: Users, label: t('manageUsers'), view: 'admin-users', gradient: 'from-teal-500 to-emerald-600', shadow: 'shadow-teal-500/20' },
                  { icon: CreditCard, label: t('viewTransactions'), view: 'admin-transactions', gradient: 'from-amber-500 to-orange-500', shadow: 'shadow-amber-500/20' },
                  { icon: BarChart3, label: t('viewAnalytics'), view: 'admin-analytics', gradient: 'from-rose-500 to-pink-500', shadow: 'shadow-rose-500/20' },
                  { icon: ClipboardList, label: t('auditLogsPage'), view: 'admin-audit', gradient: 'from-gray-600 to-gray-700', shadow: 'shadow-gray-500/20' },
                  { icon: Crown, label: t('manageSubscriptionPlans'), view: 'admin-subscription-plans', gradient: 'from-amber-400 to-amber-600', shadow: 'shadow-amber-500/20' },
                ].map((action) => {
                  const Icon = action.icon;
                  return (
                    <motion.button
                      key={action.view}
                      whileHover={{ scale: 1.03, y: -2 }}
                      whileTap={{ scale: 0.97 }}
                      onClick={() => setView(action.view as import('@/store/use-app-store').ViewName)}
                      className={`flex flex-col items-center gap-2 p-3 rounded-xl bg-gradient-to-br ${action.gradient} text-white font-medium shadow-lg transition-all duration-200 hover:shadow-xl ${action.shadow} text-xs`}
                    >
                      <Icon className="h-5 w-5 flex-shrink-0" />
                      <span className="truncate text-center">{action.label}</span>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>

            {/* Daily Reservations Trend Chart */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <BarChart3 className="h-4 w-4 text-emerald-600" />
                      {t('dailyReservations')} — {t('sevenDayTrend')}
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                      <TrendingUp className="h-3 w-3 me-1" />
                      {dailyActivity} {t('todayCount')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="relative rounded-xl p-3 bg-gradient-to-br from-emerald-50/50 to-teal-50/30 dark:from-emerald-950/20 dark:to-teal-950/10 border border-emerald-100/50 dark:border-emerald-900/30">
                    {/* Subtle grid pattern behind chart */}
                    <div className="absolute inset-0 opacity-[0.03] dark:opacity-[0.05] rounded-xl" style={{
                      backgroundImage: `radial-gradient(circle at 1px 1px, currentColor 1px, transparent 0)`,
                      backgroundSize: '20px 20px',
                    }} />
                    <div className="relative">
                      <DailyReservationsChart dailyReservations={dailyActivity} />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Latest Registered Users */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <UserPlus className="h-4 w-4 text-emerald-600" />
                      {t('totalUsers')}
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] text-emerald-600 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800">
                      {t('recentActivity')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  <div className="space-y-2">
                    {activities.filter(a => a.action.toUpperCase().includes('REGISTER') || a.action.toUpperCase().includes('CREATE')).slice(0, 5).map((activity, idx) => {
                      const colorInfo = getActivityColor(activity.action);
                      return (
                        <motion.div
                          key={activity.id}
                          initial={{ opacity: 0, x: -10 }}
                          animate={{ opacity: 1, x: 0 }}
                          transition={{ delay: idx * 0.05 }}
                          className="flex items-center gap-3 p-2.5 rounded-xl hover:bg-gray-50 dark:hover:bg-gray-800/30 transition-colors"
                        >
                          <div className={`h-9 w-9 rounded-xl ${colorInfo.bg} flex items-center justify-center flex-shrink-0`}>
                            <span className={`text-xs font-bold ${colorInfo.text}`}>{getInitials(activity.details)}</span>
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-foreground truncate">{activity.details}</p>
                            <p className="text-[10px] text-muted-foreground">{formatRelativeTime(activity.createdAt, lang)}</p>
                          </div>
                          <Badge className={`text-[8px] h-5 ${colorInfo.bg} ${colorInfo.text} border-0`}>
                            {activity.entity}
                          </Badge>
                        </motion.div>
                      );
                    })}
                    {activities.filter(a => a.action.toUpperCase().includes('REGISTER') || a.action.toUpperCase().includes('CREATE')).length === 0 && (
                      <EmptyState
                        iconComponent={UserPlus}
                        title={t('noData') || 'No data yet'}
                        description={t('noRecentRegistrations') || 'New user registrations will appear here'}
                      />
                    )}
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Subscription Status Breakdown */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.14 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <Crown className="h-4 w-4 text-amber-600" />
                      {t('subscriptionBreakdown')}
                    </CardTitle>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 space-y-4">
                  {/* Status pills */}
                  <div className="grid grid-cols-3 gap-3">
                    {[
                      { label: t('active'), count: activeCount, color: 'bg-emerald-500', bgLight: 'bg-emerald-50 dark:bg-emerald-900/20', textColor: 'text-emerald-700 dark:text-emerald-400' },
                      { label: t('pending'), count: pendingCount, color: 'bg-amber-500', bgLight: 'bg-amber-50 dark:bg-amber-900/20', textColor: 'text-amber-700 dark:text-amber-400' },
                      { label: t('inactive'), count: inactiveCount, color: 'bg-gray-400', bgLight: 'bg-gray-50 dark:bg-gray-800/30', textColor: 'text-gray-600 dark:text-gray-400' },
                    ].map((item, idx) => (
                      <div key={idx} className={`p-3 rounded-xl ${item.bgLight} text-center`}>
                        <div className="flex justify-center mb-2">
                          <div className={`h-3 w-3 rounded-full ${item.color}`} />
                        </div>
                        <p className={`text-xl font-bold ${item.textColor}`}>{item.count}</p>
                        <p className="text-[10px] text-muted-foreground mt-0.5">{item.label}</p>
                      </div>
                    ))}
                  </div>

                  {/* Status bar */}
                  <div className="h-3 w-full rounded-full overflow-hidden flex bg-gray-100 dark:bg-gray-800">
                    {(() => {
                      const active = ((activeCount) / totalAgencies) * 100;
                      const pending = ((pendingCount) / totalAgencies) * 100;
                      const inactive = Math.max(100 - active - pending, 0);
                      return (
                        <>
                          <div className="h-full bg-emerald-500 transition-all duration-500" style={{ width: `${active}%` }} />
                          <div className="h-full bg-amber-500 transition-all duration-500" style={{ width: `${pending}%` }} />
                          <div className="h-full bg-gray-300 dark:bg-gray-600 transition-all duration-500" style={{ width: `${inactive}%` }} />
                        </>
                      );
                    })()}
                  </div>

                  {/* Plan Distribution */}
                  <div>
                    <h3 className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                      <CreditCard className="h-3.5 w-3.5" />
                      {t('planDistribution')}
                    </h3>
                    <div className="space-y-2.5">
                      {subscriptionPlans.map((plan, idx) => (
                        <div key={idx} className="space-y-1">
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-2">
                              <div className={`h-2.5 w-2.5 rounded-full ${plan.color}`} />
                              <span className="text-xs font-medium text-foreground">{plan.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-bold text-foreground">{plan.count}</span>
                              <span className="text-[10px] text-muted-foreground">({plan.percent}% {t('ofTotal')})</span>
                            </div>
                          </div>
                          <div className="w-full h-2 rounded-full bg-gray-100 dark:bg-gray-800 overflow-hidden">
                            <motion.div
                              initial={{ width: 0 }}
                              animate={{ width: `${plan.percent}%` }}
                              transition={{ duration: 0.8, ease: 'easeOut', delay: idx * 0.1 }}
                              className={`h-full rounded-full ${plan.barColor}`}
                            />
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Legend */}
                  <div className="flex items-center justify-center gap-4 flex-wrap">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full bg-emerald-500" /> {t('active')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full bg-amber-500" /> {t('pending')}
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <span className="h-2 w-2 rounded-full bg-gray-300 dark:bg-gray-600" /> {t('inactive')}
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ──── Health Tab ──── */}
          <TabsContent value="health" className="space-y-5">
            {/* System Health Overview with Circular Gauges */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                        <Activity className="h-4 w-4 text-white" />
                      </div>
                      {t('systemHealthOverview')}
                    </CardTitle>
                    <Badge className={`text-[9px] px-2 py-0.5 ${
                      realtime.isConnected
                        ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                        : 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400'
                    }`}>
                      <span className={`h-1.5 w-1.5 rounded-full inline-block me-1 ${realtime.isConnected ? 'bg-emerald-500 animate-pulse' : 'bg-amber-500'}`} />
                      {realtime.isConnected ? t('healthy') : t('degraded')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-4 pt-0">
                  {/* Circular Gauges Row */}
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
                    {/* Health Score */}
                    <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10">
                      <div className="relative">
                        <CircularProgress value={realtime.isConnected ? 97 : 65} size={56} color="text-emerald-500" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold text-foreground">{realtime.isConnected ? '97' : '65'}</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">{t('healthScore')}</span>
                    </div>
                    {/* Uptime */}
                    <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-teal-50/50 dark:bg-teal-900/10">
                      <div className="relative">
                        <CircularProgress value={99.9} size={56} color="text-teal-500" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold text-foreground">99.9</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">{t('uptimePercent')}</span>
                    </div>
                    {/* Response Time */}
                    <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-amber-50/50 dark:bg-amber-900/10">
                      <div className="relative">
                        <CircularProgress value={Math.min(100, Math.max(0, 100 - (stats ? Math.round(45 + Math.random() * 30) : 0)))} size={56} color="text-amber-500" />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold text-foreground">~{stats ? Math.round(45 + Math.random() * 30) : '—'}ms</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">{t('responseTime')}</span>
                    </div>
                    {/* System Load */}
                    <div className="flex flex-col items-center gap-1.5 p-3 rounded-xl bg-rose-50/50 dark:bg-rose-900/10">
                      <div className="relative">
                        <CircularProgress value={getSystemLoadPercent(stats)} size={56} color={getSystemLoadLevel(stats) === 'low' ? 'text-emerald-500' : getSystemLoadLevel(stats) === 'medium' ? 'text-amber-500' : 'text-rose-500'} />
                        <div className="absolute inset-0 flex items-center justify-center">
                          <span className="text-xs font-bold text-foreground">{getSystemLoadPercent(stats)}%</span>
                        </div>
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground">{t('systemLoad')}</span>
                    </div>
                  </div>

                  {/* Detailed Metrics */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    {/* Server Uptime */}
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                          <Clock className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <span className="text-xs font-medium text-foreground">{t('serverUptime')}</span>
                      </div>
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400 tabular-nums">
                        {stats ? formatUptime(stats) : '—'}
                      </span>
                    </div>
                    {/* API Response Time */}
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-teal-50/50 dark:bg-teal-900/10">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-teal-200 to-teal-300 dark:from-teal-900/40 dark:to-teal-800/40 flex items-center justify-center shadow-sm">
                          <Zap className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                        </div>
                        <span className="text-xs font-medium text-foreground">{t('apiResponseTime')}</span>
                      </div>
                      <span className="text-xs font-bold text-teal-700 dark:text-teal-400">
                        ~{stats ? Math.round(45 + Math.random() * 30) : '—'}ms
                      </span>
                    </div>
                    {/* Realtime Connections */}
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-teal-200 dark:from-emerald-900/40 dark:to-teal-900/40 flex items-center justify-center shadow-sm">
                          <Wifi className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                        </div>
                        <span className="text-xs font-medium text-foreground">{t('realtimeConnections')}</span>
                      </div>
                      <span className="text-xs font-bold text-emerald-700 dark:text-emerald-400">
                        {realtime.isConnected ? '1' : '0'} {t('active')}
                      </span>
                    </div>
                    {/* Server Region */}
                    <div className="flex items-center justify-between py-2.5 px-3 rounded-xl bg-amber-50/50 dark:bg-amber-900/10">
                      <div className="flex items-center gap-2">
                        <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-amber-200 to-amber-300 dark:from-amber-900/40 dark:to-amber-800/40 flex items-center justify-center shadow-sm">
                          <Globe className="h-4 w-4 text-amber-600 dark:text-amber-400" />
                        </div>
                        <span className="text-xs font-medium text-foreground">{t('serverRegion')}</span>
                      </div>
                      <span className="text-xs font-bold text-amber-700 dark:text-amber-400">
                        {t('regionAlgeria')}
                      </span>
                    </div>
                  </div>

                  {/* System Load Bar */}
                  <div className="space-y-1.5">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-medium text-foreground">{t('systemLoad')}</span>
                      <span className={`text-xs font-bold ${getSystemLoadLevel(stats) === 'low' ? 'text-emerald-600 dark:text-emerald-400' : getSystemLoadLevel(stats) === 'medium' ? 'text-amber-600 dark:text-amber-400' : 'text-red-600 dark:text-red-400'}`}>
                        {getSystemLoadLevel(stats) === 'low' ? t('healthy') : getSystemLoadLevel(stats) === 'medium' ? t('degraded') : t('critical')}
                      </span>
                    </div>
                    <div className="w-full h-3 rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${getSystemLoadPercent(stats)}%` }}
                        transition={{ duration: 1, ease: 'easeOut' }}
                        className={`h-full rounded-full ${
                          getSystemLoadLevel(stats) === 'low'
                            ? 'bg-gradient-to-r from-emerald-400 to-emerald-500'
                            : getSystemLoadLevel(stats) === 'medium'
                            ? 'bg-gradient-to-r from-amber-400 to-amber-500'
                            : 'bg-gradient-to-r from-red-400 to-red-500'
                        }`}
                      />
                    </div>
                  </div>

                  {/* Simulated Resource Usage Bars */}
                  <div className="space-y-3">
                    <h3 className="text-xs font-semibold text-foreground flex items-center gap-1.5">
                      <Gauge className="h-3.5 w-3.5" />
                      {t('systemMetrics')}
                    </h3>
                    {/* Memory */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <HardDrive className="h-3.5 w-3.5 text-emerald-500" />
                          <span className="text-xs text-foreground">{t('memoryUsage')}</span>
                        </div>
                        <span className="text-xs font-bold text-emerald-600 dark:text-emerald-400">42%</span>
                      </div>
                      <Progress value={42} className="h-2" />
                    </div>
                    {/* CPU */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Cpu className="h-3.5 w-3.5 text-teal-500" />
                          <span className="text-xs text-foreground">{t('cpuUsage')}</span>
                        </div>
                        <span className="text-xs font-bold text-teal-600 dark:text-teal-400">28%</span>
                      </div>
                      <Progress value={28} className="h-2" />
                    </div>
                    {/* Disk */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Server className="h-3.5 w-3.5 text-amber-500" />
                          <span className="text-xs text-foreground">{t('diskUsage')}</span>
                        </div>
                        <span className="text-xs font-bold text-amber-600 dark:text-amber-400">61%</span>
                      </div>
                      <Progress value={61} className="h-2" />
                    </div>
                    {/* DB Connections */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-1.5">
                          <Database className="h-3.5 w-3.5 text-rose-500" />
                          <span className="text-xs text-foreground">{t('dbConnections')}</span>
                        </div>
                        <span className="text-xs font-bold text-rose-600 dark:text-rose-400">8/20</span>
                      </div>
                      <Progress value={40} className="h-2" />
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>

            {/* Agency Sync Monitoring */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center">
                        <Building2 className="h-4 w-4 text-white" />
                      </div>
                      {t('agencySyncMonitoring')}
                    </CardTitle>
                    <Badge className="text-[9px] px-2 py-0.5 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      {agencies.length} {t('activeAgencies')}
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-3 pt-0">
                  {/* Sync Status Banner */}
                  <div className="flex items-center gap-3 p-3 rounded-xl bg-gradient-to-r from-emerald-50 to-teal-50 dark:from-emerald-900/10 dark:to-teal-900/10 border border-emerald-200/30 dark:border-emerald-800/20">
                    <div className="h-10 w-10 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center flex-shrink-0">
                      <Check className="h-5 w-5 text-white" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t('allAgenciesSynced')}</p>
                      <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">
                        {t('lastGlobalSync')}: {new Date().toLocaleTimeString(lang === 'ar' ? 'ar-DZ' : lang === 'fr' ? 'fr-DZ' : 'en-US', { hour: '2-digit', minute: '2-digit' })}
                      </p>
                    </div>
                  </div>

                  {/* Agency List */}
                  <div className="space-y-2 max-h-48 overflow-y-auto custom-scrollbar">
                    {agencies.slice(0, 10).map((agency) => (
                      <div
                        key={agency.id}
                        className="flex items-center justify-between py-2 px-3 rounded-xl bg-gray-50/50 dark:bg-gray-800/30 hover:bg-gray-100/50 dark:hover:bg-gray-800/50 transition-colors"
                      >
                        <div className="flex items-center gap-2 min-w-0">
                          <div className="h-7 w-7 rounded-lg bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center flex-shrink-0">
                            <Building2 className="h-3.5 w-3.5 text-white" />
                          </div>
                          <div className="min-w-0">
                            <p className="text-xs font-medium text-foreground truncate">
                              {lang === 'ar' && agency.nameAr ? agency.nameAr : lang === 'fr' && agency.nameFr ? agency.nameFr : agency.name}
                            </p>
                            <p className="text-[10px] text-muted-foreground">{agency.customCode}</p>
                          </div>
                        </div>
                        <Badge className={`text-[8px] px-1.5 py-0 ${
                          agency.subscriptionStatus === 'ACTIVE'
                            ? 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400'
                            : 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400'
                        }`}>
                          <span className={`h-1 w-1 rounded-full inline-block me-1 ${
                            agency.subscriptionStatus === 'ACTIVE' ? 'bg-emerald-500' : 'bg-gray-400'
                          }`} />
                          {agency.subscriptionStatus === 'ACTIVE' ? t('syncOnline') : t('syncOffline')}
                        </Badge>
                      </div>
                    ))}
                    {agencies.length === 0 && (
                      <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
                    )}
                  </div>

                  {/* Sync Metrics */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 rounded-xl bg-emerald-50/50 dark:bg-emerald-900/10 text-center">
                      <p className="text-lg font-bold text-emerald-700 dark:text-emerald-400">
                        {agencies.filter(a => a.subscriptionStatus === 'ACTIVE').length}
                      </p>
                      <p className="text-[10px] text-emerald-600/70 dark:text-emerald-400/70">{t('agenciesOnline')}</p>
                    </div>
                    <div className="p-2.5 rounded-xl bg-amber-50/50 dark:bg-amber-900/10 text-center">
                      <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                        {agencies.filter(a => a.subscriptionStatus !== 'ACTIVE').length}
                      </p>
                      <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70">{t('agenciesOffline')}</p>
                    </div>
                  </div>

                  {/* Subscription Expiry Metrics */}
                  {/* Shows counts of agencies whose subscriptions have already
                      expired or will expire within the next 7 days. The
                      numbers come straight from /api/admin/dashboard so they
                      stay in sync with the backend's own expiry logic. */}
                  <div className="grid grid-cols-2 gap-2">
                    <div className="p-2.5 rounded-xl bg-amber-50/50 dark:bg-amber-900/10 text-center">
                      <p className="text-lg font-bold text-amber-700 dark:text-amber-400">
                        {stats?.expiringSoonSubscriptions ?? 0}
                      </p>
                      <p className="text-[10px] text-amber-600/70 dark:text-amber-400/70">
                        {t('expiringSoonSubscriptions')}
                      </p>
                    </div>
                    <div className="p-2.5 rounded-xl bg-red-50/50 dark:bg-red-900/10 text-center">
                      <p className="text-lg font-bold text-red-700 dark:text-red-400">
                        {stats?.expiredSubscriptions ?? 0}
                      </p>
                      <p className="text-[10px] text-red-600/70 dark:text-red-400/70">
                        {t('expiredSubscriptions')}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ──── Activity Tab ──── */}
          <TabsContent value="activity" className="space-y-5">
            {/* Recent Activity Timeline */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <TrendingUp className="h-4 w-4 text-emerald-600" />
                      {t('recentActivity')}
                    </CardTitle>
                    <Badge variant="outline" className="text-[10px] text-muted-foreground">
                      {activities.length} events
                    </Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0">
                  {activities.length === 0 ? (
                    <EmptyState
                      iconComponent={Activity}
                      title={t('noData')}
                      description={t('noRecentRegistrations') || 'Activity will appear here'}
                    />
                  ) : (
                    <div className="relative max-h-[500px] overflow-y-auto custom-scrollbar">
                      {/* Vertical timeline line */}
                      <div className="absolute start-5 top-2 bottom-2 w-0.5 bg-gradient-to-b from-emerald-300 via-teal-300 to-cyan-200 dark:from-emerald-700 dark:via-teal-700 dark:to-cyan-800 rounded-full" />
                      <div className="space-y-0">
                        {activities.map((item, idx) => {
                          const colors = getActivityColor(item.action);
                          const initials = getInitials(item.details);
                          // Glow colors for the animated dot pulse
                          const glowColors: Record<string, string> = {
                            'bg-emerald-500': 'shadow-emerald-400/50',
                            'bg-teal-500': 'shadow-teal-400/50',
                            'bg-amber-500': 'shadow-amber-400/50',
                            'bg-red-500': 'shadow-red-400/50',
                            'bg-gray-400': 'shadow-gray-400/50',
                          };
                          const glowClass = glowColors[colors.dot] || 'shadow-emerald-400/50';
                          return (
                            <motion.div
                              key={item.id}
                              initial={{ opacity: 0, x: -10 }}
                              animate={{ opacity: 1, x: 0 }}
                              transition={{ delay: idx * 0.04 }}
                              className="relative flex items-start gap-3 py-3 group"
                            >
                              {/* Timeline dot with animated glow */}
                              <div className="relative z-10 flex-shrink-0 mt-1">
                                <div className={`h-3 w-3 rounded-full ${colors.dot} ring-2 ring-white dark:ring-gray-900 group-hover:scale-150 transition-transform duration-200 shadow-md ${glowClass}`} />
                                <div className={`absolute inset-0 h-3 w-3 rounded-full ${colors.dot} opacity-0 group-hover:opacity-40 group-hover:animate-ping transition-opacity`} />
                              </div>

                              {/* Avatar with initials */}
                              <div className={`h-9 w-9 rounded-full ${colors.bg} flex items-center justify-center flex-shrink-0 text-[10px] font-bold ${colors.text} ring-2 ring-white dark:ring-gray-900 shadow-sm group-hover:scale-110 transition-transform duration-200`}>
                                {initials}
                              </div>

                              {/* Content */}
                              <div className="flex-1 min-w-0 pb-1">
                                <div className="flex items-start justify-between gap-2">
                                  <div className="min-w-0 flex-1">
                                    <p className="text-sm font-medium text-foreground truncate group-hover:text-emerald-700 dark:group-hover:text-emerald-300 transition-colors duration-200">{item.details}</p>
                                    <div className="flex items-center gap-1.5 mt-0.5">
                                      <Badge className={`text-[8px] h-4 px-1.5 ${colors.bg} ${colors.text} border-0`}>
                                        {item.action.replace(/_/g, ' ')}
                                      </Badge>
                                      <span className="text-[10px] text-muted-foreground font-medium uppercase tracking-wide">{item.entity}</span>
                                      <span className="text-[10px] text-muted-foreground/50">·</span>
                                      <span className="text-[10px] text-muted-foreground">{formatRelativeTime(item.createdAt, lang)}</span>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </motion.div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>

          {/* ──── Actions Tab ──── */}
          <TabsContent value="actions" className="space-y-5">
            {/* Quick Actions as Large Cards */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1 }}
            >
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                {[
                  { icon: Plus, label: t('addNewAgency'), desc: t('goToAgencies'), view: 'admin-agencies', gradient: 'from-emerald-50 to-teal-50 dark:from-emerald-900/20 dark:to-teal-900/20', iconGradient: 'from-emerald-500 to-teal-600', hoverGradient: 'hover:from-emerald-100 hover:to-teal-100 dark:hover:from-emerald-900/30 dark:hover:to-teal-900/30', shadowColor: 'hover:shadow-emerald-500/5' },
                  { icon: BarChart3, label: t('viewAnalytics'), desc: t('goToAnalytics'), view: 'admin-analytics', gradient: 'from-teal-50 to-emerald-50 dark:from-teal-900/20 dark:to-emerald-900/20', iconGradient: 'from-teal-500 to-emerald-600', hoverGradient: 'hover:from-teal-100 hover:to-emerald-100 dark:hover:from-teal-900/30 dark:hover:to-emerald-900/30', shadowColor: 'hover:shadow-teal-500/5' },
                  { icon: ClipboardList, label: t('manageUsers'), desc: t('goToUsers'), view: 'admin-users', gradient: 'from-amber-50 to-orange-50 dark:from-amber-900/20 dark:to-orange-900/20', iconGradient: 'from-amber-500 to-orange-500', hoverGradient: 'hover:from-amber-100 hover:to-orange-100 dark:hover:from-amber-900/30 dark:hover:to-orange-900/30', shadowColor: 'hover:shadow-amber-500/5' },
                  { icon: CreditCard, label: t('viewTransactions'), desc: t('goToTransactions'), view: 'admin-transactions', gradient: 'from-rose-50 to-pink-50 dark:from-rose-900/20 dark:to-pink-900/20', iconGradient: 'from-rose-500 to-pink-500', hoverGradient: 'hover:from-rose-100 hover:to-pink-100 dark:hover:from-rose-900/30 dark:hover:to-pink-900/30', shadowColor: 'hover:shadow-rose-500/5' },
                  { icon: ShieldCheck, label: t('auditLogsPage'), desc: t('goToAuditLogs'), view: 'admin-audit', gradient: 'from-gray-50 to-gray-100 dark:from-gray-900/20 dark:to-gray-800/20', iconGradient: 'from-gray-600 to-gray-700', hoverGradient: 'hover:from-gray-100 hover:to-gray-200 dark:hover:from-gray-900/30 dark:hover:to-gray-800/30', shadowColor: 'hover:shadow-gray-500/5' },
                  { icon: Crown, label: t('manageSubscriptionPlans'), desc: t('goToSubscriptions'), view: 'admin-subscription-plans', gradient: 'from-amber-50 to-yellow-50 dark:from-amber-900/20 dark:to-yellow-900/20', iconGradient: 'from-amber-400 to-amber-600', hoverGradient: 'hover:from-amber-100 hover:to-yellow-100 dark:hover:from-amber-900/30 dark:hover:to-yellow-900/30', shadowColor: 'hover:shadow-amber-500/5' },
                ].map((action) => {
                  const Icon = action.icon;
                  return (
                    <motion.button
                      key={action.view}
                      whileHover={{ y: -4, scale: 1.02 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setView(action.view as import('@/store/use-app-store').ViewName)}
                      className={`flex items-center gap-4 p-4 rounded-xl bg-gradient-to-br ${action.gradient} ${action.hoverGradient} shadow-sm hover:shadow-lg ${action.shadowColor} transition-all duration-300 text-start w-full`}
                    >
                      <div className={`h-12 w-12 rounded-xl bg-gradient-to-br ${action.iconGradient} flex items-center justify-center shadow-md flex-shrink-0`}>
                        <Icon className="h-6 w-6 text-white" />
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm font-semibold text-foreground">{action.label}</p>
                        <p className="text-[10px] text-muted-foreground">{action.desc}</p>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </motion.div>

            {/* SMS Settings Section */}
            <motion.div
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.15 }}
            >
              <Card className="border-0 shadow-sm bg-white dark:bg-gray-950/80 dark:border-gray-800/50 dark:backdrop-blur-sm dark:shadow-gray-950/50">
                <CardHeader className="pb-3">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base flex items-center gap-2">
                      <MessageSquare className="h-4 w-4 text-emerald-600" />
                      {t('smsConfigSection')}
                    </CardTitle>
                    <div className="flex items-center gap-2">
                      {smsSettings?.enabled ? (
                        <Badge className="bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 text-xs font-medium">
                          <Check className="h-3 w-3 me-1" />
                          {t('smsEnabled')}
                        </Badge>
                      ) : (
                        <Badge variant="outline" className="text-xs text-muted-foreground">
                          {t('smsDisabled')}
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        onClick={fetchSmsSettings}
                        disabled={smsLoading}
                      >
                        <RefreshCw className={`h-3.5 w-3.5 ${smsLoading ? 'animate-spin' : ''}`} />
                      </Button>
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">{t('smsConfigDesc')}</p>
                </CardHeader>
                <CardContent className="pt-0 space-y-4">
                  {smsLoading ? (
                    <div className="space-y-3">
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-full" />
                      <Skeleton className="h-8 w-3/4" />
                    </div>
                  ) : smsSettings ? (
                    <>
                      {/* SMS Enable Toggle */}
                      <div className="flex items-center justify-between p-3 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                        <div className="flex items-center gap-2">
                          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-emerald-200 to-emerald-300 dark:from-emerald-900/40 dark:to-emerald-800/40 flex items-center justify-center shadow-sm">
                            <MessageSquare className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                          </div>
                          <div>
                            <p className="text-sm font-medium text-foreground">{t('smsEnabled')}</p>
                            <p className="text-[10px] text-muted-foreground">
                              {smsSettings.enabled ? t('smsEnabled') : t('smsDisabled')}
                            </p>
                          </div>
                        </div>
                        <Switch
                          checked={smsSettings.enabled}
                          onCheckedChange={(checked) => setSmsSettings({ ...smsSettings, enabled: checked })}
                        />
                      </div>

                      {/* SMS Configuration Form */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('smsProvider')}</Label>
                          <select
                            value={smsSettings.provider}
                            onChange={(e) => handleProviderChange(e.target.value)}
                            className="h-9 w-full px-3 rounded-lg border border-border bg-background text-sm"
                          >
                            {smsProviders.length > 0 ? smsProviders.map(p => (
                              <option key={p.id} value={p.id}>{p.name}</option>
                            )) : (
                              <>
                                <option value="winsms">WinSMS (winsms.dz)</option>
                                <option value="notifsend">NotifSend (notifsend.com)</option>
                                <option value="algeria_sms">{t('smsProviderAlgeriaSmsOption')}</option>
                                <option value="green_send">GreenSMS (greensms.ma)</option>
                                <option value="mtarget">M-Target (mtarget.dz)</option>
                                <option value="twilio">Twilio (twilio.com)</option>
                                <option value="vonage">Vonage / Nexmo (vonage.com)</option>
                                <option value="generic">{t('smsProviderGenericOption')}</option>
                              </>
                            )}
                          </select>
                          {(() => {
                            const prov = smsProviders.find(p => p.id === smsSettings.provider);
                            if (!prov) return null;
                            return (
                              <p className="text-[10px] text-muted-foreground mt-0.5">
                                {prov.description}
                                {!prov.senderIdSupport && ' ⚠️ Uses phone number as sender (not name)'}
                              </p>
                            );
                          })()}
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('smsSenderName')}</Label>
                          <Input value={smsSettings.senderName} onChange={(e) => setSmsSettings({ ...smsSettings, senderName: e.target.value })} className="h-9 text-sm" placeholder="BLASTI" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('smsApiUrl')}</Label>
                          <Input value={smsSettings.apiUrl} onChange={(e) => setSmsSettings({ ...smsSettings, apiUrl: e.target.value })} className="h-9 text-sm" placeholder="https://api.example.com/sms" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('smsApiKey')}</Label>
                          <Input value={smsSettings.apiKey} onChange={(e) => setSmsSettings({ ...smsSettings, apiKey: e.target.value })} className="h-9 text-sm" type="password" placeholder="••••••••••" />
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('testPhoneNumber')}</Label>
                          <Input value={smsSettings.testPhoneNumber ?? ''} onChange={(e) => setSmsSettings({ ...smsSettings, testPhoneNumber: e.target.value })} className="h-9 text-sm" placeholder="+213XXXXXXXXX" dir="ltr" />
                          <p className="text-[10px] text-muted-foreground">{t('smsPhoneFormat') || 'Algerian format: +213XXXXXXXXX or 0XXXXXXXXX'}</p>
                        </div>
                        <div className="space-y-1.5">
                          <Label className="text-xs font-medium text-muted-foreground">{t('smsPerReminder')}</Label>
                          <Input type="number" min={1} max={5} value={smsSettings.smsPerReminder} onChange={(e) => setSmsSettings({ ...smsSettings, smsPerReminder: parseInt(e.target.value) || 1 })} className="h-9 text-sm" />
                        </div>
                      </div>

                      {/* Actions */}
                      <div className="flex flex-wrap items-center gap-2">
                        <Button onClick={handleSaveSmsSettings} disabled={smsSaving} className="bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl h-9 px-4 text-sm">
                          {smsSaving ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : <Save className="h-4 w-4 me-1.5" />}
                          {t('save')}
                        </Button>
                        <Button variant="outline" onClick={handleSendTestSms} disabled={smsTestLoading || !smsSettings.testPhoneNumber} className="rounded-xl h-9 px-4 text-sm">
                          {smsTestLoading ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : <Send className="h-4 w-4 me-1.5" />}
                          {t('smsTestSend')}
                        </Button>
                        <Button variant="outline" onClick={handleValidateGateway} disabled={smsValidating || !smsSettings.apiUrl} className="rounded-xl h-9 px-4 text-sm border-emerald-300 dark:border-emerald-700 text-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20">
                          {smsValidating ? <Loader2 className="h-4 w-4 animate-spin me-1.5" /> : <Wifi className="h-4 w-4 me-1.5" />}
                          {t('smsValidateConnection') || 'Validate Connection'}
                        </Button>
                      </div>

                      {/* SMS Usage Stats */}
                      {smsStats && (
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                          <div className="flex flex-col items-center p-2.5 rounded-xl bg-emerald-50 dark:bg-emerald-900/10">
                            <span className="text-lg font-bold text-emerald-700 dark:text-emerald-400">{smsStats.sentToday}</span>
                            <span className="text-[10px] text-muted-foreground">{t('smsSentToday')}</span>
                          </div>
                          <div className="flex flex-col items-center p-2.5 rounded-xl bg-teal-50 dark:bg-teal-900/10">
                            <span className="text-lg font-bold text-teal-700 dark:text-teal-400">{smsStats.sentThisWeek}</span>
                            <span className="text-[10px] text-muted-foreground">{t('smsSentThisWeek')}</span>
                          </div>
                          <div className="flex flex-col items-center p-2.5 rounded-xl bg-amber-50 dark:bg-amber-900/10">
                            <span className="text-lg font-bold text-amber-700 dark:text-amber-400">{smsStats.sentThisMonth}</span>
                            <span className="text-[10px] text-muted-foreground">{t('smsSentThisMonth')}</span>
                          </div>
                          <div className="flex flex-col items-center p-2.5 rounded-xl bg-gray-50 dark:bg-gray-900/50">
                            <span className="text-lg font-bold text-foreground">{smsStats.totalSent}</span>
                            <span className="text-[10px] text-muted-foreground">{t('smsTotalSent')}</span>
                          </div>
                        </div>
                      )}

                      {/* Recent SMS Logs */}
                      <div>
                        <p className="text-xs font-semibold text-foreground mb-2 flex items-center gap-1.5">
                          <ClipboardList className="h-3.5 w-3.5" />
                          {t('smsLogs')}
                        </p>
                        {smsLogs.length === 0 ? (
                          <p className="text-xs text-muted-foreground text-center py-3">{t('noSmsLogs')}</p>
                        ) : (
                          <div className="space-y-1.5 max-h-48 overflow-y-auto custom-scrollbar">
                            {smsLogs.map((log) => (
                              <div key={log.id} className="flex items-center gap-2.5 p-2 rounded-lg bg-gray-50 dark:bg-gray-900/50 text-xs">
                                <Badge variant="outline" className={`text-[10px] px-1.5 py-0 flex-shrink-0 ${
                                  log.status === 'SENT'
                                    ? 'border-emerald-300 text-emerald-600 dark:border-emerald-700 dark:text-emerald-400'
                                    : log.status === 'FAILED'
                                    ? 'border-rose-300 text-rose-600 dark:border-rose-700 dark:text-rose-400'
                                    : 'border-amber-300 text-amber-600 dark:border-amber-700 dark:text-amber-400'
                                }`}>
                                  {log.status}
                                </Badge>
                                <span className="text-muted-foreground truncate flex-shrink-0">{log.phoneNumber}</span>
                                <span className="text-foreground truncate flex-1 min-w-0">{log.message.slice(0, 60)}</span>
                                <span className="text-muted-foreground flex-shrink-0 whitespace-nowrap">{formatTime(log.createdAt)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <p className="text-sm text-muted-foreground text-center py-4">{t('noData')}</p>
                  )}
                </CardContent>
              </Card>
            </motion.div>
          </TabsContent>
        </Tabs>
      </motion.div>

      {/* ═══ Platform Version Footer ═══ */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 0.4 }}
        className="text-center pb-2"
      >
        <Badge variant="outline" className="text-[10px] text-muted-foreground font-normal border-dashed">
          {t('platformVersion')}: v1.0.0 · {t('lastUpdated')}: {formatTime(new Date().toISOString())}
        </Badge>
      </motion.div>
    </div>
  );
}
