'use client';

/**
 * AgencyCategorySelect — shared, RTL-aware, searchable agency category picker.
 *
 * ONE source of truth: BUILT_IN_CATEGORY_OPTIONS (25 built-ins) + the custom
 * rows from useAgencyCategories() (synced AgencyCategory model). Used by the
 * agency creation wizard (variant="grid") and the profile settings
 * (variant="compact").
 *
 * Value semantics (Task 42 contract):
 *  - built-in  → Agency.category stores the enum key (e.g. 'CLINIC')
 *  - custom    → Agency.category stores the user-entered name, displayed as-is
 *
 * Colors: emerald/amber/rose/red family only (no indigo/blue), semantic
 * tokens for dark mode.
 */

import { useEffect, useMemo, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import {
  BUILT_IN_CATEGORY_OPTIONS,
  useAgencyCategories,
  type AgencyCategoryRow,
} from '@/hooks/use-agency-categories';
import { translations, type TranslationKeys } from '@/i18n';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Check, ChevronDown, Loader2, Plus, Search, Tag } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';

export interface AgencyCategorySelectProps {
  /** Current selection: built-in enum key ('CLINIC') or custom name. */
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

/** Cast a (not-yet-typed) i18n key for t() — keys land with the i18n pass. */
const tk = (key: string) => key as TranslationKeys;

// ─── Option card ──────────────────────────────────────────────────────

function CategoryCard({
  icon,
  label,
  isSelected,
  disabled,
  badge,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  isSelected: boolean;
  disabled?: boolean;
  badge?: React.ReactNode;
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

      {/* Optional badge slot (custom tag) */}
      {badge}
    </button>
  );
}

// ─── Create-category dialog ───────────────────────────────────────────

function CreateCategoryDialog({
  open,
  onOpenChange,
  defaultName,
  disabled,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  defaultName?: string;
  disabled?: boolean;
  onCreate: (
    name: string,
  ) => Promise<{ ok: boolean; error?: string; name?: string }>;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Pick up the search text as a starting point whenever the dialog opens.
  useEffect(() => {
    if (open) {
      setName(defaultName ?? '');
      setError(null);
    }
  }, [open, defaultName]);

  const handleCreate = async () => {
    if (creating) return;
    setError(null);
    setCreating(true);
    try {
      const res = await onCreate(name);
      if (res.ok) {
        toast.success(t(tk('categoryCreated')));
        onOpenChange(false);
        setName('');
      } else {
        setError(res.error ?? 'FETCH_FAILED');
      }
    } finally {
      setCreating(false);
    }
  };

  const errorMessage =
    error === 'CATEGORY_EXISTS'
      ? t(tk('categoryExistsError'))
      : error === 'INVALID_NAME'
        ? t(tk('categoryNameInvalid'))
        : error
          ? t(tk('createCategoryError'))
          : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setError(null);
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Tag className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
            {t(tk('createNewField'))}
          </DialogTitle>
          <DialogDescription className="sr-only">
            {t(tk('createNewField'))}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="new-category-name">{t(tk('newFieldName'))}</Label>
            <Input
              id="new-category-name"
              value={name}
              onChange={(e) => {
                setName(e.target.value);
                setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  handleCreate();
                }
              }}
              placeholder={t(tk('newFieldNamePlaceholder'))}
              disabled={disabled || creating}
              maxLength={40}
              className="h-10 rounded-xl"
              autoFocus
            />
          </div>

          {errorMessage && (
            <p className="text-xs text-red-500" role="alert">
              {errorMessage}
            </p>
          )}

          <Button
            type="button"
            onClick={handleCreate}
            disabled={disabled || creating || !name.trim()}
            className="w-full h-10 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white"
          >
            {creating ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            {t(tk('create'))}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
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
  const { customCategories, loading, createCategory } = useAgencyCategories();

  const [search, setSearch] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  const normalizedSearch = search.trim().toLowerCase();

  /**
   * Search matches the label in the CURRENT language first, but also in all
   * three languages (en/fr/ar dictionary lookups) so users can find a
   * category regardless of the active locale. Custom rows match their
   * user-entered name (+ optional FR/AR variants) as-is.
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

  const filteredCustoms = useMemo(() => {
    if (!normalizedSearch) return customCategories;
    return customCategories.filter((c) =>
      [c.name, c.nameFr, c.nameAr]
        .filter((v): v is string => typeof v === 'string' && v.length > 0)
        .some((v) => v.toLowerCase().includes(normalizedSearch)),
    );
  }, [customCategories, normalizedSearch]);

  // ── Resolve the current selection (label + icon for the compact trigger)
  const selectedBuiltIn = BUILT_IN_CATEGORY_OPTIONS.find((o) => o.value === value);
  const selectedCustom = customCategories.find((c) => c.name === value);
  const selectedLabel = selectedBuiltIn
    ? t(tk(selectedBuiltIn.labelKey))
    : selectedCustom
      ? selectedCustom.name
      : value;

  // ── Select handler (single-select, value = enum key or custom name)
  const handleSelect = (next: string) => {
    onChange(next);
    // In compact mode selecting from the dialog closes it.
    if (variant === 'compact') setPickerOpen(false);
  };

  const handleCreate = async (name: string) => {
    const res = await createCategory(name);
    if (res.ok) {
      onChange(res.category.name);
      if (variant === 'compact') setPickerOpen(false);
      return { ok: true, name: res.category.name };
    }
    return { ok: false, error: res.error };
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

      {/* Built-in options — responsive card grid */}
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

      {/* Custom fields section */}
      {(loading || filteredCustoms.length > 0 || normalizedSearch.length > 0) && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Tag className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t(tk('customFields'))}
            </span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2 sm:gap-2.5">
            {loading &&
              filteredCustoms.length === 0 &&
              [0, 1].map((i) => <Skeleton key={i} className="h-[74px] rounded-xl" />)}
            {filteredCustoms.map((row: AgencyCategoryRow) => (
              <CategoryCard
                key={row.id}
                icon={<Tag className="h-5 w-5 text-emerald-600 dark:text-emerald-400" />}
                label={row.name}
                isSelected={value === row.name}
                disabled={disabled}
                onClick={() => handleSelect(row.name)}
                badge={
                  <Badge
                    variant="outline"
                    className="pointer-events-none absolute top-1.5 start-1.5 border-emerald-200 dark:border-emerald-800 bg-emerald-50 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300 text-[9px] px-1.5 py-0 h-4"
                  >
                    {t(tk('customBadge'))}
                  </Badge>
                }
              />
            ))}
          </div>
          {!loading && filteredCustoms.length === 0 && normalizedSearch.length > 0 && (
            <p className="text-xs text-muted-foreground">{t(tk('noMatchingCategory'))}</p>
          )}
        </div>
      )}

      {/* Create-new affordance */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setCreateOpen(true)}
        className={cn(
          'flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed p-3 text-sm font-medium transition-colors cursor-pointer',
          'border-gray-300 dark:border-gray-700 text-muted-foreground',
          'hover:border-emerald-400 dark:hover:border-emerald-600 hover:text-emerald-600 dark:hover:text-emerald-400 hover:bg-emerald-50/50 dark:hover:bg-emerald-900/10',
          disabled && 'opacity-60 cursor-not-allowed',
        )}
      >
        <Plus className="h-4 w-4" />
        {t(tk('createNewField'))}
      </button>

      {/* Create dialog */}
      <CreateCategoryDialog
        open={createOpen}
        onOpenChange={setCreateOpen}
        defaultName={normalizedSearch ? search.trim() : undefined}
        disabled={disabled}
        onCreate={handleCreate}
      />
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
            ) : selectedCustom || value ? (
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
