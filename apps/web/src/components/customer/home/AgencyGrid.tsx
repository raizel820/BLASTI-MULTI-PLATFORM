'use client';

import { Skeleton } from '@/components/ui/skeleton';
import { Search } from 'lucide-react';
import { AgencyCard } from './AgencyCard';
import type { AgencyListItem } from './types';

interface AgencyGridProps {
  agencies: AgencyListItem[];
  loading: boolean;
  onSelectAgency: (agency: AgencyListItem) => void;
  onQuickJoin: (agencyId: string, serviceId?: string) => void;
  onToggleFavorite: (e: React.MouseEvent, agencyId: string) => void;
  favoriteIds: Set<string>;
  togglingFav: string | null;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function AgencyGrid({
  agencies,
  loading,
  onSelectAgency,
  onQuickJoin,
  onToggleFavorite,
  favoriteIds,
  togglingFav,
  t,
  lang,
}: AgencyGridProps) {
  if (loading) {
    return (
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 stagger-fade-up">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="relative overflow-hidden rounded-2xl shimmer-loading">
            <div className="p-4 space-y-3">
              <div className="flex items-start justify-between">
                <Skeleton className="h-10 w-10 rounded-xl skeleton-shimmer-enhanced" />
                <Skeleton className="h-5 w-16 rounded-full skeleton-shimmer-enhanced" />
              </div>
              <Skeleton className="h-4 w-3/4 skeleton-shimmer-enhanced" />
              <Skeleton className="h-3 w-1/2 skeleton-shimmer-enhanced" />
              <Skeleton className="h-5 w-20 rounded-full skeleton-shimmer-enhanced" />
              <div className="flex items-center justify-between pt-3 border-t border-gray-100 dark:border-gray-800">
                <Skeleton className="h-5 w-14 rounded-full skeleton-shimmer-enhanced" />
                <Skeleton className="h-5 w-5 rounded-full skeleton-shimmer-enhanced" />
              </div>
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (agencies.length === 0) {
    return (
      <div className="text-center py-16">
        <Search className="h-12 w-12 text-muted-foreground mx-auto mb-3" />
        <p className="text-muted-foreground">{t('noData')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
      {agencies.map((agency, idx) => (
        <AgencyCard
          key={agency.id}
          agency={agency}
          idx={idx}
          onSelectAgency={onSelectAgency}
          onQuickJoin={onQuickJoin}
          onToggleFavorite={onToggleFavorite}
          isFavorite={favoriteIds.has(agency.id)}
          isTogglingFav={togglingFav === agency.id}
          t={t}
          lang={lang}
        />
      ))}
    </div>
  );
}
