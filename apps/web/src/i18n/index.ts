import ar from './ar';
import fr from './fr';
import en from './en';
import type { TranslationKeys } from './ar';

export type { TranslationKeys };
export type Language = 'ar' | 'fr' | 'en';

export const translations: Record<Language, Record<TranslationKeys, string>> = { ar, fr, en };

export const languageNames: Record<Language, string> = {
  ar: 'العربية',
  fr: 'Français',
  en: 'English',
};

export const isRTL = (lang: Language) => lang === 'ar';

// ─── Agencies Management — per-category terminology engine ───────────────────
// Agency-scoped screens (agency profile, queue, owner dashboard) activate a
// term map via setActiveCategoryTerms() (see hooks/use-category-terms.ts).
// Every t()/translate() call then resolves overridden keys FIRST, so existing
// components render "Patient" instead of "Customer" without any edits.
// Shape: { i18nKey: { ar, en, fr } }.
type TermTriple = { ar: string; en: string; fr: string };
let activeCategoryTerms: Record<string, TermTriple> = {};

export function setActiveCategoryTerms(terms: Record<string, TermTriple> | null | undefined): void {
  activeCategoryTerms = terms ?? {};
}

export function getActiveCategoryTerms(): Record<string, TermTriple> {
  return activeCategoryTerms;
}

export function t(key: TranslationKeys, lang: Language, params?: Record<string, string>): string {
  let str: string;
  const term = activeCategoryTerms[key as string];
  if (term && (term[lang] || term.ar)) {
    str = term[lang] || term.ar;
  } else {
    str = translations[lang]?.[key] ?? translations.ar[key] ?? key;
  }
  if (params) {
    Object.entries(params).forEach(([k, v]) => {
      str = str.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
    });
  }
  return str;
}
