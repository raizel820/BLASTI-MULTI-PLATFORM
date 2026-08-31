'use client';

import { useEffect, useState } from 'react';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Clock, CheckCircle2, XCircle, TicketCheck, ChevronRight, Activity } from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';
import type { TranslationKeys } from '@/i18n';

interface ActivityItem {
  id: string;
  agencyName: string;
  agencyNameAr?: string;
  agencyNameFr?: string;
  serviceName: string;
  serviceNameAr?: string;
  serviceNameFr?: string;
  status: string;
  createdAt: string;
}

function timeAgo(dateStr: string, t: (key: TranslationKeys) => string, lang: string): string {
  const now = new Date();
  const date = new Date(dateStr);
  const diffMs = now.getTime() - date.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  const diffHr = Math.floor(diffMs / 3600000);
  const diffDay = Math.floor(diffMs / 86400000);

  if (diffMin < 1) return t('recentActivityJustNow');
  if (diffMin < 60) return t('recentActivityMinAgo').replace('{n}', String(diffMin));
  if (diffHr < 24) return t('recentActivityHourAgo').replace('{n}', String(diffHr));
  return t('recentActivityDayAgo').replace('{n}', String(diffDay));
}

const statusConfig: Record<string, { color: string; bg: string; dot: string; icon: React.ElementType; labelKey: TranslationKeys }> = {
  WAITING: { color: 'text-amber-700 dark:text-amber-400', bg: 'bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800', dot: 'bg-amber-500', icon: Clock, labelKey: 'recentActivityJoined' },
  CALLED: { color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800', dot: 'bg-emerald-500', icon: TicketCheck, labelKey: 'recentActivityCalled' },
  SERVED: { color: 'text-teal-700 dark:text-teal-400', bg: 'bg-teal-50 dark:bg-teal-900/20 border-teal-200 dark:border-teal-800', dot: 'bg-teal-500', icon: CheckCircle2, labelKey: 'recentActivityCompleted' },
  COMPLETED: { color: 'text-emerald-700 dark:text-emerald-400', bg: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800', dot: 'bg-emerald-500', icon: CheckCircle2, labelKey: 'recentActivityCompleted' },
  CANCELLED: { color: 'text-gray-600 dark:text-gray-400', bg: 'bg-gray-50 dark:bg-gray-800/30 border-gray-200 dark:border-gray-700', dot: 'bg-gray-400', icon: XCircle, labelKey: 'recentActivityCancelled' },
  NO_SHOW: { color: 'text-rose-700 dark:text-rose-400', bg: 'bg-rose-50 dark:bg-rose-900/20 border-rose-200 dark:border-rose-800', dot: 'bg-rose-500', icon: XCircle, labelKey: 'recentActivityCancelled' },
};

interface RecentActivityFeedProps {
  t: (key: TranslationKeys) => string;
  lang: string;
  onViewHistory: () => void;
}

export function RecentActivityFeed({ t, lang, onViewHistory }: RecentActivityFeedProps) {
  const { user } = useAppStore();
  const [activities, setActivities] = useState<ActivityItem[]>([]);
  const [loading, setLoading] = useState(true);
  const userId = user?.id;

  useEffect(() => {
    if (!userId) { return; }
    let cancelled = false;
    const doFetch = async () => {
      try {
        const res = await apiFetch(`/api/reservations/history?limit=5`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          const items: ActivityItem[] = (data.reservations ?? []).slice(0, 5).map((r: any) => ({
            id: r.id,
            agencyName: r.agency?.name || '',
            agencyNameAr: r.agency?.nameAr,
            agencyNameFr: r.agency?.nameFr,
            serviceName: r.service?.name || '',
            serviceNameAr: r.service?.nameAr,
            serviceNameFr: r.service?.nameFr,
            status: r.status || 'WAITING',
            createdAt: r.createdAt || r.joinedAt || new Date().toISOString(),
          }));
          setActivities(items);
        }
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    };
    doFetch();
    return () => { cancelled = true; };
  }, [userId]);

  if (loading) {
    return (
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: 0.25 }}
        className="mb-5"
      >
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t('recentActivityTitle')}
          </h2>
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-14 bg-muted/50 rounded-xl animate-pulse" />
          ))}
        </div>
      </motion.div>
    );
  }

  if (activities.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.25 }}
      className="mb-5"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Activity className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
          {t('recentActivityTitle')}
        </h2>
        <button
          onClick={onViewHistory}
          className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-0.5 hover:underline"
        >
          {t('recentActivityViewAll')}
          <ChevronRight className="h-3 w-3 rtl:rotate-180" />
        </button>
      </div>

      {/* Timeline layout */}
      <div className="relative">
        {/* Vertical timeline line */}
        <div className="absolute start-4 top-2 bottom-2 w-px bg-gradient-to-b from-emerald-300 via-emerald-200 to-transparent dark:from-emerald-700 dark:via-emerald-800" />

        <div className="space-y-2">
          {activities.map((item, idx) => {
            const config = statusConfig[item.status] || statusConfig.WAITING;
            const StatusIcon = config.icon;
            const agencyName = lang === 'ar' && item.agencyNameAr ? item.agencyNameAr : lang === 'fr' && item.agencyNameFr ? item.agencyNameFr : item.agencyName;
            const serviceName = lang === 'ar' && item.serviceNameAr ? item.serviceNameAr : lang === 'fr' && item.serviceNameFr ? item.serviceNameFr : item.serviceName;

            return (
              <motion.div
                key={item.id}
                initial={{ opacity: 0, x: -10 }}
                animate={{ opacity: 1, x: 0 }}
                transition={{ delay: idx * 0.06 }}
                className="relative flex items-start gap-3 ps-2"
              >
                {/* Timeline dot */}
                <div className={`relative z-10 mt-1 h-5 w-5 rounded-full flex items-center justify-center ring-2 ring-background ${config.dot}`}>
                  <StatusIcon className="h-2.5 w-2.5 text-white" />
                </div>

                {/* Content card */}
                <div className={`flex-1 min-w-0 rounded-xl border px-3 py-2 ${config.bg}`}>
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-foreground truncate">
                        {agencyName}
                      </p>
                      {serviceName && (
                        <p className="text-[10px] text-muted-foreground truncate">{serviceName}</p>
                      )}
                    </div>
                    <div className="flex items-center gap-1.5 flex-shrink-0">
                      <Badge variant="outline" className={`text-[9px] px-1.5 py-0 border-0 ${config.bg} ${config.color}`}>
                        {t(config.labelKey)}
                      </Badge>
                      <span className="text-[9px] text-muted-foreground whitespace-nowrap">
                        {timeAgo(item.createdAt, t, lang)}
                      </span>
                    </div>
                  </div>
                </div>
              </motion.div>
            );
          })}
        </div>
      </div>
    </motion.div>
  );
}
