'use client';

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

/**
 * Language revert fix (Agencies Management session): persist the choice.
 * `blasti-lang` was read at boot by several modules but NEVER written by
 * anyone — a pre-login/kiosk language choice died on every reload, and the
 * login screens silently fell back to Arabic. Writing it here makes the
 * external store survive reloads.
 */
export function setLanguage(lang: Language) {
  currentLang = lang;
  try {
    if (typeof window !== 'undefined') {
      localStorage.setItem('blasti-lang', lang);
    }
  } catch {
    /* storage unavailable (private mode) — session-only choice */
  }
  langListeners.forEach(l => l());
}

// Initialize from localStorage
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('blasti-lang') as Language | null;
  if (stored) currentLang = stored;
}

/**
 * Login-adopt helper (language revert fix): the server user row carries the
 * DB language (default 'ar' when the account never saved a preference), and
 * `setUser(data.user)` used to snap the UI back to Arabic right after login —
 * even when the user had just picked English/French on the login screen.
 *
 * If a local preference exists and differs from the server value, keep the
 * LOCAL choice and persist it server-side (fire-and-forget PATCH — the
 * switcher/site flows own error handling; failure is silent by design).
 */
export function adoptLocalLanguagePreference<T extends { language?: string; id?: string }>(
  serverUser: T,
): T {
  if (typeof window === 'undefined') return serverUser;
  let stored: string | null = null;
  try {
    stored = localStorage.getItem('blasti-lang');
  } catch {
    return serverUser;
  }
  const localLang = (stored && ['ar', 'fr', 'en'].includes(stored) ? stored : currentLang) as Language;
  if (!localLang || !serverUser || serverUser.language === localLang) return serverUser;
  // Keep the local choice in the adopted user object…
  const merged = { ...serverUser, language: localLang };
  // Stamp the guard so a just-armed profile refresher cannot clobber the
  // adopted choice before the PATCH below settles.
  import('@/lib/user-store-refresh')
    .then(({ markLocalLanguageMutation }) => markLocalLanguageMutation())
    .catch(() => { /* never blocks adoption */ });
  // …and persist it server-side when we know who we are.
  if (serverUser.id) {
    import('@/lib/api-fetch')
      .then(({ apiFetch }) =>
        apiFetch('/api/user/profile', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ userId: serverUser.id, language: localLang }),
        }),
      )
      .catch(() => { /* silent — the refresher guard keeps the local choice */ });
  }
  return merged;
}

export function useLanguage() {
  const user = useAppStore((s) => s.user);
  
  const getSnapshot = () => {
    if (user?.language) return user.language;
    return currentLang;
  };

  const getServerSnapshot = () => 'ar' as Language;

  const effectiveLang = useSyncExternalStore(subscribeToLang, getSnapshot, getServerSnapshot);

  const t = useCallback((key: TranslationKeys, params?: Record<string, string>) => translate(key, effectiveLang, params), [effectiveLang]);

  return { lang: effectiveLang, t, setLang: setLanguage };
}
