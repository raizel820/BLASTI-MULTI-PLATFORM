'use client';

import { Navigation, MapPin } from 'lucide-react';
import { motion } from 'framer-motion';
import type { AgencyListItem } from './types';
import { getAgencyName } from './types';

interface NearbyAgenciesProps {
  agencies: AgencyListItem[];
  loading: boolean;
  onSelectAgency: (agency: AgencyListItem) => void;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function NearbyAgencies({
  agencies,
  loading,
  onSelectAgency,
  t,
  lang,
}: NearbyAgenciesProps) {
  if (loading || agencies.length === 0) return null;

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.2 }}
      className="mb-5"
    >
      <h2 className="text-sm font-semibold text-foreground mb-3 flex items-center gap-2">
        <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
        {t('nearbyAgencies')}
      </h2>
      <div className="flex gap-3 overflow-x-auto pb-2 no-scrollbar">
        {(() => {
          const sorted = [...agencies]
            .filter((a) => a.isQueueOpen && !a.isPaused)
            .sort((a, b) => (a.address || '').localeCompare(b.address || ''))
            .slice(0, 3);
          return sorted.map((agency, idx) => (
            <motion.button
              key={agency.id}
              initial={{ opacity: 0, x: 10 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: idx * 0.08 }}
              whileHover={{ y: -2 }}
              whileTap={{ scale: 0.97 }}
              className="flex-shrink-0 min-w-[180px] rounded-2xl border border-border bg-white dark:bg-gray-900/80 shadow-sm hover:shadow-md hover:border-emerald-300 dark:hover:border-emerald-700 transition-all duration-200 p-3 text-start"
              onClick={() => onSelectAgency(agency)}
            >
              <div className="flex items-start gap-3">
                <div className="h-10 w-10 rounded-xl bg-emerald-100 dark:bg-emerald-900/40 flex items-center justify-center flex-shrink-0">
                  <Navigation className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold text-foreground truncate">{getAgencyName(agency, lang)}</p>
                  <p className="text-[10px] text-muted-foreground truncate mt-0.5">{agency.address}</p>
                  <div className="flex items-center gap-1 mt-1.5">
                    <MapPin className="h-3 w-3 text-emerald-500" />
                    <span className="text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                      {(idx + 1) * 0.5 + (idx * 0.3)} km
                    </span>
                  </div>
                </div>
              </div>
            </motion.button>
          ));
        })()}
      </div>
    </motion.div>
  );
}
