'use client';

// ─── Task 4: agency search combobox ────────────────────────────────────────
// Searchable, keyboard-accessible combobox (Popover + cmdk Command) backed by
// GET /api/admin/agencies?search=<text>&limit=8. Debounced ~300ms, fires at
// 2+ characters, shows loading spinner / min-chars hint / empty state, and
// renders each hit as name + customCode + city + category badge.
// Selecting a result switches the whole dashboard into per-agency mode.

import { useCallback, useEffect, useRef, useState } from 'react';
import { useLanguage } from '@/hooks/use-language';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Command,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiFetch } from '@/lib/api-fetch';
import { useDebounce } from '@/hooks/use-debounce';
import { translateCategory } from '@/lib/enum-i18n';
import { Building2, Loader2, MapPin, Search, X } from 'lucide-react';
import { ak } from './i18n-keys';
import type { AdminAgencySearchResult, AdminSelectedAgency } from './types';

function normalizeRows(body: unknown): AdminAgencySearchResult[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const raw = Array.isArray(b.agencies)
    ? b.agencies
    : b.data && typeof b.data === 'object' && Array.isArray((b.data as Record<string, unknown>).agencies)
      ? (b.data as Record<string, unknown>).agencies
      : [];
  return (raw as Record<string, unknown>[])
    .filter((r) => r && typeof r.id === 'string' && r.id)
    .map((r) => ({
      id: String(r.id),
      name: typeof r.name === 'string' ? r.name : '—',
      customCode: typeof r.customCode === 'string' ? r.customCode : '',
      category: typeof r.category === 'string' ? r.category : '',
      city: typeof r.city === 'string' ? r.city : null,
      isActive: r.isActive !== false,
    }));
}

export function AgencySearch({
  selected,
  onSelect,
  onClear,
}: {
  selected: AdminSelectedAgency | null;
  onSelect: (agency: AdminSelectedAgency) => void;
  onClear: () => void;
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<AdminAgencySearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const debouncedQuery = useDebounce(query, 300);
  const seqRef = useRef(0);

  const trimmed = debouncedQuery.trim();

  const runSearch = useCallback(async (q: string) => {
    const seq = ++seqRef.current;
    setLoading(true);
    try {
      const res = await apiFetch(
        `/api/admin/agencies?search=${encodeURIComponent(q)}&limit=8`,
        { method: 'GET' },
      );
      if (seq !== seqRef.current) return; // superseded
      if (!res.ok) {
        setResults([]);
        return;
      }
      const body: unknown = await res.json();
      if (seq !== seqRef.current) return;
      setResults(normalizeRows(body));
    } catch {
      if (seq === seqRef.current) setResults([]);
    } finally {
      if (seq === seqRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (trimmed.length < 2) {
      seqRef.current += 1; // invalidate any in-flight request
      setResults([]);
      setLoading(false);
      return;
    }
    runSearch(trimmed);
  }, [trimmed, runSearch]);

  const pick = (r: AdminAgencySearchResult) => {
    onSelect({
      id: r.id,
      name: r.name,
      customCode: r.customCode,
      category: r.category,
      city: r.city,
      isActive: r.isActive,
    });
    setOpen(false);
    setQuery('');
    setResults([]);
  };

  const minCharsHint = trimmed.length > 0 && trimmed.length < 2;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <div className="flex items-center gap-1.5 w-full lg:w-80">
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-label={t(ak('adminAnalytics.searchAgency'))}
            className="h-10 w-full justify-start gap-2 font-normal text-xs rounded-xl"
          >
            <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
            {selected ? (
              <span className="truncate font-semibold text-foreground">{selected.name}</span>
            ) : (
              <span className="truncate text-muted-foreground">
                {t(ak('adminAnalytics.searchAgencyPlaceholder'))}
              </span>
            )}
          </Button>
        </PopoverTrigger>
        {selected && (
          <Button
            variant="outline"
            size="icon"
            className="h-10 w-10 shrink-0 rounded-xl"
            onClick={onClear}
            aria-label={t(ak('adminAnalytics.clearAgencyFilter'))}
            title={t(ak('adminAnalytics.clearAgencyFilter'))}
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>
      <PopoverContent className="p-0 w-(--radix-popover-trigger-width) min-w-72 rounded-xl" align="end" sideOffset={6}>
        <Command shouldFilter={false} className="rounded-xl">
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder={t(ak('adminAnalytics.searchAgencyPlaceholder'))}
            className="text-xs"
          />
          <CommandList className="max-h-72 overflow-y-auto custom-scrollbar">
            {loading && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin text-emerald-600 dark:text-emerald-400" />
                {t(ak('adminAnalytics.searching'))}
              </div>
            )}
            {!loading && trimmed.length < 2 && (
              <div className="flex items-center justify-center gap-2 py-6 px-4 text-xs text-muted-foreground text-center">
                <Search className="h-3.5 w-3.5 shrink-0" />
                {t(ak('adminAnalytics.searchMinChars'))}
              </div>
            )}
            {!loading && trimmed.length >= 2 && results.length === 0 && (
              <div className="py-6 px-4 text-xs text-muted-foreground text-center">
                {t(ak('adminAnalytics.searchNoResults'))}
              </div>
            )}
            {!loading && results.length > 0 && (
              <CommandGroup>
                {results.map((r) => (
                  <CommandItem
                    key={r.id}
                    value={r.id}
                    onSelect={() => pick(r)}
                    className="gap-2.5 py-2.5 cursor-pointer"
                  >
                    <div className="h-8 w-8 rounded-lg bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400 flex items-center justify-center shrink-0">
                      <Building2 className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-bold text-foreground truncate" title={r.name}>
                        {r.name}
                      </p>
                      <p className="text-[10px] text-muted-foreground flex items-center gap-1.5 truncate">
                        {r.customCode && <span dir="ltr">{r.customCode}</span>}
                        {r.city && (
                          <span className="inline-flex items-center gap-0.5 truncate">
                            <MapPin className="h-2.5 w-2.5" />
                            {r.city}
                          </span>
                        )}
                      </p>
                    </div>
                    {r.category && (
                      <Badge
                        variant="secondary"
                        className="text-[9px] px-1.5 h-4 shrink-0 font-medium"
                      >
                        {translateCategory(r.category, t)}
                      </Badge>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
