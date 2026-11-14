'use client';

/**
 * Tiny i18n bridge for the TV screens. The TV renders standalone (no user
 * session), so the language comes from: URL ?lang= > device display settings
 * (passed by the caller) > the app-wide language hook.
 */

import { useLanguage } from '@/hooks/use-language';
import type { Language } from '@/i18n';

type TranslateFn = (key: string) => string;

export function useTranslationSafe(langOverride?: Language | string) {
  const { t, lang: hookLang } = useLanguage();
  const lang = (langOverride || hookLang || 'en') as string;
  return { t: t as TranslateFn, lang, rtl: lang === 'ar' };
}
