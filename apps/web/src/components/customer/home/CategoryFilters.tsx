'use client';

import { motion } from 'framer-motion';
import { Tag } from 'lucide-react';
import { categoryKeys } from './types';
import { useAgencyCategories } from '@/hooks/use-agency-categories';

interface CategoryFiltersProps {
  selectedCategory: string;
  onCategoryChange: (category: string) => void;
  categoryCounts: Record<string, number>;
  t: (key: import("@/i18n").TranslationKeys) => string;
}

/**
 * Task 42 — filter chip rail: the 25 built-in categories (ALL first) from
 * types.ts, then the user-created custom categories fetched once through
 * useAgencyCategories(). Custom chips use a generic Tag icon and display the
 * user-entered name as-is; their chip value is the UPPERCASED name so the
 * existing case-insensitive filter (agency.category.toUpperCase() ===
 * selectedCategory) keeps working unchanged.
 */
export function CategoryFilters({
  selectedCategory,
  onCategoryChange,
  categoryCounts,
  t,
}: CategoryFiltersProps) {
  const { customCategories } = useAgencyCategories();

  const customChips = customCategories.map((row) => ({
    id: row.id,
    value: row.name.toUpperCase(),
    label: row.name,
  }));

  return (
    <div className="flex gap-2 overflow-x-auto pb-3 mb-5 no-scrollbar snap-x snap-mandatory scroll-smooth" style={{ WebkitOverflowScrolling: 'touch' }}>
      {categoryKeys.map((cat) => {
        const Icon = cat.icon;
        const isActive = selectedCategory === cat.value;
        const count = cat.value === 'ALL'
          ? Object.values(categoryCounts).reduce((s, c) => s + c, 0)
          : categoryCounts[cat.value] || 0;

        return (
          <motion.button
            key={cat.value}
            onClick={() => onCategoryChange(cat.value)}
            layout
            className={`snap-start flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all min-h-9 active:scale-95 relative ${
              isActive
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-white/60 dark:bg-gray-800/60 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50'
            }`}
          >
            <motion.span
              initial={false}
              animate={{ scale: isActive ? 1.1 : 1, rotate: isActive ? 10 : 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            >
              <Icon className="h-3.5 w-3.5" />
            </motion.span>
            {t(cat.key)}
            {/* Count badge */}
            {count > 0 && (
              <span className={`text-[9px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center ${
                isActive
                  ? 'bg-white/25 text-white'
                  : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              }`}>
                {count > 99 ? '99+' : count}
              </span>
            )}
            {/* Animated selection indicator */}
            {isActive && (
              <motion.div
                layoutId="categoryIndicator"
                className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 -z-10"
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
          </motion.button>
        );
      })}

      {/* User-created custom categories — Tag icon, name displayed as-is */}
      {customChips.map((cat) => {
        const isActive = selectedCategory === cat.value;
        const count = categoryCounts[cat.value] || 0;

        return (
          <motion.button
            key={cat.id}
            onClick={() => onCategoryChange(cat.value)}
            layout
            className={`snap-start flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-medium whitespace-nowrap transition-all min-h-9 active:scale-95 relative ${
              isActive
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-lg shadow-emerald-500/30'
                : 'bg-white/60 dark:bg-gray-800/60 text-muted-foreground hover:bg-gray-200 dark:hover:bg-gray-700 backdrop-blur-sm border border-gray-200/50 dark:border-gray-700/50'
            }`}
          >
            <motion.span
              initial={false}
              animate={{ scale: isActive ? 1.1 : 1, rotate: isActive ? 10 : 0 }}
              transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            >
              <Tag className="h-3.5 w-3.5" />
            </motion.span>
            {cat.label}
            {count > 0 && (
              <span className={`text-[9px] font-bold min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center ${
                isActive
                  ? 'bg-white/25 text-white'
                  : 'bg-emerald-100 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400'
              }`}>
                {count > 99 ? '99+' : count}
              </span>
            )}
            {isActive && (
              <motion.div
                layoutId="categoryIndicator"
                className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-600 to-teal-600 -z-10"
                transition={{ type: 'spring', stiffness: 400, damping: 30 }}
              />
            )}
          </motion.button>
        );
      })}
    </div>
  );
}
