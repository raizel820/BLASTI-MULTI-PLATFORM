/**
 * @blasti/api — Map, Location & Directions Settings (Task 51)
 *
 * Typed backend for the "Agency Location & Maps" system (spec
 * docs/chatgpt-doc1-map-location-spec.md).
 *
 * STORAGE
 * -------
 * Reuses the existing SystemSetting table through lib/config-manager.ts
 * (key unique, value string, encrypted bool, category, valueType). Every key
 * lives under category "maps" so admins can browse them alongside the other
 * dynamic configuration. The two secret keys (maps.google.apiKey and
 * maps.geocoding.apiKey) are stored ENCRYPTED — the codebase already ships an
 * AES-256-CBC helper (lib/encryption.ts) and config-manager auto-encrypts on
 * write / auto-decrypts on read, so no new secret mechanism was created
 * (spec §46: "Do not create an insecure new mechanism just for maps").
 *
 * PRECEDENCE (spec §47)
 * ---------------------
 *     1. DB       — SystemSetting rows (Super Admin UI, runtime-changeable)
 *     2. env      — GOOGLE_MAPS_API_KEY (server-side key: geocoding + Maps
 *                   HTTP services) and GOOGLE_MAPS_JS_KEY (browser Maps JS
 *                   key; referrer-restricted by design, so it is NOT a
 *                   secret — it ships to every browser that loads a map)
 *     3. defaults — built-in constants below (OpenFreeMap-first: works with
 *                   zero configuration)
 * The selected precedence is documented here as the single authority; no
 * other code path may read map configuration directly from process.env.
 *
 * SECRETS
 * -------
 * Full secret values NEVER appear in any admin GET response (spec §45):
 * they are masked as "••••" + last 4. Audit entries log the configuration
 * EVENT, never the credential (spec §42).
 */

import { db } from '@blasti/db'
import { getConfig, setConfig, deleteConfig, getSettingRaw } from './config-manager'

// ─── Types ──────────────────────────────────────────────────────────────────

export type MapProvider = 'GOOGLE' | 'OPENFREEMAP'
export type FallbackProvider = 'NONE' | 'GOOGLE' | 'OPENFREEMAP'
export type GeocodingProvider = 'GOOGLE' | 'OSM'
export type DestinationMode = 'COORDINATES' | 'COORDINATES_AND_ADDRESS'
export type DirectionsOrigin = 'CURRENT_LOCATION' | 'NONE'
export type OpenBehavior = 'AUTO' | 'APP' | 'WEB'

export interface MapsPublicConfig {
  provider: MapProvider
  fallbackProvider: FallbackProvider
  mapsEnabled: boolean
  directionsEnabled: boolean
  openfreemap: { styleUrl: string }
  google: { configured: boolean; geocodingEnabled: boolean; jsApiKey: string | null }
  geocoding: { provider: GeocodingProvider }
  directions: {
    destinationMode: DestinationMode
    origin: DirectionsOrigin
    openBehavior: OpenBehavior
    buttonLabel: string | null
  }
}

// ─── Setting keys (category "maps") ─────────────────────────────────────────

export const MAPS_SETTINGS_CATEGORY = 'maps'

export const MAPS_SETTINGS_KEYS = {
  provider: 'maps.provider',
  fallbackProvider: 'maps.fallbackProvider',
  mapsEnabled: 'maps.mapsEnabled',
  directionsEnabled: 'maps.directionsEnabled',
  googleApiKey: 'maps.google.apiKey',
  googleGeocodingEnabled: 'maps.google.geocodingEnabled',
  openfreemapStyleUrl: 'maps.openfreemap.styleUrl',
  geocodingProvider: 'maps.geocoding.provider',
  geocodingApiKey: 'maps.geocoding.apiKey',
  directionsDestinationMode: 'maps.directions.destinationMode',
  directionsOrigin: 'maps.directions.origin',
  directionsOpenBehavior: 'maps.directions.openBehavior',
  directionsButtonLabel: 'maps.directions.buttonLabel',
} as const

export const MAPS_SETTINGS_ALL_KEYS = Object.values(MAPS_SETTINGS_KEYS) as string[]

/** Secret keys — masked in every GET, encrypted at rest, never audited with values. */
export const MAPS_SECRET_KEYS: string[] = [MAPS_SETTINGS_KEYS.googleApiKey, MAPS_SETTINGS_KEYS.geocodingApiKey]

// ─── Built-in defaults (tier 3 of the precedence chain) ─────────────────────

export const MAPS_DEFAULTS = {
  provider: 'OPENFREEMAP' as MapProvider,
  fallbackProvider: 'NONE' as FallbackProvider,
  mapsEnabled: true,
  directionsEnabled: true,
  googleGeocodingEnabled: true,
  openfreemapStyleUrl: 'https://tiles.openfreemap.org/styles/liberty',
  geocodingProvider: 'OSM' as GeocodingProvider,
  directionsDestinationMode: 'COORDINATES' as DestinationMode,
  directionsOrigin: 'CURRENT_LOCATION' as DirectionsOrigin,
  directionsOpenBehavior: 'AUTO' as OpenBehavior,
  directionsButtonLabel: null as string | null,
}

// ─── Enum value sets (validation + docs) ────────────────────────────────────

export const MAP_PROVIDER_VALUES: MapProvider[] = ['GOOGLE', 'OPENFREEMAP']
export const FALLBACK_PROVIDER_VALUES: FallbackProvider[] = ['NONE', 'GOOGLE', 'OPENFREEMAP']
export const GEOCODING_PROVIDER_VALUES: GeocodingProvider[] = ['GOOGLE', 'OSM']
export const DESTINATION_MODE_VALUES: DestinationMode[] = ['COORDINATES', 'COORDINATES_AND_ADDRESS']
export const DIRECTIONS_ORIGIN_VALUES: DirectionsOrigin[] = ['CURRENT_LOCATION', 'NONE']
export const OPEN_BEHAVIOR_VALUES: OpenBehavior[] = ['AUTO', 'APP', 'WEB']

/** Official Google API key shape (39 chars, "AIza" prefix). */
const GOOGLE_KEY_FORMAT_RE = /^AIza[0-9A-Za-z_-]{33}$/

// ─── Env tier (tier 2 of the precedence chain) ──────────────────────────────

/** Server-side Google key (geocoding + Maps HTTP services). A SECRET. */
function envGoogleApiKey(): string | null {
  const v = process.env.GOOGLE_MAPS_API_KEY
  return v && v.trim() ? v.trim() : null
}

/**
 * Browser Maps JS key. Referrer-restricted by design (it is embedded in web
 * pages and visible to every client), so it is NOT treated as a secret and is
 * intentionally NOT stored in SystemSetting — it is env-only. Documented per
 * spec §47 ("Do not silently create conflicting configuration sources").
 */
function envGoogleJsApiKey(): string | null {
  const v = process.env.GOOGLE_MAPS_JS_KEY
  return v && v.trim() ? v.trim() : null
}

// ─── Masking (spec §45 — never return full secrets) ─────────────────────────

/**
 * Mask a secret for display: "••••" + last 4 chars (e.g. "••••7H2K").
 * Returns null for empty/missing values. NEVER invertible — the full value
 * must come from the DB/env, not from the masked output.
 */
export function maskSecret(value: string | null | undefined): string | null {
  if (!value || !value.trim()) return null
  const v = value.trim()
  return '••••' + v.slice(-4)
}

// ─── Getters (resolve the full precedence chain) ────────────────────────────

/** Resolve a plain string setting: DB → env (optional) → default. */
async function resolveString(
  key: string,
  fallback: string,
  envValue?: string | null,
): Promise<{ value: string; source: 'DB' | 'ENV' | 'DEFAULT' }> {
  const dbValue = await getConfig(key)
  if (dbValue !== null && dbValue.trim() !== '') return { value: dbValue, source: 'DB' }
  if (envValue) return { value: envValue, source: 'ENV' }
  return { value: fallback, source: 'DEFAULT' }
}

/** Resolve a boolean setting: DB → default. */
async function resolveBoolean(
  key: string,
  fallback: boolean,
): Promise<{ value: boolean; source: 'DB' | 'DEFAULT' }> {
  const dbValue = await getConfig(key)
  if (dbValue === null) return { value: fallback, source: 'DEFAULT' }
  return { value: ['true', '1', 'yes'].includes(dbValue.trim().toLowerCase()), source: 'DB' }
}

/**
 * Server-side Google Maps API key (SECRET). DB maps.google.apiKey
 * (decrypted by config-manager) → env GOOGLE_MAPS_API_KEY → null.
 */
export async function getGoogleApiKey(): Promise<string | null> {
  const dbValue = await getConfig(MAPS_SETTINGS_KEYS.googleApiKey)
  if (dbValue && dbValue.trim()) return dbValue.trim()
  return envGoogleApiKey()
}

/** Where the effective Google key came from (for admin diagnostics only). */
export async function getGoogleApiKeySource(): Promise<'DB' | 'ENV' | 'DEFAULT'> {
  const dbValue = await getConfig(MAPS_SETTINGS_KEYS.googleApiKey)
  if (dbValue && dbValue.trim()) return 'DB'
  if (envGoogleApiKey()) return 'ENV'
  return 'DEFAULT'
}

/** Google Maps JS key — returned ONLY when the main provider is GOOGLE. */
export async function getJsApiKey(provider: MapProvider): Promise<string | null> {
  if (provider !== 'GOOGLE') return null
  return envGoogleJsApiKey()
}

/**
 * Build the effective maps configuration (DB → env → defaults).
 * `jsApiKey` is included ONLY when provider === 'GOOGLE' and a JS key exists
 * (the Google Maps JS key is referrer-restricted by design and intended for
 * browser embedding; it is deliberately withheld for every other provider so
 * switching providers immediately stops shipping the key to clients).
 */
export async function buildMapsConfig(): Promise<MapsPublicConfig> {
  const [providerRes, fallbackRes, mapsEnabledRes, directionsEnabledRes, styleUrlRes, geocodingProviderRes, googleGeocodingEnabledRes, destinationModeRes, originRes, openBehaviorRes] = await Promise.all([
    resolveString(MAPS_SETTINGS_KEYS.provider, MAPS_DEFAULTS.provider),
    resolveString(MAPS_SETTINGS_KEYS.fallbackProvider, MAPS_DEFAULTS.fallbackProvider),
    resolveBoolean(MAPS_SETTINGS_KEYS.mapsEnabled, MAPS_DEFAULTS.mapsEnabled),
    resolveBoolean(MAPS_SETTINGS_KEYS.directionsEnabled, MAPS_DEFAULTS.directionsEnabled),
    resolveString(MAPS_SETTINGS_KEYS.openfreemapStyleUrl, MAPS_DEFAULTS.openfreemapStyleUrl),
    resolveString(MAPS_SETTINGS_KEYS.geocodingProvider, MAPS_DEFAULTS.geocodingProvider),
    resolveBoolean(MAPS_SETTINGS_KEYS.googleGeocodingEnabled, MAPS_DEFAULTS.googleGeocodingEnabled),
    resolveString(MAPS_SETTINGS_KEYS.directionsDestinationMode, MAPS_DEFAULTS.directionsDestinationMode),
    resolveString(MAPS_SETTINGS_KEYS.directionsOrigin, MAPS_DEFAULTS.directionsOrigin),
    resolveString(MAPS_SETTINGS_KEYS.directionsOpenBehavior, MAPS_DEFAULTS.directionsOpenBehavior),
  ])

  const buttonLabelDb = await getConfig(MAPS_SETTINGS_KEYS.directionsButtonLabel)
  const provider = (MAP_PROVIDER_VALUES.includes(providerRes.value as MapProvider)
    ? providerRes.value
    : MAPS_DEFAULTS.provider) as MapProvider

  const googleKeyExists = await getGoogleApiKeySource().then((s) => s !== 'DEFAULT')

  return {
    provider,
    fallbackProvider: (FALLBACK_PROVIDER_VALUES.includes(fallbackRes.value as FallbackProvider)
      ? fallbackRes.value
      : MAPS_DEFAULTS.fallbackProvider) as FallbackProvider,
    mapsEnabled: mapsEnabledRes.value,
    directionsEnabled: directionsEnabledRes.value,
    openfreemap: { styleUrl: styleUrlRes.value },
    google: {
      configured: googleKeyExists,
      geocodingEnabled: googleGeocodingEnabledRes.value,
      jsApiKey: await getJsApiKey(provider),
    },
    geocoding: {
      provider: (GEOCODING_PROVIDER_VALUES.includes(geocodingProviderRes.value as GeocodingProvider)
        ? geocodingProviderRes.value
        : MAPS_DEFAULTS.geocodingProvider) as GeocodingProvider,
    },
    directions: {
      destinationMode: (DESTINATION_MODE_VALUES.includes(destinationModeRes.value as DestinationMode)
        ? destinationModeRes.value
        : MAPS_DEFAULTS.directionsDestinationMode) as DestinationMode,
      origin: (DIRECTIONS_ORIGIN_VALUES.includes(originRes.value as DirectionsOrigin)
        ? originRes.value
        : MAPS_DEFAULTS.directionsOrigin) as DirectionsOrigin,
      openBehavior: (OPEN_BEHAVIOR_VALUES.includes(openBehaviorRes.value as OpenBehavior)
        ? openBehaviorRes.value
        : MAPS_DEFAULTS.directionsOpenBehavior) as OpenBehavior,
      buttonLabel: buttonLabelDb && buttonLabelDb.trim() !== '' ? buttonLabelDb : null,
    },
  }
}

// ─── Validation + writes (PUT /settings/maps) ───────────────────────────────

export interface MapsSettingWrite {
  key: string
  value: string
  valueType: 'string' | 'boolean'
  encrypted: boolean
  /** For audit logging: human-readable setting name. */
  label: string
}

export interface ValidatePayloadResult {
  ok: boolean
  error?: string
  writes?: MapsSettingWrite[]
}

const isMissing = (v: unknown): boolean => v === undefined

/**
 * Validate a PUT /settings/maps payload and turn it into SystemSetting writes.
 * PURE — never touches the DB — so the route can validate the WHOLE payload
 * up front and persist all keys afterwards (validate-all-then-write: a bad
 * enum anywhere aborts the save before a single key is written).
 *
 * Secret rules: apiKey fields accept a plaintext string (stored encrypted)
 * or explicit null (removes the stored key). Masked placeholders ("••••…")
 * are rejected so a UI round-trip can never overwrite a real key with the
 * mask. An empty string is treated as removal.
 */
export function validateMapsSettingsPayload(body: unknown): ValidatePayloadResult {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'Request body must be a JSON object' }
  }
  const b = body as Record<string, unknown>
  const writes: MapsSettingWrite[] = []

  const pushWrite = (key: string, value: string, valueType: 'string' | 'boolean', encrypted: boolean, label: string) => {
    writes.push({ key, value, valueType, encrypted, label })
  }

  // -- top-level scalars -----------------------------------------------------
  if (!isMissing(b.provider)) {
    if (typeof b.provider !== 'string' || !MAP_PROVIDER_VALUES.includes(b.provider as MapProvider)) {
      return { ok: false, error: `provider must be one of: ${MAP_PROVIDER_VALUES.join(', ')}` }
    }
    pushWrite(MAPS_SETTINGS_KEYS.provider, b.provider, 'string', false, 'Main map provider')
  }
  if (!isMissing(b.fallbackProvider)) {
    if (typeof b.fallbackProvider !== 'string' || !FALLBACK_PROVIDER_VALUES.includes(b.fallbackProvider as FallbackProvider)) {
      return { ok: false, error: `fallbackProvider must be one of: ${FALLBACK_PROVIDER_VALUES.join(', ')}` }
    }
    pushWrite(MAPS_SETTINGS_KEYS.fallbackProvider, b.fallbackProvider, 'string', false, 'Fallback map provider')
  }
  if (!isMissing(b.mapsEnabled)) {
    if (typeof b.mapsEnabled !== 'boolean') return { ok: false, error: 'mapsEnabled must be a boolean' }
    pushWrite(MAPS_SETTINGS_KEYS.mapsEnabled, b.mapsEnabled ? 'true' : 'false', 'boolean', false, 'Maps enabled')
  }
  if (!isMissing(b.directionsEnabled)) {
    if (typeof b.directionsEnabled !== 'boolean') return { ok: false, error: 'directionsEnabled must be a boolean' }
    pushWrite(MAPS_SETTINGS_KEYS.directionsEnabled, b.directionsEnabled ? 'true' : 'false', 'boolean', false, 'Directions enabled')
  }

  // -- openfreemap -----------------------------------------------------------
  if (!isMissing(b.openfreemap)) {
    if (b.openfreemap === null || typeof b.openfreemap !== 'object' || Array.isArray(b.openfreemap)) {
      return { ok: false, error: 'openfreemap must be an object' }
    }
    const of = b.openfreemap as Record<string, unknown>
    if (!isMissing(of.styleUrl)) {
      if (typeof of.styleUrl !== 'string' || !/^https?:\/\/.+/i.test(of.styleUrl.trim())) {
        return { ok: false, error: 'openfreemap.styleUrl must be a valid http(s) URL' }
      }
      let parsed: URL
      try {
        parsed = new URL(of.styleUrl.trim())
      } catch {
        return { ok: false, error: 'openfreemap.styleUrl must be a valid http(s) URL' }
      }
      if (!parsed.hostname.includes('.')) {
        return { ok: false, error: 'openfreemap.styleUrl must be a valid http(s) URL' }
      }
      pushWrite(MAPS_SETTINGS_KEYS.openfreemapStyleUrl, of.styleUrl.trim(), 'string', false, 'OpenFreeMap style URL')
    }
  }

  // -- google ----------------------------------------------------------------
  if (!isMissing(b.google)) {
    if (b.google === null || typeof b.google !== 'object' || Array.isArray(b.google)) {
      return { ok: false, error: 'google must be an object' }
    }
    const g = b.google as Record<string, unknown>
    if (!isMissing(g.apiKey)) {
      if (g.apiKey !== null && typeof g.apiKey !== 'string') {
        return { ok: false, error: 'google.apiKey must be a string or null (null removes the stored key)' }
      }
      if (g.apiKey === null || g.apiKey.trim() === '') {
        pushWrite(MAPS_SETTINGS_KEYS.googleApiKey, '', 'string', true, 'Google Maps API key')
      } else {
        const key = g.apiKey.trim()
        if (key.startsWith('••')) {
          return { ok: false, error: 'google.apiKey looks like a masked placeholder — send the full key or null to remove it' }
        }
        pushWrite(MAPS_SETTINGS_KEYS.googleApiKey, key, 'string', true, 'Google Maps API key')
      }
    }
    if (!isMissing(g.geocodingEnabled)) {
      if (typeof g.geocodingEnabled !== 'boolean') return { ok: false, error: 'google.geocodingEnabled must be a boolean' }
      pushWrite(MAPS_SETTINGS_KEYS.googleGeocodingEnabled, g.geocodingEnabled ? 'true' : 'false', 'boolean', false, 'Google geocoding enabled')
    }
  }

  // -- geocoding ---------------------------------------------------------------
  if (!isMissing(b.geocoding)) {
    if (b.geocoding === null || typeof b.geocoding !== 'object' || Array.isArray(b.geocoding)) {
      return { ok: false, error: 'geocoding must be an object' }
    }
    const gc = b.geocoding as Record<string, unknown>
    if (!isMissing(gc.provider)) {
      if (typeof gc.provider !== 'string' || !GEOCODING_PROVIDER_VALUES.includes(gc.provider as GeocodingProvider)) {
        return { ok: false, error: `geocoding.provider must be one of: ${GEOCODING_PROVIDER_VALUES.join(', ')}` }
      }
      pushWrite(MAPS_SETTINGS_KEYS.geocodingProvider, gc.provider, 'string', false, 'Geocoding provider')
    }
    if (!isMissing(gc.apiKey)) {
      if (gc.apiKey !== null && typeof gc.apiKey !== 'string') {
        return { ok: false, error: 'geocoding.apiKey must be a string or null (null removes the stored key)' }
      }
      if (gc.apiKey === null || gc.apiKey.trim() === '') {
        pushWrite(MAPS_SETTINGS_KEYS.geocodingApiKey, '', 'string', true, 'Geocoding API key')
      } else {
        const key = gc.apiKey.trim()
        if (key.startsWith('••')) {
          return { ok: false, error: 'geocoding.apiKey looks like a masked placeholder — send the full key or null to remove it' }
        }
        pushWrite(MAPS_SETTINGS_KEYS.geocodingApiKey, key, 'string', true, 'Geocoding API key')
      }
    }
  }

  // -- directions --------------------------------------------------------------
  if (!isMissing(b.directions)) {
    if (b.directions === null || typeof b.directions !== 'object' || Array.isArray(b.directions)) {
      return { ok: false, error: 'directions must be an object' }
    }
    const d = b.directions as Record<string, unknown>
    if (!isMissing(d.destinationMode)) {
      if (typeof d.destinationMode !== 'string' || !DESTINATION_MODE_VALUES.includes(d.destinationMode as DestinationMode)) {
        return { ok: false, error: `directions.destinationMode must be one of: ${DESTINATION_MODE_VALUES.join(', ')}` }
      }
      pushWrite(MAPS_SETTINGS_KEYS.directionsDestinationMode, d.destinationMode, 'string', false, 'Directions destination mode')
    }
    if (!isMissing(d.origin)) {
      if (typeof d.origin !== 'string' || !DIRECTIONS_ORIGIN_VALUES.includes(d.origin as DirectionsOrigin)) {
        return { ok: false, error: `directions.origin must be one of: ${DIRECTIONS_ORIGIN_VALUES.join(', ')}` }
      }
      pushWrite(MAPS_SETTINGS_KEYS.directionsOrigin, d.origin, 'string', false, 'Directions origin')
    }
    if (!isMissing(d.openBehavior)) {
      if (typeof d.openBehavior !== 'string' || !OPEN_BEHAVIOR_VALUES.includes(d.openBehavior as OpenBehavior)) {
        return { ok: false, error: `directions.openBehavior must be one of: ${OPEN_BEHAVIOR_VALUES.join(', ')}` }
      }
      pushWrite(MAPS_SETTINGS_KEYS.directionsOpenBehavior, d.openBehavior, 'string', false, 'Directions open behavior')
    }
    if (!isMissing(d.buttonLabel)) {
      if (d.buttonLabel !== null && typeof d.buttonLabel !== 'string') {
        return { ok: false, error: 'directions.buttonLabel must be a string or null' }
      }
      const label = d.buttonLabel === null || d.buttonLabel.trim() === '' ? '' : d.buttonLabel.trim()
      if (label.length > 60) return { ok: false, error: 'directions.buttonLabel must be at most 60 characters' }
      pushWrite(MAPS_SETTINGS_KEYS.directionsButtonLabel, label, 'string', false, 'Directions button label')
    }
  }

  return { ok: true, writes }
}

/**
 * Persist validated writes. Empty string on a secret key REMOVES the stored
 * row (clear). Returns the list of persisted keys.
 */
export async function applyMapsSettingsWrites(writes: MapsSettingWrite[]): Promise<string[]> {
  const persisted: string[] = []
  for (const w of writes) {
    if (w.encrypted && w.value === '') {
      await deleteConfig(w.key)
    } else {
      await setConfig(w.key, w.value, {
        encrypted: w.encrypted,
        category: MAPS_SETTINGS_CATEGORY,
        description: w.label,
        valueType: w.valueType,
      })
    }
    persisted.push(w.key)
  }
  return persisted
}

// ─── Admin snapshot (GET /settings/maps) ────────────────────────────────────

export interface MapsSecretStatus {
  key: string
  label: string
  configured: boolean
  /** "••••" + last 4 — NEVER the full value. */
  masked: string | null
  /** Where the effective value comes from: DB (stored, encrypted) / env / none. */
  source: 'DB' | 'ENV' | 'DEFAULT'
  lastUpdatedAt: string | null
}

export interface MapsSettingsAdmin {
  /** Same shape as the public GET /api/config/maps `data` (contract). */
  config: MapsPublicConfig
  secrets: MapsSecretStatus[]
  /** lastUpdatedAt per setting key (ISO string or null when never written). */
  lastUpdatedAt: Record<string, string | null>
  /** Resolution source per setting key: DB / ENV / DEFAULT. */
  source: Record<string, string>
}

/**
 * Full admin snapshot: effective config + masked secrets + per-key metadata.
 * Full secret values NEVER appear anywhere in this structure (spec §45).
 */
export async function getMapsSettingsAdmin(): Promise<MapsSettingsAdmin> {
  const config = await buildMapsConfig()

  // lastUpdatedAt + source per key from the raw SystemSetting rows.
  const rows = await db.systemSetting.findMany({
    where: { category: MAPS_SETTINGS_CATEGORY },
    select: { key: true, updatedAt: true, encrypted: true },
  })
  const rowByKey = new Map(rows.map((r) => [r.key, r]))

  const lastUpdatedAt: Record<string, string | null> = {}
  const source: Record<string, string> = {}
  for (const key of MAPS_SETTINGS_ALL_KEYS) {
    const row = rowByKey.get(key)
    lastUpdatedAt[key] = row ? new Date(row.updatedAt).toISOString() : null
    source[key] = row ? 'DB' : 'DEFAULT'
  }

  // Secret statuses (masked; full values never leave the server).
  const googleSource = await getGoogleApiKeySource()
  const geocodingDbRaw = await getSettingRaw(MAPS_SETTINGS_KEYS.geocodingApiKey)
  const googleDbRaw = await getSettingRaw(MAPS_SETTINGS_KEYS.googleApiKey)
  const googleEffective = await getGoogleApiKey() // DB (decrypted) → env
  const geocodingEffective = geocodingDbRaw ? await getConfig(MAPS_SETTINGS_KEYS.geocodingApiKey) : null

  const secrets: MapsSecretStatus[] = [
    {
      key: MAPS_SETTINGS_KEYS.googleApiKey,
      label: 'Google Maps API key',
      configured: googleSource !== 'DEFAULT',
      masked: maskSecret(googleEffective),
      source: googleSource,
      lastUpdatedAt: googleDbRaw ? new Date(googleDbRaw.updatedAt).toISOString() : null,
    },
    {
      key: MAPS_SETTINGS_KEYS.geocodingApiKey,
      label: 'Geocoding API key',
      configured: !!geocodingDbRaw,
      masked: maskSecret(geocodingEffective),
      source: geocodingDbRaw ? 'DB' : 'DEFAULT',
      lastUpdatedAt: geocodingDbRaw ? new Date(geocodingDbRaw.updatedAt).toISOString() : null,
    },
  ]

  // source for keys with env fallbacks / boolean defaults
  source[MAPS_SETTINGS_KEYS.googleApiKey] = googleSource
  if (!rowByKey.has(MAPS_SETTINGS_KEYS.openfreemapStyleUrl)) source[MAPS_SETTINGS_KEYS.openfreemapStyleUrl] = 'DEFAULT'

  return { config, secrets, lastUpdatedAt, source }
}

// ─── Agency location CRUD helper (spec §2 — canonical location fields) ──────

export interface AgencyLocationPatch {
  data: Record<string, unknown>
  error?: string
}

/**
 * Turn validated agency payload location fields into a Prisma write patch.
 *
 * Rules (Task 51):
 *  - latitude/longitude are a PAIR: both numbers (location set + stamped),
 *    both null (explicit clear), or absent. A half-set pair 400s.
 *  - when a valid lat/lng pair is written, locationUpdatedAt = now (spec §2
 *    freshness metadata; the field itself is never client-settable).
 *  - postalCode / locationVerified / locationSource pass through as provided
 *    (value enums are enforced by the zod schemas in lib/validations.ts).
 *
 * Range validation (lat −90..90, lng −180..180) happens in the zod schemas;
 * this helper is only about pair semantics + stamping.
 */
export function buildAgencyLocationPatch(v: Record<string, unknown>): AgencyLocationPatch {
  const data: Record<string, unknown> = {}

  const latPresent = 'latitude' in v && v.latitude !== undefined
  const lngPresent = 'longitude' in v && v.longitude !== undefined
  if (latPresent || lngPresent) {
    const lat = v.latitude as number | null | undefined
    const lng = v.longitude as number | null | undefined
    if (lat === null && lng === null) {
      // Explicit clear ("not set by the user yet" round-trip support).
      data.latitude = null
      data.longitude = null
    } else if (typeof lat === 'number' && typeof lng === 'number') {
      data.latitude = lat
      data.longitude = lng
      data.locationUpdatedAt = new Date()
    } else {
      return {
        data: {},
        error: 'latitude and longitude must be provided together (both numbers, or both null to clear the location)',
      }
    }
  }

  if ('postalCode' in v && v.postalCode !== undefined) data.postalCode = v.postalCode
  if ('locationVerified' in v && v.locationVerified !== undefined) data.locationVerified = v.locationVerified
  if ('locationSource' in v && v.locationSource !== undefined) data.locationSource = v.locationSource

  return { data }
}

// ─── Validation probes (POST /settings/maps/validate) ───────────────────────

export interface MapsValidationCheck {
  id: string
  label: string
  passed: boolean
  /** Inconclusive checks (e.g. live probe could not run offline) don't fail validity. */
  inconclusive?: boolean
  detail?: string
}

export interface MapsValidationResult {
  valid: boolean
  checks: MapsValidationCheck[]
  error?: string
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = 5000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
}

/**
 * Validate the Google Maps setup: key presence (DB or env), key format,
 * plus an OPTIONAL live geocoding probe (5s timeout). Network failures are
 * handled gracefully — the probe reports inconclusive and validity rests on
 * the format checks ("cannot verify live, format valid").
 */
export async function validateGoogleMaps(live = true): Promise<MapsValidationResult> {
  const checks: MapsValidationCheck[] = []
  const key = await getGoogleApiKey()
  const source = await getGoogleApiKeySource()

  checks.push({
    id: 'key-present',
    label: 'Google Maps API key present',
    passed: !!key,
    detail: key ? `configured via ${source === 'DB' ? 'database' : 'environment'}` : 'no key in database and GOOGLE_MAPS_API_KEY is not set',
  })
  if (!key) {
    return { valid: false, checks, error: 'No Google Maps API key configured' }
  }

  const formatOk = GOOGLE_KEY_FORMAT_RE.test(key)
  checks.push({
    id: 'key-format',
    label: 'Google Maps API key format',
    passed: formatOk,
    detail: formatOk ? 'matches ^AIza[0-9A-Za-z_-]{33}$' : 'expected a 39-character key starting with "AIza"',
  })

  if (live) {
    try {
      const res = await fetchWithTimeout(
        `https://maps.googleapis.com/maps/api/geocode/json?latlng=35.7,3.0&key=${encodeURIComponent(key)}`,
      )
      const json: any = await res.json().catch(() => null)
      const status: string | undefined = json?.status
      if (status === 'OK' || status === 'ZERO_RESULTS') {
        checks.push({ id: 'live-probe', label: 'Live Google Geocoding API probe', passed: true, detail: `Google responded ${status}` })
      } else if (status === 'REQUEST_DENIED' || status === 'OVER_QUERY_LIMIT' || status === 'INVALID_REQUEST') {
        checks.push({ id: 'live-probe', label: 'Live Google Geocoding API probe', passed: false, detail: `Google responded ${status}${json?.error_message ? `: ${json.error_message}` : ''}` })
      } else {
        checks.push({ id: 'live-probe', label: 'Live Google Geocoding API probe', passed: false, inconclusive: true, detail: `Unexpected response (HTTP ${res.status}) — format valid` })
      }
    } catch (err) {
      checks.push({
        id: 'live-probe',
        label: 'Live Google Geocoding API probe',
        passed: true,
        inconclusive: true,
        detail: `Cannot verify live (${err instanceof Error ? err.message : 'network error'}) — format valid`,
      })
    }
  }

  return { valid: checks.every((c) => c.passed), checks }
}

/** Validate the OpenFreeMap setup: the configured style URL must be reachable. */
export async function validateOpenFreeMap(): Promise<MapsValidationResult> {
  const checks: MapsValidationCheck[] = []
  const { value: styleUrl } = await resolveString(MAPS_SETTINGS_KEYS.openfreemapStyleUrl, MAPS_DEFAULTS.openfreemapStyleUrl)

  const urlOk = /^https?:\/\/.+/i.test(styleUrl)
  checks.push({ id: 'style-url-format', label: 'OpenFreeMap style URL format', passed: urlOk, detail: urlOk ? styleUrl : 'styleUrl must be a valid http(s) URL' })
  if (!urlOk) return { valid: false, checks, error: 'OpenFreeMap style URL is not a valid http(s) URL' }

  try {
    const res = await fetchWithTimeout(styleUrl, { method: 'GET', headers: { accept: 'application/json' } })
    const isJson = (res.headers.get('content-type') || '').includes('json')
    checks.push({
      id: 'style-url-reachable',
      label: 'OpenFreeMap style URL reachable',
      passed: res.ok,
      detail: res.ok
        ? `HTTP ${res.status}${isJson ? ', JSON style document' : ''}`
        : `HTTP ${res.status} ${res.statusText}`,
    })
  } catch (err) {
    checks.push({
      id: 'style-url-reachable',
      label: 'OpenFreeMap style URL reachable',
      passed: false,
      inconclusive: true,
      detail: `Cannot verify live (${err instanceof Error ? err.message : 'network error'}) — URL format valid`,
    })
  }

  return { valid: checks.every((c) => c.passed), checks }
}

/** Validate the geocoding setup for the ACTIVE geocoding provider. */
export async function validateGeocoding(live = true): Promise<MapsValidationResult> {
  const { value: provider } = await resolveString(MAPS_SETTINGS_KEYS.geocodingProvider, MAPS_DEFAULTS.geocodingProvider)

  if (provider === 'GOOGLE') {
    const result = await validateGoogleMaps(live)
    return {
      ...result,
      checks: [{ id: 'provider', label: 'Geocoding provider', passed: true, detail: 'GOOGLE (validated with the Google Maps checks below)' }, ...result.checks],
    }
  }

  // OSM (Nominatim) — keyless service; a stored key is optional metadata.
  const checks: MapsValidationCheck[] = [
    { id: 'provider', label: 'Geocoding provider', passed: true, detail: 'OSM (Nominatim) — no API key required' },
  ]
  if (live) {
    try {
      const res = await fetchWithTimeout(
        'https://nominatim.openstreetmap.org/reverse?lat=35.7&lon=3.0&format=json',
        { headers: { 'user-agent': 'BLASTI/1.0 (maps settings validation)' } },
      )
      checks.push({
        id: 'live-probe',
        label: 'Live OSM Nominatim probe',
        passed: res.ok,
        detail: res.ok ? `HTTP ${res.status}` : `HTTP ${res.status} ${res.statusText}`,
      })
    } catch (err) {
      checks.push({
        id: 'live-probe',
        label: 'Live OSM Nominatim probe',
        passed: true,
        inconclusive: true,
        detail: `Cannot verify live (${err instanceof Error ? err.message : 'network error'}) — OSM needs no key, format valid`,
      })
    }
  }
  return { valid: checks.every((c) => c.passed), checks }
}
