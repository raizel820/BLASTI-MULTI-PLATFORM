/**
 * @blasti/api — Chargily Payment Service
 *
 * Integrates with Chargily Pay API v2 for Algerian payment processing
 * (EDAHABIA of Algérie Poste + CIB of SATIM).
 * Supports checkout session creation, webhook verification, status queries
 * and balance retrieval (key validation).
 *
 * Documentation: https://dev.chargily.com/pay-v2/introduction
 *
 * Configuration (via config-manager — set by the SUPER ADMIN in
 * Platform Settings → Payment Engine, NO server env restart needed):
 *   chargily_api_key     — API key for Chargily (payment category, encrypted)
 *   chargily_secret_key  — Secret key for webhook HMAC verification (payment category, encrypted)
 *   chargily_mode        — "sandbox" or "live" (payment category)
 *
 * Chargily uses DZD (Algerian Dinar) as the default currency.
 * Amounts are sent in centimes (1 DZD = 100 centimes) — matching the
 * balance endpoint which also reports centimes (e.g. 150000 = 1,500.00 DZD).
 *
 * IMPORTANT (2025 API contract): POST /checkouts no longer accepts a nested
 * `customer` object — only `customer_id`, referencing a customer created
 * beforehand via POST /customers. Sending the old nested object makes the
 * gateway answer 422 and reject the WHOLE checkout (the balance probe keeps
 * working, which is why the keys test fine but agency payments failed).
 *
 * Optional env overrides (mainly for testing):
 *   CHARGILY_API_URL   — overrides the live-mode base URL
 *   CHARGILY_TEST_URL  — overrides the sandbox-mode base URL
 */

import { getConfig } from './config-manager'
import { createHmac, timingSafeEqual } from 'crypto'

// ─── Constants ──────────────────────────────────────────────────────────────

const CHARGILY_BASE_URL = process.env.CHARGILY_API_URL || 'https://pay.chargily.net/api/v2'
const CHARGILY_TEST_URL = process.env.CHARGILY_TEST_URL || 'https://pay.chargily.net/test/api/v2'

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getBaseUrl(): Promise<string> {
  const mode = await getConfig('chargily_mode')
  return mode === 'live' ? CHARGILY_BASE_URL : CHARGILY_TEST_URL
}

/**
 * Chargily Pay v2 key model (https://dev.chargily.com/pay-v2/introduction):
 *   • SECRET key (…_sk_…) — authenticates EVERY server-side API call
 *     (Bearer token) AND signs the webhook payloads (HMAC-SHA256).
 *   • PUBLIC key (…_pk_…) — client-side only. The Pay v2 REST API ALWAYS
 *     answers 401 "Unauthenticated" to it (verified against the live API).
 *
 * The Chargily dashboard shows both keys side by side, so it is easy to
 * paste the public key into the wrong field. Instead of trusting the field
 * names, we simply use whichever stored value is a real SECRET key — the
 * integration then works no matter which field the admin pasted it into.
 */
function isPublicKey(key: string | null | undefined): boolean {
  // Base62 key bodies never contain '_', so 'pk_' can only be the key-type marker.
  return !!key && key.includes('pk_')
}

/**
 * In-memory cache of created Chargily customer ids (per base URL + name),
 * so a returning payer reuses the same remote customer instead of creating
 * a duplicate on every checkout.
 */
const customerCache = new Map<string, { id: string; expiresAt: number }>()
const CUSTOMER_CACHE_TTL = 24 * 60 * 60 * 1000
const CUSTOMER_CACHE_MAX = 200

/**
 * Create (or reuse a cached) Chargily customer for the payer — best-effort.
 *
 * The Pay v2 API only accepts `customer_id` on checkout creation (a reference
 * to a customer created via POST /customers); a nested customer object is
 * rejected with 422. This helper never blocks the checkout: on ANY failure
 * it returns null and the checkout is created without a customer_id (the
 * field is optional).
 */
export async function ensureCustomerId(
  baseUrl: string,
  apiKey: string,
  name?: string,
  email?: string,
): Promise<string | null> {
  const cleanName = (name || '').trim()
  const cleanEmail = (email || '').trim()
  if (!cleanName && !cleanEmail) return null

  const cacheKey = `${baseUrl}|${cleanName}|${cleanEmail}`
  const cached = customerCache.get(cacheKey)
  if (cached) {
    if (cached.expiresAt > Date.now()) return cached.id
    customerCache.delete(cacheKey)
  }

  try {
    const res = await fetch(`${baseUrl}/customers`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ...(cleanName && { name: cleanName }),
        ...(cleanEmail && { email: cleanEmail }),
      }),
    })
    if (!res.ok) {
      console.warn(
        `[chargily] customer creation failed (${res.status}) — continuing without customer_id`,
      )
      return null
    }
    const customer = (await res.json()) as { id?: string }
    if (!customer?.id) return null
    if (customerCache.size >= CUSTOMER_CACHE_MAX) {
      const oldest = customerCache.keys().next().value
      if (oldest) customerCache.delete(oldest)
    }
    customerCache.set(cacheKey, { id: customer.id, expiresAt: Date.now() + CUSTOMER_CACHE_TTL })
    return customer.id
  } catch (err) {
    console.warn('[chargily] customer creation error — continuing without customer_id:', err)
    return null
  }
}

/** The usable SECRET key from either settings field (null when none). */
async function getUsableSecretKey(): Promise<string | null> {
  const [apiKey, secretKey] = await Promise.all([
    getConfig('chargily_api_key'),
    getConfig('chargily_secret_key'),
  ])
  if (apiKey && !isPublicKey(apiKey)) return apiKey
  if (secretKey && !isPublicKey(secretKey)) return secretKey
  return null
}

async function getApiKey(): Promise<string> {
  const key = await getUsableSecretKey()
  if (!key) {
    throw new Error(
      'Chargily keys not configured correctly — the SECRET key (test_sk_… in sandbox / sk_… in live) is required; the public key (test_pk_…) is never valid server-side',
    )
  }
  return key
}

/**
 * Whether Chargily is usable (a SECRET key exists in either field) — used by
 * the public payment-settings endpoint so clients only show EDAHABIA/CIB
 * options when the super admin has entered a working key.
 */
export async function isChargilyConfigured(): Promise<boolean> {
  return !!(await getUsableSecretKey())
}

/**
 * Whether the API is running in Chargily live mode.
 */
export async function isChargilyLiveMode(): Promise<boolean> {
  const mode = await getConfig('chargily_mode')
  return mode === 'live'
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutParams {
  amount: number        // Amount in DZD (will be converted to centimes)
  description: string
  metadata: Record<string, string>
  successUrl: string
  failureUrl: string
  customerName?: string
  customerEmail?: string
  customerId?: string   // Pre-created Chargily customer id (optional)
  paymentMethod?: string  // 'edahabia' | 'cib' — defaults to 'edahabia'
  locale?: string         // 'ar' | 'en' | 'fr' — language of the hosted checkout page
  webhookEndpoint?: string // optional per-checkout webhook override
}

export interface ChargilyCheckout {
  id: string
  amount: number
  status: string
  currency: string
  description: string | null
  metadata: Record<string, string> | null
  checkout_url: string
  success_url: string
  failure_url: string | null
  payment_method: string | null
  created_at: string
  updated_at: string
  livemode?: boolean
  fees?: number
  invoice_id?: string | null
  customer_id?: string | null
  qr_code_url?: string | null
}

export interface ChargilyWebhookEvent {
  id: string
  type: string  // 'checkout.paid', 'checkout.failed', etc.
  data: {
    id: string
    status: string
    amount: number
    currency: string
    description: string | null
    metadata: Record<string, string> | null
    payment_method: string | null
    checkout_url: string
    created_at: string
    updated_at: string
  }
  created_at: string
  livemode: boolean | string
}

export interface ChargilyBalance {
  entity: string
  livemode: boolean
  wallets: Array<{
    currency: string
    balance: number
    ready_for_payout: string | number
    on_hold: number
  }>
}

// ─── Checkout Operations ────────────────────────────────────────────────────

/**
 * Create a Chargily checkout session.
 *
 * @param params - Checkout parameters including amount (in DZD), description, URLs, and optional customer info
 * @returns The Chargily checkout object including the checkout_url to redirect the user to
 * @throws Error if the API key is not configured or the API call fails
 */
export async function createCheckout(params: CheckoutParams): Promise<ChargilyCheckout> {
  const baseUrl = await getBaseUrl()
  const apiKey = await getApiKey()

  // Convert amount to centimes (Chargily uses DZD centimes)
  const amountInCents = Math.round(params.amount * 100)

  const body: Record<string, unknown> = {
    amount: amountInCents,
    currency: 'dzd',
    description: params.description,
    metadata: params.metadata,
    success_url: params.successUrl,
    failure_url: params.failureUrl,
    payment_method: params.paymentMethod || 'edahabia',
    locale: params.locale || 'ar',
  }

  if (params.webhookEndpoint) {
    body.webhook_endpoint = params.webhookEndpoint
  }

  // The API accepts ONLY a pre-created customer reference here — never a
  // nested customer object (that shape is retired and triggers a 422).
  const customerId = params.customerId || (await ensureCustomerId(baseUrl, apiKey, params.customerName, params.customerEmail))
  if (customerId) {
    body.customer_id = customerId
  }

  const response = await fetch(`${baseUrl}/checkouts`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Chargily API error: ${response.status} - ${error}`)
  }

  return response.json() as Promise<ChargilyCheckout>
}

/**
 * Verify a Chargily webhook signature using HMAC-SHA256.
 *
 * The signature is computed over the RAW request body with the API secret key
 * (see https://dev.chargily.com/pay-v2/webhooks).
 *
 * @param payload - The raw request body (as string)
 * @param signature - The signature from the `signature` header
 * @returns true if the signature is valid, false otherwise
 * @throws Error if the secret key is not configured
 */
export async function verifyWebhookSignature(payload: string, signature: string): Promise<boolean> {
  const secretKey = await getUsableSecretKey()
  if (!secretKey) {
    throw new Error(
      'Chargily secret key not configured — use the SECRET key (test_sk_… / sk_…), the same one used for API calls',
    )
  }

  const expectedSig = createHmac('sha256', secretKey)
    .update(payload)
    .digest('hex')

  // Timing-safe comparison to prevent timing attacks
  if (signature.length !== expectedSig.length) return false
  try {
    return timingSafeEqual(Buffer.from(signature, 'utf8'), Buffer.from(expectedSig, 'utf8'))
  } catch {
    return false
  }
}

/**
 * Get the status of a Chargily checkout session.
 *
 * @param checkoutId - The Chargily checkout ID
 * @returns The checkout object with current status
 * @throws Error if the API key is not configured or the API call fails
 */
export async function getCheckoutStatus(checkoutId: string): Promise<ChargilyCheckout> {
  const baseUrl = await getBaseUrl()
  const apiKey = await getApiKey()

  const response = await fetch(`${baseUrl}/checkouts/${checkoutId}`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Chargily API error: ${response.status}`)
  }

  return response.json() as Promise<ChargilyCheckout>
}

/**
 * Retrieve the Chargily account balance — used by the super-admin
 * "Test connection" button to validate the configured API keys.
 *
 * @returns The balance object with the three wallets (DZD, USD, EUR)
 * @throws Error if the API key is not configured or invalid
 */
export async function getBalance(): Promise<ChargilyBalance> {
  const baseUrl = await getBaseUrl()
  const apiKey = await getApiKey()

  const response = await fetch(`${baseUrl}/balance`, {
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    const error = await response.text().catch(() => '')
    throw new Error(`Chargily API error: ${response.status} ${error}`.trim())
  }

  return response.json() as Promise<ChargilyBalance>
}

/**
 * Expire a pending Chargily checkout (e.g. when the user cancels locally).
 */
export async function expireCheckout(checkoutId: string): Promise<ChargilyCheckout> {
  const baseUrl = await getBaseUrl()
  const apiKey = await getApiKey()

  const response = await fetch(`${baseUrl}/checkouts/${checkoutId}/expire`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
    },
  })

  if (!response.ok) {
    throw new Error(`Chargily API error: ${response.status}`)
  }

  return response.json() as Promise<ChargilyCheckout>
}
