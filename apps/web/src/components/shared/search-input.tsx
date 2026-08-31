'use client';

import { useState, useCallback, useRef } from 'react';
import { Search, X, Loader2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { isRTL } from '@/i18n';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  onClear?: () => void;
  loading?: boolean;
  debounceMs?: number;
  className?: string;
}

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search...',
  onClear,
  loading = false,
  debounceMs = 500,
  className,
}: SearchInputProps) {
  const { lang } = useLanguage();
  const rtl = isRTL(lang);
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [focused, setFocused] = useState(false);

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const newValue = e.target.value;
      onChange(newValue);

      // Debounced callback for external consumers who need throttled updates
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current);
      }
      debounceTimerRef.current = setTimeout(() => {
        // The parent already receives immediate updates via onChange above.
        // This timer is available for future extensibility.
      }, debounceMs);
    },
    [onChange, debounceMs]
  );

  const handleClear = useCallback(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current);
    }
    onChange('');
    onClear?.();
  }, [onChange, onClear]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      // Clear on Escape
      if (e.key === 'Escape' && value) {
        handleClear();
        e.currentTarget.blur();
      }
    },
    [value, handleClear]
  );

  return (
    <div className={cn('relative', className)}>
      {/* Search icon — on the start side (left in LTR, right in RTL) */}
      <Search
        className={cn(
          'absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none transition-colors',
          rtl ? 'right-3' : 'left-3',
          focused && 'text-emerald-600 dark:text-emerald-400'
        )}
      />

      {/* Input */}
      <Input
        type="text"
        value={value}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        dir={rtl ? 'rtl' : 'ltr'}
        className={cn(
          'h-10 transition-all duration-200',
          // Padding: icon side gets extra padding
          rtl
            ? 'pl-4 pr-10'
            : 'pl-10 pr-4',
          // Focus ring with emerald tint
          'focus-visible:border-emerald-500 focus-visible:ring-emerald-500/20',
          // Clear button space
          value && (rtl ? 'pl-10' : 'pr-10')
        )}
      />

      {/* Loading indicator */}
      {loading && !value && (
        <Loader2
          className={cn(
            'absolute top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin pointer-events-none',
            rtl ? 'right-3' : 'left-3'
          )}
        />
      )}

      {/* Clear button — on the end side (right in LTR, left in RTL) */}
      {value && !loading && (
        <button
          type="button"
          onClick={handleClear}
          className={cn(
            'absolute top-1/2 -translate-y-1/2 flex h-5 w-5 items-center justify-center',
            'rounded-full text-muted-foreground hover:text-foreground',
            'hover:bg-muted transition-colors pointer-events-auto',
            rtl ? 'left-3' : 'right-3'
          )}
          aria-label="Clear search"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  );
}
