import ar from './ar';
import type { TranslationKeys } from './ar';

export type { TranslationKeys };
export type Language = 'ar' | 'fr' | 'en';

// 0.6.127 perf — BUNDLE: all three dictionaries (~880KB of TS source) used
// to ship statically in the ENTRY CHUNK while only one language is ever
// active at runtime. Arabic (the app default + primary audience) stays
// static so first paint is instant with zero key flashes; French/English
// load as on-demand chunks (kicked at boot from use-language for the stored
// preference) and are cached here. `translations` keeps its old shape via a
// Proxy that falls back to Arabic until the active dictionary lands.
const dictionaries: Partial<Record<Language, Record<TranslationKeys, string>>> = { ar };

export const translations: Record<Language, Record<TranslationKeys, string>> = new Proxy(
  dictionaries as Record<Language, Record<TranslationKeys, string>>,
  {
    get(target, prop: string) {
      return target[prop as Language] ?? target.ar;
    },
  }
) as Record<Language, Record<TranslationKeys, string>>;

/** Register a lazily-loaded dictionary (called from use-language). */
export function setDictionary(lang: Language, dict: Record<TranslationKeys, string>): void {
  dictionaries[lang] = dict;
}

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
