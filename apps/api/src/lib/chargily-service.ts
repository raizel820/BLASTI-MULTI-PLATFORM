/**
 * @blasti/api — Chargily Payment Service
 *
 * Integrates with Chargily API v2 for Algerian payment processing.
 * Supports checkout session creation, webhook verification, and status queries.
 *
 * Configuration (via config-manager):
 *   chargily_api_key     — API key for Chargily (payment category)
 *   chargily_secret_key  — Secret key for webhook HMAC verification (payment category)
 *   chargily_mode        — "sandbox" or "live" (payment category)
 *
 * Chargily uses DZD (Algerian Dinar) as the default currency.
 * Amounts are sent in cents (1 DZD = 100 cents).
 */

import { getConfig } from './config-manager'
import { createHmac } from 'crypto'

// ─── Constants ──────────────────────────────────────────────────────────────

const CHARGILY_BASE_URL = 'https://pay.chargily.net/api/v2'
const CHARGILY_TEST_URL = 'https://pay.chargily.net/test/api/v2'

// ─── Helpers ────────────────────────────────────────────────────────────────

async function getBaseUrl(): Promise<string> {
  const mode = await getConfig('chargily_mode')
  return mode === 'live' ? CHARGILY_BASE_URL : CHARGILY_TEST_URL
}

async function getApiKey(): Promise<string> {
  const key = await getConfig('chargily_api_key')
  if (!key) throw new Error('Chargily API key not configured')
  return key
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface CheckoutParams {
  amount: number        // Amount in DZD (will be converted to cents)
  description: string
  metadata: Record<string, string>
  successUrl: string
  failureUrl: string
  customerName?: string
  customerEmail?: string
  paymentMethod?: string  // e.g., 'edahabia', 'cib' — defaults to 'edahabia'
}

export interface ChargilyCheckout {
  id: string
  amount: number
  status: string
  currency: string
  description: string
  metadata: Record<string, string>
  checkout_url: string
  success_url: string
  failure_url: string
  payment_method: string
  created_at: string
  updated_at: string
}

export interface ChargilyWebhookEvent {
  id: string
  type: string  // 'checkout.paid', 'checkout.failed', etc.
  data: {
    id: string
    status: string
    amount: number
    currency: string
    description: string
    metadata: Record<string, string>
    payment_method: string
    checkout_url: string
    created_at: string
    updated_at: string
  }
  created_at: string
  livemode: boolean
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

  // Convert amount to cents (Chargily uses DZD cents)
  const amountInCents = Math.round(params.amount * 100)

  const body: Record<string, unknown> = {
    amount: amountInCents,
    currency: 'dzd',
    description: params.description,
    metadata: params.metadata,
    success_url: params.successUrl,
    failure_url: params.failureUrl,
    payment_method: params.paymentMethod || 'edahabia',
  }

  if (params.customerName || params.customerEmail) {
    body.customer = {
      ...(params.customerName && { name: params.customerName }),
      ...(params.customerEmail && { email: params.customerEmail }),
    }
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
 * @param payload - The raw request body (as string)
 * @param signature - The signature from the `Signature` header
 * @returns true if the signature is valid, false otherwise
 * @throws Error if the secret key is not configured
 */
export async function verifyWebhookSignature(payload: string, signature: string): Promise<boolean> {
  const secretKey = await getConfig('chargily_secret_key')
  if (!secretKey) throw new Error('Chargily secret key not configured')

  const expectedSig = createHmac('sha256', secretKey)
    .update(payload)
    .digest('hex')

  // Timing-safe comparison to prevent timing attacks
  if (signature.length !== expectedSig.length) return false
  let result = 0
  for (let i = 0; i < signature.length; i++) {
    result |= signature.charCodeAt(i) ^ expectedSig.charCodeAt(i)
  }
  return result === 0
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
