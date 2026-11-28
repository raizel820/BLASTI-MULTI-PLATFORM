'use client';

import { useAppStore } from '@/store/use-app-store';
import { t as translate, setDictionary, type TranslationKeys, type Language } from '@/i18n';
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
  if (lang === 'fr' || lang === 'en') void ensureDictionary(lang);
  langListeners.forEach(l => l());
}

// ─── 0.6.127 — lazy dictionary loading ──────────────────────────────────
// Arabic ships statically (see i18n/index.ts); fr/en are on-demand chunks.
// The STORED preference starts loading at MODULE EVAL (below) so the chunk
// lands while the shell hydrates/boot-gates — components using useLanguage
// subscribe to `dictVersion` and re-render once their dictionary arrives.
let dictVersion = 0;
const dictListeners = new Set<() => void>();
const loadedLangs = new Set<Language>(['ar']);

function subscribeToDict(callback: () => void): () => void {
  dictListeners.add(callback);
  return () => { dictListeners.delete(callback); };
}

async function ensureDictionary(lang: Language): Promise<void> {
  if (loadedLangs.has(lang)) return;
  try {
    const mod = lang === 'fr'
      ? await import('@/i18n/fr')
      : lang === 'en'
        ? await import('@/i18n/en')
        : null;
    if (mod && mod.default) {
      setDictionary(lang, mod.default);
      loadedLangs.add(lang);
      dictVersion++;
      dictListeners.forEach(l => l());
    }
  } catch {
    /* dictionary failed to load — Arabic fallback stays active */
  }
}

// Initialize from localStorage
if (typeof window !== 'undefined') {
  const stored = localStorage.getItem('blasti-lang') as Language | null;
  if (stored) currentLang = stored;
  // Kick the on-demand dictionary chunk for a non-default stored language
  // IMMEDIATELY — parallel with hydration, invisible inside the boot gate.
  if (stored === 'fr' || stored === 'en') void ensureDictionary(stored);
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

  // Subscribe to dictionary arrival: when the fr/en chunk lands the hook
  // re-renders and every t() call resolves against the full dictionary.
  useSyncExternalStore(subscribeToDict, () => dictVersion, () => dictVersion);

  // Post-login language (user.language can differ from the stored one) —
  // make sure that dictionary is on its way too.
  if (typeof window !== 'undefined' && (effectiveLang === 'fr' || effectiveLang === 'en')) {
    void ensureDictionary(effectiveLang);
  }

  const t = useCallback((key: TranslationKeys, params?: Record<string, string>) => translate(key, effectiveLang, params), [effectiveLang]);

  return { lang: effectiveLang, t, setLang: setLanguage };
}
