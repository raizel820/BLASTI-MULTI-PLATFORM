/**
 * @blasti/api — Provider Registry (Task 22)
 *
 * Static metadata for the three chosen messaging providers. The admin UI
 * renders its forms from this registry, so adding a provider later means
 * adding an entry here + an adapter in the matching service module.
 *
 *   EMAIL     → Resend            (https://resend.com)           api.resend.com
 *   SMS       → eSMS Africa       (https://esmsafrica.io)        api.esmsafrica.io
 *   WHATSAPP  → Meta WhatsApp     (Cloud API, graph.facebook.com)
 */

export type Channel = 'EMAIL' | 'SMS' | 'WHATSAPP'

export interface ProviderField {
  key: string
  label: string
  /** Where the value is persisted on ProviderConfig */
  target: 'apiKey' | 'senderId' | 'phoneNumberId' | 'accountId' | 'apiUrl' | 'extra'
  /** true → rendered as password input + stored encrypted */
  secret?: boolean
  required?: boolean
  placeholder?: string
  help?: string
}

export interface ProviderInfo {
  id: string
  name: string
  channel: Channel
  description: string
  docsUrl: string
  defaultApiUrl: string
  supportsTemplates: boolean
  /** Whether the provider has a server-side template gallery we can list */
  supportsProviderTemplateList: boolean
  /** Whether OTP codes can be delivered through this provider */
  supportsOtp: boolean
  fields: ProviderField[]
  /** Extra JSON keys merged into ProviderConfig.extraConfig */
  extraFields?: ProviderField[]
  notes?: string[]
}

export const CHANNELS: Channel[] = ['SMS', 'EMAIL', 'WHATSAPP']

export const PROVIDER_REGISTRY: Record<Channel, ProviderInfo> = {
  SMS: {
    id: 'esmsafrica',
    name: 'eSMS Africa',
    channel: 'SMS',
    description: 'African SMS gateway with direct routes to Algerian operators (Mobilis, Djezzy, Ooredoo). SMS OTP + notifications.',
    docsUrl: 'https://docs.esmsafrica.io',
    defaultApiUrl: 'https://api.esmsafrica.io/v1',
    supportsTemplates: true,
    supportsProviderTemplateList: false,
    supportsOtp: true,
    fields: [
      { key: 'apiKey', label: 'API Key', target: 'apiKey', secret: true, required: true, placeholder: 'esms_live_...', help: 'Bearer key from the eSMS Africa dashboard (Settings → API Keys).' },
      { key: 'senderId', label: 'Sender ID', target: 'senderId', required: true, placeholder: 'BLASTI', help: 'Alphanumeric sender ID shown on recipients\' phones (max 11 chars).' },
      { key: 'apiUrl', label: 'API Base URL', target: 'apiUrl', placeholder: 'https://api.esmsafrica.io/v1', help: 'Override only if instructed by eSMS support. Leave empty for the default.' },
    ],
    extraFields: [
      { key: 'testPhoneNumber', label: 'Test phone number', target: 'extra', placeholder: '+213555123456' },
    ],
    notes: [
      'OTP codes are delivered as regular SMS with the app-side template body.',
      'A 6-digit numeric code is generated server-side; dev mode bypasses with 1234.',
    ],
  },
  EMAIL: {
    id: 'resend',
    name: 'Resend',
    channel: 'EMAIL',
    description: 'Modern transactional email API. Email verification + notifications.',
    docsUrl: 'https://resend.com/docs',
    defaultApiUrl: 'https://api.resend.com',
    supportsTemplates: true,
    supportsProviderTemplateList: false,
    supportsOtp: true,
    fields: [
      { key: 'apiKey', label: 'API Key', target: 'apiKey', secret: true, required: true, placeholder: 're_...', help: 'From the Resend dashboard (API Keys). Use a restricted sending key.' },
      { key: 'senderId', label: 'From address', target: 'senderId', required: true, placeholder: 'BLASTI <no-reply@yourdomain.com>', help: 'Must use a domain verified in Resend (Domains → DKIM verified).' },
      { key: 'apiUrl', label: 'API Base URL', target: 'apiUrl', placeholder: 'https://api.resend.com', help: 'Leave empty for the default.' },
    ],
    extraFields: [
      { key: 'testEmailAddress', label: 'Test email address', target: 'extra', placeholder: 'admin@yourdomain.com' },
      { key: 'replyTo', label: 'Reply-To (optional)', target: 'extra', placeholder: 'support@yourdomain.com' },
    ],
    notes: [
      'Templates are app-side (Templates tab) — Resend has no server-side template gallery; emails are delivered through the /emails endpoint.',
      'Free tier: 100 emails/day, 3,000/month. Verify your sending domain for production.',
    ],
  },
  WHATSAPP: {
    id: 'meta_whatsapp',
    name: 'Meta WhatsApp Cloud API',
    channel: 'WHATSAPP',
    description: 'Official WhatsApp Business Cloud API. WhatsApp OTP (authentication templates) + notifications.',
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/cloud-api',
    defaultApiUrl: 'https://graph.facebook.com/v21.0',
    supportsTemplates: true,
    supportsProviderTemplateList: true,
    supportsOtp: true,
    fields: [
      { key: 'apiKey', label: 'Permanent Access Token', target: 'apiKey', secret: true, required: true, placeholder: 'EAAG...', help: 'System-user token with whatsapp_business_messaging + whatsapp_business_management scopes.' },
      { key: 'phoneNumberId', label: 'Phone Number ID', target: 'phoneNumberId', required: true, placeholder: '123456789012345', help: 'WhatsApp → API Setup → Phone number ID.' },
      { key: 'accountId', label: 'WABA ID', target: 'accountId', required: true, placeholder: '987654321098765', help: 'WhatsApp Business Account ID — used to list approved templates.' },
      { key: 'apiUrl', label: 'Graph API Base URL', target: 'apiUrl', placeholder: 'https://graph.facebook.com/v21.0', help: 'Leave empty for the default.' },
    ],
    extraFields: [
      { key: 'webhookVerifyToken', label: 'Webhook verify token', target: 'extra', secret: true, placeholder: 'any-random-string', help: 'Used for the Meta webhook subscription handshake (GET verification).' },
      { key: 'testPhoneNumber', label: 'Test phone number', target: 'extra', placeholder: '+213555123456' },
    ],
    notes: [
      'OTP delivery uses a Meta-APPROVED authentication template (pick one below or in the Templates tab). Without an approved template, WhatsApp OTP falls back to SMS automatically.',
      'Free-form (non-template) texts are only delivered within the 24-hour customer service window; notifications outside that window must use an approved template.',
      'Pricing is per delivered message; authentication templates have a fixed rate.',
    ],
  },
}

/** Legacy provider ids removed from the codebase (kept only for migration cleanup) */
export const REMOVED_PROVIDERS = ['winsms', 'notifsend', 'algeria_sms', 'green_send', 'mtarget', 'twilio', 'vonage', 'generic'] as const
