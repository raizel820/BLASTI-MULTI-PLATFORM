/**
 * @blasti/api — ProviderConfig service (Task 22)
 *
 * Loads/saves per-channel provider configuration with AES-encrypted secrets.
 * All provider services (email/sms/whatsapp) read their credentials through
 * here; the admin providers API writes through here.
 */

import { db } from '@blasti/db'
import { encrypt, decrypt } from '../encryption'
import { PROVIDER_REGISTRY, type Channel } from './provider-registry'

export interface ResolvedProviderConfig {
  id: string
  channel: Channel
  provider: string
  enabled: boolean
  apiKey: string
  senderId: string
  phoneNumberId: string
  accountId: string
  apiUrl: string
  extra: Record<string, string>
}

/** extraConfig keys that must be encrypted at rest */
const EXTRA_SECRET_KEYS = new Set(['webhookVerifyToken'])

function maskSecret(value: string): string {
  if (!value) return ''
  if (value.length <= 8) return '••••••••'
  return value.slice(0, 4) + '••••••••' + value.slice(-4)
}

export function maskApiKey(value: string): string {
  return maskSecret(value)
}

/**
 * Get the raw config row (decrypted) for a channel. Returns null when the
 * channel has never been configured.
 */
export async function getProviderConfig(channel: Channel): Promise<ResolvedProviderConfig | null> {
  const row = await db.providerConfig.findUnique({ where: { channel } })
  if (!row) return null

  let extra: Record<string, string> = {}
  try {
    extra = JSON.parse(row.extraConfig || '{}')
  } catch {
    extra = {}
  }
  for (const key of Object.keys(extra)) {
    if (EXTRA_SECRET_KEYS.has(key) && extra[key]) {
      try {
        extra[key] = decrypt(extra[key])
      } catch {
        // Value was stored unencrypted (or key rotation) — keep as-is
      }
    }
  }

  let apiKey = row.apiKey
  if (apiKey) {
    try {
      apiKey = decrypt(apiKey)
    } catch {
      // Legacy plaintext key — keep as-is
    }
  }

  return {
    id: row.id,
    channel,
    provider: row.provider,
    enabled: row.enabled,
    apiKey,
    senderId: row.senderId,
    phoneNumberId: row.phoneNumberId,
    accountId: row.accountId,
    apiUrl: row.apiUrl,
    extra,
  }
}

/**
 * Get config with defaults applied (registry defaults) — what the services use.
 * When the channel was never configured, falls back to env vars.
 */
export async function getResolvedConfig(channel: Channel): Promise<ResolvedProviderConfig> {
  const registry = PROVIDER_REGISTRY[channel]
  const stored = await getProviderConfig(channel)

  const envKey: Record<Channel, string | undefined> = {
    EMAIL: process.env.RESEND_API_KEY,
    SMS: process.env.ESMS_AFRICA_API_KEY,
    WHATSAPP: process.env.WHATSAPP_ACCESS_TOKEN,
  }

  return {
    id: stored?.id ?? '',
    channel,
    provider: stored?.provider ?? registry.id,
    enabled: stored?.enabled ?? false,
    apiKey: stored?.apiKey || envKey[channel] || '',
    senderId: stored?.senderId || '',
    phoneNumberId: stored?.phoneNumberId || '',
    accountId: stored?.accountId || '',
    apiUrl: stored?.apiUrl || registry.defaultApiUrl,
    extra: stored?.extra ?? {},
  }
}

export interface SaveProviderConfigInput {
  channel: Channel
  enabled?: boolean
  apiKey?: string
  senderId?: string
  phoneNumberId?: string
  accountId?: string
  apiUrl?: string
  extra?: Record<string, string | undefined>
  /** true when apiKey is a masked value that must NOT overwrite the stored secret */
  apiKeyIsMasked?: boolean
}

export async function saveProviderConfig(input: SaveProviderConfigInput): Promise<ResolvedProviderConfig> {
  const registry = PROVIDER_REGISTRY[input.channel]

  // Merge extras: existing row extras + incoming (undefined removes a key)
  const existing = await getProviderConfig(input.channel)
  const extra: Record<string, string> = { ...(existing?.extra ?? {}) }
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (value === undefined) delete extra[key]
    else extra[key] = value
  }
  // Encrypt secret extras
  const extraPersisted: Record<string, string> = {}
  for (const [key, value] of Object.entries(extra)) {
    extraPersisted[key] = EXTRA_SECRET_KEYS.has(key) && value ? encrypt(value) : value
  }

  const data = {
    channel: input.channel,
    provider: registry.id,
    enabled: input.enabled ?? existing?.enabled ?? false,
    // Empty/masked apiKey keeps the stored value
    apiKey: input.apiKey && !input.apiKeyIsMasked ? encrypt(input.apiKey) : (existing?.id ? undefined : ''),
    senderId: input.senderId ?? existing?.senderId ?? '',
    phoneNumberId: input.phoneNumberId ?? existing?.phoneNumberId ?? '',
    accountId: input.accountId ?? existing?.accountId ?? '',
    apiUrl: input.apiUrl || registry.defaultApiUrl,
    extraConfig: JSON.stringify(extraPersisted),
  }

  await db.providerConfig.upsert({
    where: { channel: input.channel },
    create: data as never,
    update: data as never,
  })

  const resolved = await getProviderConfig(input.channel)
  return resolved as ResolvedProviderConfig
}

/** Admin-facing masked view of a channel config */
export async function getProviderConfigMasked(channel: Channel) {
  const row = await db.providerConfig.findUnique({ where: { channel } })
  const resolved = await getProviderConfig(channel)

  let extraMasked: Record<string, string> = {}
  try {
    extraMasked = JSON.parse(row?.extraConfig || '{}')
  } catch {
    extraMasked = {}
  }
  for (const key of Object.keys(extraMasked)) {
    if (EXTRA_SECRET_KEYS.has(key) && extraMasked[key]) extraMasked[key] = maskSecret('xxxxxxxx')
  }

  return {
    channel,
    provider: resolved?.provider ?? PROVIDER_REGISTRY[channel].id,
    enabled: resolved?.enabled ?? false,
    apiKey: resolved?.apiKey ? maskApiKey(resolved.apiKey) : '',
    hasApiKey: Boolean(resolved?.apiKey),
    senderId: resolved?.senderId ?? '',
    phoneNumberId: resolved?.phoneNumberId ?? '',
    accountId: resolved?.accountId ?? '',
    apiUrl: resolved?.apiUrl ?? PROVIDER_REGISTRY[channel].defaultApiUrl,
    extra: extraMasked,
    lastTestAt: row?.lastTestAt ?? null,
    lastTestOk: row?.lastTestOk ?? null,
    lastTestError: row?.lastTestError ?? null,
    configured: Boolean(resolved?.apiKey),
  }
}

export async function recordTestResult(channel: Channel, ok: boolean, error?: string) {
  await db.providerConfig.updateMany({
    where: { channel },
    data: { lastTestAt: new Date(), lastTestOk: ok, lastTestError: ok ? null : (error || 'Unknown error').slice(0, 400) },
  })
}
