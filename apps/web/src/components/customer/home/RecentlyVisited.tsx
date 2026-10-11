'use client';

/**
 * Task 79-a — Recently visited agencies rail (restyle of the original feed).
 * Same endpoint (GET /api/reservations/history?limit=10), same grouping/
 * dedupe logic. Also fixes the pre-rebuild missing `apiFetch` import.
 *
 * Field request: the "past visits" section now uses the SAME full-width
 * detail cards + swiper as the nearby/search sections. Visited agencies are
 * enriched with the live listing data (address, waiting count, rating,
 * hours…) when the agency is present in GET /api/agencies; agencies that
 * are not listed anymore fall back to the compact history card so no visit
 * ever disappears.
 */

import { useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-fetch';
import { motion } from 'framer-motion';
import { Badge } from '@/components/ui/badge';
import { Clock, Building2, ChevronRight, History } from 'lucide-react';
import { useAppStore } from '@/store/use-app-store';
import type { TranslationKeys } from '@/i18n';
import type { AgencyListItem } from './types';
import { getAgencyName } from './types';
import { AgencyCardWide } from './AgencyCardWide';
import { CardSwiper } from './CardSwiper';

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
  /** Live listing rows — enrich visited cards with full details. */
  agencies: AgencyListItem[];
  favoriteIds: Set<string>;
  togglingFav: string | null;
  onToggleFavorite: (e: React.MouseEvent, agencyId: string) => void;
  onQuickJoin: (agencyId: string) => void;
  distanceByAgencyId?: Record<string, number> | null;
  onViewProfile?: (agency: AgencyListItem) => void;
  /** The header "view all" affordance finally navigates to the history view. */
  onNavigateHistory?: () => void;
}

export function RecentlyVisited({
  t,
  lang,
  onSelectAgency,
  agencies,
  favoriteIds,
  togglingFav,
  onToggleFavorite,
  onQuickJoin,
  distanceByAgencyId,
  onViewProfile,
  onNavigateHistory,
}: RecentlyVisitedProps) {
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

  // Live listing rows by id — the enrichment source for the wide cards.
  const agenciesById = useMemo(() => {
    const map = new Map<string, AgencyListItem>();
    for (const a of agencies) map.set(a.id, a);
    return map;
  }, [agencies]);

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
          onClick={() => onNavigateHistory?.()}
        >
          {t('viewAllHistory')}
          <ChevronRight className="h-3 w-3 rtl:rotate-180" />
        </button>
      </div>
      <div className="-mx-4 px-4">
        <CardSwiper
          ariaLabel={t('recentlyVisited')}
          itemClassName="w-full md:w-[calc(50%-6px)] lg:w-[calc(33.333%-8px)]"
        >
          {visitedAgencies.map((agency, idx) => {
            const full = agenciesById.get(agency.id);
            if (full) {
              // Full detail card — same component as nearby/search sections.
              return (
                <AgencyCardWide
                  key={agency.id}
                  agency={full}
                  index={idx}
                  lang={lang}
                  isFavorite={favoriteIds.has(full.id)}
                  toggling={togglingFav === full.id}
                  t={t}
                  onSelect={onSelectAgency}
                  onToggleFavorite={onToggleFavorite}
                  onQuickJoin={onQuickJoin}
                  distanceKm={distanceByAgencyId?.[full.id] ?? null}
                  onViewProfile={onViewProfile}
                />
              );
            }
            // Compact fallback — agency is not in the live listing anymore.
            const listItem = toListItem(agency);
            const name = getAgencyName(listItem, lang);
            return (
              <motion.button
                key={agency.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ delay: idx * 0.06 }}
                whileTap={{ scale: 0.97 }}
                className="h-full min-h-[120px] w-full rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm hover:shadow-md hover:border-teal-300 dark:hover:border-teal-700 transition-all duration-200 p-4 text-start flex flex-col justify-between"
                onClick={() => onSelectAgency(listItem)}
              >
                <div className="flex items-center gap-2 mb-1.5">
                  <div className="h-9 w-9 rounded-xl bg-teal-100 dark:bg-teal-900/40 flex items-center justify-center flex-shrink-0">
                    <Building2 className="h-4 w-4 text-teal-600 dark:text-teal-400" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-foreground truncate">{name}</p>
                    {agency.queueNumber && (
                      <Badge variant="outline" className="text-[9px] px-1.5 py-0 mt-0.5 border-0 bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                        #{agency.queueNumber}
                      </Badge>
                    )}
                  </div>
                </div>
                <span className="text-[10px] text-muted-foreground flex items-center gap-1">
                  <Clock className="h-3 w-3" />
                  {formatRelativeTime(agency.visitedAt, t)}
                </span>
              </motion.button>
            );
          })}
        </CardSwiper>
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
