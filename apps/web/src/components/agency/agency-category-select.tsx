'use client';

/**
 * AgencyCategorySelect — shared, RTL-aware, searchable agency category picker.
 *
 * ONE source of truth: BUILT_IN_CATEGORY_OPTIONS — the 4 product agency types
 * (doctor, clinic, law office, barber — task A reduction). Used by the agency
 * creation wizard (variant="grid") and the profile settings (variant="compact").
 *
 * Value semantics:
 *  - Agency.category stores the built-in enum key (e.g. 'CLINIC').
 *  - Legacy values that are no longer built-ins (pre-reduction rows) display
 *    as-is in the compact trigger until the owner re-picks one of the 4.
 *  - The custom-category (AgencyCategory model) create flow was removed with
 *    the 4-type constraint; existing custom rows, if any, are no longer
 *    selectable here.
 *
 * Colors: emerald/amber/rose/red family only (no indigo/blue), semantic
 * tokens for dark mode.
 */

import { useMemo, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { BUILT_IN_CATEGORY_OPTIONS } from '@/hooks/use-agency-categories';
import { translations, type TranslationKeys } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Check, ChevronDown, Search, Tag } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface AgencyCategorySelectProps {
  /** Current selection: built-in enum key ('CLINIC'). */
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  /**
   * 'grid'    — inline responsive card grid (creation wizard).
   * 'compact' — Select-like trigger that opens the picker in a Dialog
   *             (profile settings).
   */
  variant?: 'grid' | 'compact';
}

/** Cast an i18n key for t() — the catXxx keys are typed in all dictionaries. */
const tk = (key: string) => key as TranslationKeys;

// ─── Option card ──────────────────────────────────────────────────────

function CategoryCard({
  icon,
  label,
  isSelected,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  isSelected: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={isSelected}
      className={cn(
        'relative flex flex-col items-center justify-center gap-1.5 rounded-xl border-2 p-2.5 sm:p-3 transition-all duration-200 cursor-pointer group text-center',
        isSelected
          ? 'border-emerald-500 dark:border-emerald-400 bg-emerald-50 dark:bg-emerald-900/20 ring-2 ring-emerald-500/30 shadow-md shadow-emerald-500/10'
          : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 hover:border-emerald-300 dark:hover:border-emerald-700 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10',
        disabled && 'opacity-60 cursor-not-allowed',
      )}
    >
      {/* Selection check */}
      {isSelected && (
        <span className="absolute -top-1.5 -end-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-emerald-500 to-teal-500 shadow-sm">
          <Check className="h-3 w-3 text-white" strokeWidth={3} />
        </span>
      )}

      {/* Icon */}
      <span className="flex h-7 w-7 items-center justify-center select-none">
        {icon}
      </span>

      {/* Label */}
      <span
        className={cn(
          'w-full truncate text-xs font-medium leading-tight',
          isSelected
            ? 'text-emerald-700 dark:text-emerald-300'
            : 'text-gray-600 dark:text-gray-400 group-hover:text-emerald-600 dark:group-hover:text-emerald-400',
        )}
        title={label}
      >
        {label}
      </span>
    </button>
  );
}

// ─── Main component ───────────────────────────────────────────────────

export function AgencyCategorySelect({
  value,
  onChange,
  disabled,
  variant = 'grid',
}: AgencyCategorySelectProps) {
  const { t } = useLanguage();

  const [search, setSearch] = useState('');
  const [pickerOpen, setPickerOpen] = useState(false);

  const normalizedSearch = search.trim().toLowerCase();

  /**
   * Search matches the label in the CURRENT language first, but also in all
   * three languages (en/fr/ar dictionary lookups) so users can find a
   * category regardless of the active locale.
   */
  const filteredBuiltIns = useMemo(() => {
    if (!normalizedSearch) return BUILT_IN_CATEGORY_OPTIONS;
    return BUILT_IN_CATEGORY_OPTIONS.filter((opt) => {
      const localized = (['en', 'fr', 'ar'] as const).some((l) => {
        const label = translations[l]?.[tk(opt.labelKey)];
        return typeof label === 'string' && label.toLowerCase().includes(normalizedSearch);
      });
      return (
        localized ||
        opt.labelKey.toLowerCase().includes(normalizedSearch) ||
        opt.value.toLowerCase().includes(normalizedSearch)
      );
    });
  }, [normalizedSearch]);

  // ── Resolve the current selection (label + icon for the compact trigger).
  // Legacy non-built-in values (pre-reduction rows) fall back to the raw value.
  const selectedBuiltIn = BUILT_IN_CATEGORY_OPTIONS.find((o) => o.value === value);
  const selectedLabel = selectedBuiltIn ? t(tk(selectedBuiltIn.labelKey)) : value;

  // ── Select handler (single-select, value = enum key)
  const handleSelect = (next: string) => {
    onChange(next);
    // In compact mode selecting from the dialog closes it.
    if (variant === 'compact') setPickerOpen(false);
  };

  // ── Shared picker content (used inline and inside the compact dialog)
  const pickerContent = (
    <div className="space-y-4">
      {/* Search */}
      <div className="relative">
        <Search className="absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground pointer-events-none" />
        <Input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t(tk('searchCategory'))}
          disabled={disabled}
          className="h-10 rounded-xl ps-9"
          inputMode="search"
        />
      </div>

      {/* Built-in options — responsive card grid (4 agency types) */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-2.5">
        {filteredBuiltIns.map((opt) => (
          <CategoryCard
            key={opt.value}
            icon={<span className="text-xl sm:text-2xl">{opt.icon}</span>}
            label={t(tk(opt.labelKey))}
            isSelected={value === opt.value}
            disabled={disabled}
            onClick={() => handleSelect(opt.value)}
          />
        ))}
      </div>

      {filteredBuiltIns.length === 0 && normalizedSearch.length > 0 && (
        <p className="text-xs text-muted-foreground text-center">
          {t(tk('noMatchingCategory'))}
        </p>
      )}
    </div>
  );

  // ── Compact variant: Select-like trigger + picker dialog
  if (variant === 'compact') {
    return (
      <>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          onClick={() => setPickerOpen(true)}
          className="h-11 w-full justify-between rounded-xl border-gray-200 dark:border-gray-700 px-3 font-normal hover:border-emerald-300 dark:hover:border-emerald-700"
        >
          <span className="flex min-w-0 items-center gap-2">
            {selectedBuiltIn ? (
              <span className="text-base leading-none">{selectedBuiltIn.icon}</span>
            ) : value ? (
              <Tag className="h-4 w-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
            ) : null}
            <span className={cn('truncate text-sm', !value && 'text-muted-foreground')}>
              {value ? selectedLabel : t('agencyCategory')}
            </span>
          </span>
          <ChevronDown className="h-4 w-4 shrink-0 opacity-50" />
        </Button>

        <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
          <DialogContent className="sm:max-w-lg max-h-[85vh] overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-base">
                {selectedBuiltIn ? (
                  <span className="text-base leading-none">{selectedBuiltIn.icon}</span>
                ) : (
                  <Tag className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                )}
                {t('agencyCategory')}
              </DialogTitle>
              <DialogDescription className="sr-only">
                {t('agencyCategory')}
              </DialogDescription>
            </DialogHeader>
            {pickerContent}
          </DialogContent>
        </Dialog>
      </>
    );
  }

  // ── Grid variant: inline picker (wizard step)
  return pickerContent;
}
