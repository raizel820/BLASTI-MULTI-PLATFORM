'use client';

/**
 * Task 79-a — Recently visited agencies rail (restyle of the original feed).
 * Same endpoint (GET /api/reservations/history?limit=10), same grouping/
 * dedupe logic; container restyled to Design System v2. Also fixes the
 * pre-rebuild missing `apiFetch` import.
 */

import { useEffect, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Clock, Building2, ChevronRight, History, Star } from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';
import type { TranslationKeys } from '@/i18n';
import type { AgencyListItem } from './types';
import { getAgencyName } from './types';

interface VisitedAgency {
  id: string;
  name: string;
  nameAr?: string;
  nameFr?: string;
  category: string;
  visitedAt: string;
  queueNumber?: string;
  averageRating?: number;
}

interface RecentlyVisitedProps {
  t: (key: TranslationKeys, params?: Record<string, string>) => string;
  lang: string;
  onSelectAgency: (agency: AgencyListItem) => void;
}

export function RecentlyVisited({ t, lang, onSelectAgency }: RecentlyVisitedProps) {
  const { user } = useAppStore();
  const [visitedAgencies, setVisitedAgencies] = useState<VisitedAgency[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.id) { return; }
    let cancelled = false;
    const doFetch = async () => {
      try {
        const res = await apiFetch(`/api/reservations/history?limit=10`);
        if (res.ok && !cancelled) {
          const data = await res.json();
          // Group by agency, take unique ones, sorted by most recent
          const seen = new Set<string>();
          const unique: VisitedAgency[] = [];
          for (const r of data.reservations ?? []) {
            const agencyId = r.agency?.id || r.agencyId;
            if (agencyId && !seen.has(agencyId)) {
              seen.add(agencyId);
              unique.push({
                id: agencyId,
                name: r.agency?.name || '',
                nameAr: r.agency?.nameAr,
                nameFr: r.agency?.nameFr,
                category: r.agency?.category || 'OTHER',
                visitedAt: r.joinedAt || r.createdAt || new Date().toISOString(),
                queueNumber: r.displayNumber || r.queueNumber,
                averageRating: r.agency?.averageRating,
              });
            }
            if (unique.length >= 5) break;
          }
          if (!cancelled) setVisitedAgencies(unique);
        }
      } catch { /* silent */ }
      finally { if (!cancelled) setLoading(false); }
    };
    doFetch();
    return () => { cancelled = true; };
  }, [user?.id]);

  if (loading) {
    return (
      <section className="mb-5" aria-busy="true">
        <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
          <History className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          {t('recentlyVisited')}
        </h2>
        <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
          {[1, 2, 3].map((i) => (
            <div key={i} className="flex-shrink-0 min-w-[160px] h-20 bg-muted/50 rounded-2xl animate-pulse" />
          ))}
        </div>
      </section>
    );
  }

  if (visitedAgencies.length === 0) return null;

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.25 }}
      className="mb-5"
    >
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <History className="h-4 w-4 text-teal-600 dark:text-teal-400" />
          {t('recentlyVisited')}
        </h2>
        <button
          className="text-xs text-emerald-600 dark:text-emerald-400 font-medium flex items-center gap-0.5 hover:underline"
          onClick={() => {/* could navigate to full history */}}
        >
          {t('viewAllHistory')}
          <ChevronRight className="h-3 w-3 rtl:rotate-180" />
        </button>
      </div>
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {visitedAgencies.map((agency, idx) => {
          const listItem = toListItem(agency);
          const name = getAgencyName(listItem, lang);
          return (
            <motion.button
              key={agency.id}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.06 }}
              whileTap={{ scale: 0.97 }}
              className="flex-shrink-0 min-w-[160px] rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm hover:shadow-md hover:border-teal-300 dark:hover:border-teal-700 transition-all duration-200 p-3 text-start"
              onClick={() => onSelectAgency(toListItem(agency))}
            >
              <div className="flex items-center gap-2 mb-1.5">
                <div className="h-8 w-8 rounded-xl bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center flex-shrink-0">
                  <Building2 className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-foreground truncate">{name}</p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {agency.queueNumber && (
                  <Badge variant="outline" className="text-[9px] px-1.5 py-0 border-0 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                    #{agency.queueNumber}
                  </Badge>
                )}
                <span className="text-[9px] text-muted-foreground flex items-center gap-0.5">
                  <Clock className="h-2.5 w-2.5" />
                  {formatRelativeTime(agency.visitedAt, t)}
                </span>
              </div>
              {(agency.averageRating ?? 0) > 0 && (
                <div className="flex items-center gap-0.5 mt-1">
                  {[1, 2, 3, 4, 5].map((s) => (
                    <Star
                      key={s}
                      className={`h-2.5 w-2.5 ${s <= Math.round(agency.averageRating || 0) ? 'fill-amber-400 text-amber-400' : 'fill-gray-200 text-gray-200 dark:fill-gray-600 dark:text-gray-600'}`}
                    />
                  ))}
                </div>
              )}
            </motion.button>
          );
        })}
      </div>
    </motion.section>
  );
}

function toListItem(agency: VisitedAgency): AgencyListItem {
  return {
    id: agency.id,
    name: agency.name,
    nameAr: agency.nameAr,
    nameFr: agency.nameFr,
    category: agency.category,
    address: '',
    isSponsored: false,
    customCode: '',
    isQueueOpen: true,
    isPaused: false,
    serviceCount: 0,
    waitingCount: 0,
  };
}

function formatRelativeTime(dateStr: string, t: (key: TranslationKeys, params?: Record<string, string>) => string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return t('justNow');
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}
