/**
 * Task 41 — shared account-creation validation + server-error mapping.
 *
 * Two user-reported bugs live here:
 * 1. "this URL is invalid" when picking a PRESET avatar — the server used to
 *    reject data URIs (fixed API-side in validations.ts); the client keeps
 *    sending the preset data URI as-is (max ~1.8KB, well under the 8KB cap).
 * 2. "unexpected string" when the phone field was left empty — the client
 *    silently OMITTED phoneNumber, and zod v4 answered with its raw machine
 *    message. Now: the client validates every field BEFORE submit (with a
 *    per-field message), always SENDS the phone field, and maps the server's
 *    `details` array onto the matching inputs so EVERY invalid field shows
 *    its own translated message — the user always knows where the problem is.
 */

/** Algerian mobile numbers: 05/06/07 (+ optional +213/00213 prefix, spaces, dashes, dots). */
const PHONE_REGEX = /^(\+213|00213)?0?[5-7]\d{8}$/;

export function normalizePhone(phone: string): string {
  return phone.replace(/[\s\-.]/g, '');
}

export function isValidPhone(phone: string): boolean {
  return PHONE_REGEX.test(normalizePhone(phone));
}

/**
 * Client-side validation for the phone field.
 * Returns an i18n KEY (null = valid). The register forms translate it via t().
 */
export function validatePhoneField(phone: string): 'phoneRequired' | 'invalidPhone' | null {
  const trimmed = phone.trim();
  if (!trimmed) return 'phoneRequired';
  if (!isValidPhone(trimmed)) return 'invalidPhone';
  return null;
}

/**
 * Map the API's per-field validation payload onto form field errors.
 *
 * The API (validateBody) returns BOTH:
 *   • error   → first humanized message (back-compat toast fallback)
 *   • details → [{ field, message }, ...] for EVERY invalid field
 *
 * Known server messages are translated through i18n keys so an Arabic UI
 * never shows an English sentence; unknown messages fall back to the raw
 * server text (still attached to the right field).
 */
const SERVER_MESSAGE_I18N: Record<string, string> = {
  'Phone number is required': 'phoneRequired',
  'Enter a valid Algerian phone number (e.g. 0555123456)': 'invalidPhone',
  'Username must be at least 3 characters': 'usernameMinLength',
  'This username is already taken': 'usernameTaken',
  'A valid email address is required': 'emailInvalid',
  'This email is already used by another account': 'emailTaken',
  'Full name is required': 'fieldRequired',
  'Password must be at least 6 characters': 'passwordMinLength',
};

/** Server field names → register-form fieldErrors keys. */
const SERVER_FIELD_MAP: Record<string, string> = {
  username: 'username',
  email: 'email',
  phoneNumber: 'phoneNumber',
  password: 'password',
  fullName: 'fullName',
  avatarUrl: 'avatar',
  wilaya: 'wilaya',
  commune: 'commune',
};

type Translator = (key: string) => string;

export interface ServerValidationPayload {
  error?: string;
  details?: Array<{ field: string; message: string }>;
}

/**
 * Build a Record<fieldKey, translatedMessage> from the API error body.
 * Falls back to substring-matching the top-level `error` (legacy servers)
 * when `details` is absent. Returns null when nothing maps to a field.
 */
export function mapServerFieldErrors(
  data: ServerValidationPayload | null | undefined,
  t: Translator,
): Record<string, string> | null {
  const errors: Record<string, string> = {};
  const details = data?.details;

  if (Array.isArray(details) && details.length > 0) {
    for (const issue of details) {
      const formField = SERVER_FIELD_MAP[issue.field] ?? issue.field;
      if (!formField || formField === 'form') continue;
      const i18nKey = SERVER_MESSAGE_I18N[issue.message];
      // First message per field wins (zod order = schema order).
      if (!errors[formField]) {
        errors[formField] = i18nKey ? t(i18nKey) : issue.message;
      }
    }
    if (Object.keys(errors).length > 0) return errors;
    return null;
  }

  // Legacy fallback: no details — sniff the single top-level message.
  const topMessage = data?.error;
  if (!topMessage) return null;
  const i18nKey = SERVER_MESSAGE_I18N[topMessage];
  const translated = i18nKey ? t(i18nKey) : topMessage;
  const lower = topMessage.toLowerCase();
  if (lower.includes('username')) errors.username = translated;
  else if (lower.includes('email')) errors.email = translated;
  else if (lower.includes('phone')) errors.phoneNumber = translated;
  else if (lower.includes('password')) errors.password = translated;
  else if (lower.includes('file url')) errors.avatar = translated;
  else return null;
  return errors;
}
