'use client';

/**
 * Task 5 — Algeria address selectors (58 wilayas × 1541 communes).
 *
 * Shared Radix/shadcn Select pair used by the register form, the
 * create-agency wizard and the agency profile page. Values are stored in the
 * canonical forms the API expects:
 *   - wilaya  → the official two-digit ANI code ('01'..'58')
 *   - commune → the Latin baladiya name (e.g. "Bab El Oued")
 * while the VISIBLE labels follow the current UI language (Arabic names in
 * ar, Latin names otherwise) via wilayaLabel/communeLabel.
 *
 * Pure presentation — no fetching, no persistence. Callers own the state,
 * pass the current `lang`, and style the triggers to match their local form
 * language via triggerClassName.
 */

import { useMemo } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  ALGERIA_WILAYAS,
  communeLabel,
  findWilayaByCode,
  wilayaLabel,
} from '@/lib/algeria-locations';

/** Base trigger styling shared by every consumer (RTL-safe: w-full). */
export const ALGERIA_SELECT_TRIGGER_BASE =
  'w-full justify-between [&>span]:line-clamp-1 [&>span]:truncate';

interface WilayaSelectProps {
  /** Selected two-digit wilaya code ('01'..'58') or '' when unselected. */
  value: string;
  onValueChange: (code: string) => void;
  /** Current UI language ('ar' shows Arabic wilaya names). */
  lang: string;
  /** Placeholder (already translated by the caller). */
  placeholder: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  triggerClassName?: string;
}

/**
 * Wilaya selector — one option per wilaya, labelled "16 - Alger"
 * (Latin) / "16 - الجزائر" (Arabic) by the current language.
 */
export function WilayaSelect({
  value,
  onValueChange,
  lang,
  placeholder,
  disabled,
  id,
  triggerClassName,
  ...aria
}: WilayaSelectProps) {
  return (
    <Select value={value || undefined} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger
        id={id}
        className={[ALGERIA_SELECT_TRIGGER_BASE, triggerClassName].filter(Boolean).join(' ')}
        {...aria}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {ALGERIA_WILAYAS.map((w) => (
          <SelectItem key={w.code} value={w.code}>
            {wilayaLabel(w, lang)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

interface CommuneSelectProps {
  /** Parent wilaya code — the commune list is disabled/empty without it. */
  wilayaCode: string;
  /** Selected commune LATIN name or '' when unselected. */
  value: string;
  onValueChange: (name: string) => void;
  /** Current UI language ('ar' shows Arabic commune names). */
  lang: string;
  /** Placeholder (already translated by the caller). */
  placeholder: string;
  disabled?: boolean;
  id?: string;
  'aria-label'?: string;
  triggerClassName?: string;
}

/**
 * Commune (baladiya) selector — options are the selected wilaya's communes
 * in the current language; the STORED value stays the Latin name. Disabled
 * until a wilaya is chosen.
 */
export function CommuneSelect({
  wilayaCode,
  value,
  onValueChange,
  lang,
  placeholder,
  disabled,
  id,
  triggerClassName,
  ...aria
}: CommuneSelectProps) {
  const communes = useMemo(
    () => findWilayaByCode(wilayaCode)?.communes ?? [],
    [wilayaCode],
  );
  const noWilaya = !wilayaCode || communes.length === 0;
  return (
    <Select
      value={value || undefined}
      onValueChange={onValueChange}
      disabled={disabled || noWilaya}
    >
      <SelectTrigger
        id={id}
        className={[ALGERIA_SELECT_TRIGGER_BASE, triggerClassName].filter(Boolean).join(' ')}
        {...aria}
      >
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="max-h-72">
        {communes.map((c) => (
          <SelectItem key={c.name} value={c.name}>
            {communeLabel(c, lang)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/**
 * "16 - Alger · Bab El Oued" — composed location hint for the current
 * language. Returns null when the wilaya is unknown.
 */
export function composeLocationLabel(
  wilayaCode: string,
  commune: string | null | undefined,
  lang: string,
): string | null {
  const w = findWilayaByCode(wilayaCode);
  if (!w) return null;
  const base = wilayaLabel(w, lang);
  return commune ? `${base} · ${commune}` : base;
}
