/**
 * session-heal — Cookie-based session self-repair.
 *
 * THE PROBLEM (real-world failure, reported 2024: "creating agency is failing
 * and I got logout when I click create agency after filling the form"):
 *
 * The browser holds TWO independent credentials for the cloud API:
 *   1. The JWT session cookie (httpOnly, set by the cloud at login/verify).
 *   2. The zustand `sessionToken` (persisted in localStorage) sent as
 *      `Authorization: Bearer` by apiClient/buildAuthHeaders.
 *
 * The cloud API extracts the Authorization header FIRST (auth.ts
 * extractTokenFromRequest) — a stale Bearer token therefore POISONS requests
 * even when the cookie is still perfectly valid. A Bearer goes stale whenever
 * the cloud DB no longer contains the user it names (DB replaced/reset while
 * the session survived, account re-created with a new id, dev DB file swap…).
 * The ghost JWT is then rejected on EVERY authed call ("Authentication
 * required" / SESSION_USER_MISSING) and the first write — POST /api/agencies —
 * nuked the session AFTER the user had filled the entire wizard.
 *
 * THE FIX: when auth suddenly fails, try POST /api/auth/refresh-session with
 * the COOKIE ONLY (no Authorization header). If the cookie is still valid the
 * cloud answers 200 with a FRESH token + user; we adopt them in place and the
 * user never notices. Only when the cookie is dead too do we log out.
 *
 * Electron is intentionally excluded: its auth target is the local API
 * (127.0.0.1:3080, Bearer-based, no cloud cookie) and it has its own session
 * restore machinery (fetch-with-retry handleAuthExpired + AuthProvider IPC).
 */

'use client';

import type { UserRole } from '@/store/use-app-store';

export interface HealedSession {
  token: string;
  user: {
    id: string;
    username: string;
    fullName: string;
    role: string;
    language: string;
    avatarUrl: string | null;
    agencyId: string | null;
  };
}

function isElectronLike(): boolean {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  return navigator.userAgent.includes('Electron') || !!(window as any).electronAPI;
}

/** True when the auth target is the Electron local API (no cookie heal). */
export function isElectronSessionContext(): boolean {
  return isElectronLike();
}

/**
 * Try to obtain a fresh session using the httpOnly cookie ONLY.
 * Returns null when healing is impossible (Electron, network error,
 * endpoint missing, or the cookie is dead as well) — callers must treat
 * null as "no heal available" and fall back to their existing behavior.
 */
export async function healSessionFromCookie(): Promise<HealedSession | null> {
  if (isElectronLike()) return null;
  try {
    const { buildCloudUrl } = await import('./api-client');
    // buildCloudUrl resolves the absolute cloud base on loopback/LAN hosts
    // (http://localhost:3003) or the gateway-relative URL + XTransformPort
    // in single-port environments.
    const res = await fetch(buildCloudUrl('/api/auth/refresh-session'), {
      method: 'POST',
      credentials: 'include', // cookie-only on purpose — NO Authorization header
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) return null; // 401 (cookie dead too), 404 (old server), …
    const data = await res.json().catch(() => null);
    if (!data?.success || !data?.token || !data?.user?.id) return null;
    return { token: data.token, user: data.user };
  } catch {
    return null; // network error — never act destructively from here
  }
}

/**
 * Adopt a healed session in place WITHOUT disturbing navigation.
 *
 * Uses a raw store setState instead of setUser() on purpose: setUser() resets
 * currentView to the role's default view, which would yank the user out of
 * the create-agency wizard (or wherever they are) mid-flow. The gentle update
 * only refreshes identity + token so the next request carries fresh
 * credentials.
 */
export async function applyHealedSession(healed: HealedSession): Promise<void> {
  const { useAppStore } = await import('@/store/use-app-store');
  const prev = useAppStore.getState().user;
  const language = (
    healed.user.language === 'fr' ? 'fr' : healed.user.language === 'en' ? 'en' : 'ar'
  ) as 'ar' | 'fr' | 'en';
  useAppStore.setState({
    user: {
      ...(prev || {}),
      id: healed.user.id,
      username: healed.user.username,
      fullName: healed.user.fullName,
      role: healed.user.role as UserRole,
      language,
      avatarUrl: healed.user.avatarUrl ?? prev?.avatarUrl,
      agencyId: healed.user.agencyId || prev?.agencyId || undefined,
    },
    sessionToken: healed.token,
  });
}
