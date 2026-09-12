/**
 * useLanguage — Desktop adapter
 *
 * Now backed by the full i18n module (copied from Web).
 * Falls back to 'ar' (Arabic) as the default language.
 */

import { useAppStore } from '@/store/use-app-store';
import { t as translate, type TranslationKeys, type Language } from '@/i18n';
import { useSyncExternalStore, useCallback } from 'react';

// Simple external store for language changes outside of Zustand (pre-login)
let currentLang: Language = 'ar';
const langListeners = new Set<() => void>();

function getLangSnapshot(): Language {
  return currentLang;
}

function subscribeToLang(callback: () => void): () => void {
  langListeners.add(callback);
  return () => langListeners.delete(callback);
}

export function setLanguage(lang: Language) {
  currentLang = lang;
  langListeners.forEach(l => l());
  // Persist to localStorage
  try {
    localStorage.setItem('blasti-lang', lang);
  } catch {}
}

// Initialize from localStorage
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('blasti-lang') as Language | null;
  if (stored && ['ar', 'fr', 'en'].includes(stored)) currentLang = stored;
}

export function useLanguage() {
  const user = useAppStore((s) => s.user);
  
  const getSnapshot = () => {
    if (user?.language) return user.language as Language;
    return currentLang;
  };

  // Desktop doesn't do SSR, but we keep the pattern for consistency
  const getServerSnapshot = () => 'ar' as Language;

  const effectiveLang = useSyncExternalStore(subscribeToLang, getSnapshot, getServerSnapshot);

  // Widen the type to `string` because some shared components pass dynamic keys
  // that aren't in the strict TranslationKeys union (e.g., t(agency.category)).
  // If the key isn't found, translate() falls back to the key itself.
  const t = useCallback((key: string, params?: Record<string, string>) => translate(key as TranslationKeys, effectiveLang, params), [effectiveLang]);

  return { lang: effectiveLang, t, setLang: setLanguage };
}
