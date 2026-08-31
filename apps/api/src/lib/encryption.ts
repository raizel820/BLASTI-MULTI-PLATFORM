/**
 * @blasti/api — AES-256-CBC Encryption Utility
 *
 * Provides encrypt/decrypt for sensitive system configuration values
 * (API keys, secrets, etc.) stored in the SystemSetting table.
 *
 * Key derivation: scrypt with a fixed salt from ENCRYPTION_KEY or
 * NEXTAUTH_SECRET (falls back to a dev-only key).
 *
 * Format: `base64(iv):base64(ciphertext)`
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'crypto'

const ALGORITHM = 'aes-256-cbc'
const IV_LENGTH = 16

function getKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || 'fallback-dev-key-not-secure'
  return scryptSync(secret, 'blast1-salt-v1', 32)
}

/**
 * Encrypt a plaintext string using AES-256-CBC.
 * Returns `iv:ciphertext` both base64-encoded.
 */
export function encrypt(plaintext: string): string {
  const iv = randomBytes(IV_LENGTH)
  const key = getKey()
  const cipher = createCipheriv(ALGORITHM, key, iv)
  let encrypted = cipher.update(plaintext, 'utf8', 'base64')
  encrypted += cipher.final('base64')
  return iv.toString('base64') + ':' + encrypted
}

/**
 * Decrypt a ciphertext string produced by `encrypt()`.
 * Expects the `iv:ciphertext` format.
 */
export function decrypt(ciphertext: string): string {
  const parts = ciphertext.split(':')
  if (parts.length !== 2) throw new Error('Invalid encrypted format')
  const iv = Buffer.from(parts[0], 'base64')
  const key = getKey()
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  let decrypted = decipher.update(parts[1], 'base64', 'utf8')
  decrypted += decipher.final('utf8')
  return decrypted
}
