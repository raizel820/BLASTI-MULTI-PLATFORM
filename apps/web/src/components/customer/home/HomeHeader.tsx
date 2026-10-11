'use client';

import { useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Search,
  QrCode,
  X,
  ScanLine,
  History,
  TicketCheck,
} from 'lucide-react';
import { motion } from 'framer-motion';
import type { AgencyListItem } from './types';
import { getAgencyName } from './types';

interface HomeHeaderProps {
  searchQuery: string;
  onSearchQueryChange: (query: string) => void;
  searchFocused: boolean;
  onSearchFocusedChange: (focused: boolean) => void;
  recentSearches: string[];
  onAddRecentSearch: (term: string) => void;
  onRemoveRecentSearch: (term: string) => void;
  onClearAllRecentSearches: () => void;
  showSuggestions: boolean;
  onShowSuggestionsChange: (show: boolean) => void;
  filteredCount: number;
  searchSuggestions: AgencyListItem[];
  agencyCode: string;
  onAgencyCodeChange: (code: string) => void;
  onJoinByCode: () => void;
  onQrScannerOpen: () => void;
  searchInputRef: React.RefObject<HTMLInputElement | null>;
  searchSectionRef: React.RefObject<HTMLDivElement | null>;
  t: (key: import("@/i18n").TranslationKeys) => string;
  lang: string;
}

export function HomeHeader({
  searchQuery,
  onSearchQueryChange,
  searchFocused,
  onSearchFocusedChange,
  recentSearches,
  onAddRecentSearch,
  onRemoveRecentSearch,
  onClearAllRecentSearches,
  showSuggestions,
  onShowSuggestionsChange,
  filteredCount,
  searchSuggestions,
  agencyCode,
  onAgencyCodeChange,
  onJoinByCode,
  onQrScannerOpen,
  searchInputRef,
  searchSectionRef,
  t,
  lang,
}: HomeHeaderProps) {
  const handleSearchSelect = (term: string) => {
    onSearchQueryChange(term);
    onAddRecentSearch(term);
    onShowSuggestionsChange(false);
    onSearchFocusedChange(false);
    searchInputRef.current?.blur();
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && searchQuery.trim()) {
      onAddRecentSearch(searchQuery.trim());
      onShowSuggestionsChange(false);
      onSearchFocusedChange(false);
    }
  };

  const handleSearchBlur = () => {
    setTimeout(() => {
      onSearchFocusedChange(false);
      onShowSuggestionsChange(false);
    }, 200);
  };

  return (
    <>
      {/* Header Title */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        className="mb-5 relative"
      >
        <div className="flex items-center gap-3 mb-1">
          <div className="h-1.5 w-8 rounded-full bg-gradient-to-r from-emerald-500 to-teal-500" />
          <h1 className="text-2xl font-bold bg-gradient-to-r from-emerald-600 via-teal-600 to-emerald-700 bg-clip-text text-transparent">{t('home')}</h1>
        </div>
        <p className="text-sm text-muted-foreground ms-[44px]">{t('welcomeSubtitle')}</p>
      </motion.div>

      {/* Search Bar */}
      <div ref={searchSectionRef} className="relative mb-4">
        <motion.div
          className="absolute start-4 top-1/2 -translate-y-1/2 z-10"
          animate={searchQuery === '' && !searchFocused ? { scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] } : { scale: 1, opacity: 1 }}
          transition={searchQuery === '' && !searchFocused ? { duration: 2, repeat: Infinity, ease: 'easeInOut' } : { duration: 0.2 }}
        >
          <Search className="h-5 w-5 text-muted-foreground" />
        </motion.div>
        <Input
          ref={searchInputRef}
          placeholder={t('searchAgency')}
          value={searchQuery}
          onChange={(e) => {
            onSearchQueryChange(e.target.value);
            onShowSuggestionsChange(true);
          }}
          onFocus={() => {
            onSearchFocusedChange(true);
            onShowSuggestionsChange(true);
          }}
          onBlur={handleSearchBlur}
          onKeyDown={handleSearchKeyDown}
          className="ps-11 pe-20 h-12 text-base rounded-xl bg-white dark:bg-gray-900/80 shadow-sm border-gray-200 dark:border-gray-800 dark:backdrop-blur-sm"
        />
        {/* Search result count & clear button */}
        <div className="absolute end-3 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {searchQuery.trim() && !showSuggestions && (
            <span className="text-[10px] text-muted-foreground font-medium">
              {filteredCount} {t('searchResultsCount')}
            </span>
          )}
          {searchQuery && (
            <button
              onClick={() => { onSearchQueryChange(''); onSearchFocusedChange(false); onShowSuggestionsChange(false); }}
              className="h-6 w-6 rounded-full flex items-center justify-center hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors"
              aria-label={t('clearSearch')}
            >
              <X className="h-3.5 w-3.5 text-muted-foreground" />
            </button>
          )}
        </div>
        {/* Search Suggestions Dropdown */}
        {(searchFocused || showSuggestions) && (searchSuggestions.length > 0 || searchQuery === '') && (
          <div className="absolute top-full mt-1 start-0 end-0 z-[60] bg-white dark:bg-gray-900 border border-border rounded-xl shadow-lg overflow-hidden">
            {searchQuery === '' && recentSearches.length > 0 ? (
              <>
                <div className="flex items-center justify-between px-3 py-2 border-b border-border">
                  <div className="flex items-center gap-1.5">
                    <History className="h-3.5 w-3.5 text-muted-foreground" />
                    <span className="text-xs font-semibold text-muted-foreground">{t('recentSearches')}</span>
                  </div>
                  <button
                    onClick={onClearAllRecentSearches}
                    className="text-[10px] text-teal-600 dark:text-teal-400 hover:underline font-medium"
                  >
                    {t('clearSearchHistory' as any)}
                  </button>
                </div>
                {recentSearches.map((term) => (
                  <button
                    key={term}
                    onClick={() => handleSearchSelect(term)}
                    className="w-full flex items-center justify-between px-3 py-2.5 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors text-start"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                      <span className="text-sm text-foreground truncate">{term}</span>
                    </div>
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemoveRecentSearch(term); }}
                      className="h-5 w-5 rounded-full flex items-center justify-center hover:bg-gray-200 dark:hover:bg-gray-700 flex-shrink-0"
                    >
                      <X className="h-3 w-3 text-muted-foreground" />
                    </button>
                  </button>
                ))}
              </>
            ) : searchQuery === '' && recentSearches.length === 0 ? (
              <div className="px-3 py-4 text-center">
                <History className="h-5 w-5 text-muted-foreground/40 mx-auto mb-1.5" />
                <p className="text-xs text-muted-foreground">{t('noRecentSearches' as any)}</p>
              </div>
            ) : searchSuggestions.length > 0 ? (
              <>
                <div className="px-3 py-2 border-b border-border">
                  <span className="text-xs font-semibold text-muted-foreground">{t('suggestions')}</span>
                </div>
                {searchSuggestions.map((agency) => (
                  <button
                    key={agency.id}
                    onClick={() => handleSearchSelect(getAgencyName(agency, lang))}
                    className="w-full flex items-center gap-2 px-3 py-2.5 hover:bg-emerald-50 dark:hover:bg-emerald-900/10 transition-colors text-start"
                  >
                    <div className="h-8 w-8 rounded-lg bg-emerald-100 dark:bg-emerald-900/30 flex items-center justify-center flex-shrink-0">
                      <TicketCheck className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{getAgencyName(agency, lang)}</p>
                      <p className="text-[10px] text-muted-foreground truncate">{agency.address}</p>
                    </div>
                  </button>
                ))}
              </>
            ) : null}
          </div>
        )}
      </div>

      {/* Agency Code Input + Scan QR */}
      <div className="flex gap-2 mb-5">
        <Input
          placeholder={t('enterAgencyCode')}
          value={agencyCode}
          onChange={(e) => onAgencyCodeChange(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && onJoinByCode()}
          className="h-11 text-sm rounded-xl input-emerald-glow"
          dir="ltr"
        />
        <Button
          variant="outline"
          className="h-11 px-3 rounded-xl border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={onQrScannerOpen}
          aria-label={t('scanQrCode')}
        >
          <ScanLine className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          className="h-11 px-4 rounded-xl border-emerald-300 text-emerald-700 dark:border-emerald-700 dark:text-emerald-400 hover:bg-emerald-50 dark:hover:bg-emerald-900/20"
          onClick={onJoinByCode}
        >
          <QrCode className="h-4 w-4 me-1.5" />
          {t('joinQueue')}
        </Button>
      </div>
    </>
  );
}
