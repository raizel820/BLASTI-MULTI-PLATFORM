'use client';

/**
 * avatar-override — the "upload succeeded but the avatar goes placeholder"
 * killer (mobile field report: "worked at first when I opened the app, but
 * after I uploaded a new profile image it showed a placeholder again").
 *
 * THE GAP: uploading a NEW avatar swaps the store's avatarUrl to a URL that
 * has NEVER been fetched by this device. The freshly-uploaded bytes are
 * ALREADY IN MEMORY (the picked File), yet every avatar consumer immediately
 * re-renders <img src={theBrandNewUrl}> — and if that one network request
 * fails for ANY reason (mobile network blip, WebView image policy applied to
 * a not-yet-cached URL, server hiccup), consumers WITHOUT the useAvatarSrc
 * safety net (e.g. the customer home-screen header, missed by the A-1 sweep)
 * flip to a permanent placeholder. Even WITH the safety net there is a
 * visible flash of initials while retry/fallback run.
 *
 * THE FIX: the upload-confirm flows register the LOCAL bytes of the file
 * they are holding as a session-scoped override keyed by the EXACT avatarUrl
 * the server just handed back. Every consumer (UserAvatar + raw <img> sites
 * via useSessionAvatarOverride) renders those local bytes INSTANTLY — zero
 * network, zero policy, zero retry window. The override lives only in
 * module memory (never persisted): after an app restart the normal
 * server-URL pipeline takes over, which the same field report proves works
 * ("when opened the app it shows the real profile image").
 *
 * Keying by the avatarUrl STRING (not the user id) means:
 *   • no userId plumbing through components that only know a URL;
 *   • an override can never leak onto a DIFFERENT/older avatar — the key
 *     must match the URL being rendered;
 *   • clearing on change is automatic — a new upload registers a new key.
 */

import { useEffect, useState } from 'react';
import { getProxiedUrl } from './utils';
import { nativeImageDataUrl } from './avatar-src';

/** avatarUrl → locally-held data: URL. Bounded, session-scoped. */
const overrides = new Map<string, string>();

/** Max cached overrides — avatars swap rarely; a tiny cap bounds memory. */
const MAX_ENTRIES = 5;

type Listener = () => void;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      /* a broken subscriber must never break the registry */
    }
  }
}

/**
 * Register the local bytes for a freshly-uploaded avatar URL.
 * `dataUrl` should be a `data:image/...;base64,...` string read from the
 * very File the user picked. Called by the upload-confirm flows.
 */
export function registerAvatarOverride(avatarUrl: string, dataUrl: string): void {
  if (!avatarUrl || !dataUrl) return;
  // Evict the oldest entry when the registry is full.
  if (overrides.size >= MAX_ENTRIES && !overrides.has(avatarUrl)) {
    const oldest = overrides.keys().next().value;
    if (oldest !== undefined) overrides.delete(oldest);
  }
  overrides.set(avatarUrl, dataUrl);
  emit();
}

/** Test/diagnostic hook — drop every override (next render falls back to URLs). */
export function clearAvatarOverrides(): void {
  if (overrides.size === 0) return;
  overrides.clear();
  emit();
}

/** Non-reactive lookup for imperative callers. */
export function peekAvatarOverride(avatarUrl: string | null | undefined): string | null {
  if (!avatarUrl) return null;
  return overrides.get(avatarUrl) ?? null;
}

/**
 * Read a picked image File as a data: URL (display-grade, no network).
 * Resolves null on any reader failure — callers just skip the override.
 */
function fileToDataUrl(file: File): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      const reader = new FileReader();
      reader.onload = () =>
        resolve(typeof reader.result === 'string' ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(file);
    } catch {
      resolve(null);
    }
  });
}

/**
 * THE upload-confirm hardening — call right after POST /api/upload answers
 * with the new avatarUrl, while the picked `file` is still in hand:
 *
 *   1. Capacitor: fetch the NEW file URL through the native bridge (OkHttp —
 *      outside the WebView's image policy). A 200 both VERIFIES that the
 *      file the server just stored is actually reachable from this device
 *      and yields the exact bytes every consumer will render.
 *   2. Fallback (web or native fetch failed): read the LOCAL File as a
 *      data: URL instead — display still never depends on the network.
 *
 * Either way the override renders the new avatar INSTANTLY and can never
 * regress to a placeholder in this session. A native-fetch failure is also
 * logged — with the override in place it becomes diagnostic signal, not a
 * user-facing breakage.
 */
export async function registerAvatarOverrideFromFile(
  avatarUrl: string | null | undefined,
  file: File | null | undefined,
): Promise<void> {
  if (!avatarUrl) return;

  // 1. Native verification path (Capacitor only).
  const cap = (
    window as unknown as { Capacitor?: { isNativePlatform?: () => boolean } }
  ).Capacitor;
  if (cap?.isNativePlatform?.()) {
    const rebased = getProxiedUrl(avatarUrl);
    if (rebased) {
      const nativeBytes = await nativeImageDataUrl(rebased.split('?')[0]);
      if (nativeBytes) {
        registerAvatarOverride(avatarUrl, nativeBytes);
        return;
      }
      console.warn(
        '[AvatarOverride] freshly-uploaded file NOT natively reachable yet:',
        rebased,
      );
    }
  }

  // 2. Local-bytes fallback — the File is already in memory.
  if (file) {
    const localDataUrl = await fileToDataUrl(file);
    if (localDataUrl) {
      registerAvatarOverride(avatarUrl, localDataUrl);
    }
  }
}

/**
 * Reactive lookup for render paths: returns the local data: URL registered
 * for EXACTLY this avatarUrl, or null. Re-renders when overrides change.
 */
export function useSessionAvatarOverride(
  avatarUrl: string | null | undefined,
): string | null {
  const [value, setValue] = useState<string | null>(() => peekAvatarOverride(avatarUrl));

  useEffect(() => {
    // Sync on key change first, then keep following registry updates.
    setValue(peekAvatarOverride(avatarUrl));
    const listener = () => setValue(peekAvatarOverride(avatarUrl));
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, [avatarUrl]);

  return value;
}
