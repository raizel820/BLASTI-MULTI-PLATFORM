/**
 * Device fingerprint & ID utilities for client-side device registration.
 *
 * - `getDeviceId()`: Generates a persistent device ID once and stores it in
 *   localStorage so it survives page reloads / sessions.
 * - `generateDeviceFingerprint()`: Produces a lightweight hash derived from
 *   stable browser characteristics (userAgent, screen, language, timezone, etc.).
 *   This is NOT a tracking fingerprint — it's used solely for device verification
 *   during registration.
 */

const DEVICE_ID_STORAGE_KEY = 'blasti_device_id';

/**
 * Simple, fast hash (djb2) for turning a string into a hex digest.
 * Not cryptographically secure — just a stable fingerprint.
 */
function djb2Hash(str: string): string {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash + str.charCodeAt(i)) & 0xffffffff;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/**
 * Generate or retrieve a persisted device ID.
 *
 * On first call a new UUID-like ID is generated (using crypto.randomUUID when
 * available, falling back to a timestamp + random approach) and stored in
 * localStorage. Subsequent calls return the stored value.
 */
export async function getDeviceId(): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('getDeviceId can only be called in the browser');
  }

  const stored = localStorage.getItem(DEVICE_ID_STORAGE_KEY);
  if (stored) {
    return stored;
  }

  // Prefer the native Crypto API for proper UUIDs
  let newId: string;
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    newId = crypto.randomUUID();
  } else {
    // Fallback: timestamp + random digits
    const timestamp = Date.now().toString(36);
    const randomPart = Math.random().toString(36).slice(2, 10);
    newId = `${timestamp}-${randomPart}`;
  }

  localStorage.setItem(DEVICE_ID_STORAGE_KEY, newId);
  return newId;
}

/**
 * Generate a lightweight device fingerprint from stable browser characteristics.
 *
 * The fingerprint is a concatenation of:
 *  - User-Agent string
 *  - Screen dimensions & color depth
 *  - Preferred language
 *  - Timezone offset
 *  - Platform (navigator.platform)
 *  - Number of CPU cores (navigator.hardwareConcurrency)
 *
 * This helps verify that the device registering is the same physical device
 * that made a previous request, without being a tracking mechanism.
 */
export async function generateDeviceFingerprint(): Promise<string> {
  if (typeof window === 'undefined') {
    throw new Error('generateDeviceFingerprint can only be called in the browser');
  }

  const nav = navigator as Navigator & {
    deviceMemory?: number;
    hardwareConcurrency?: number;
  };

  const components: string[] = [
    nav.userAgent ?? '',
    `${screen.width}x${screen.height}`,
    `${screen.colorDepth}`,
    nav.language ?? '',
    `${new Date().getTimezoneOffset()}`,
    nav.platform ?? '',
    `${nav.hardwareConcurrency ?? 0}`,
    `${nav.deviceMemory ?? 0}`,
  ];

  const raw = components.join('|');
  return djb2Hash(raw);
}
