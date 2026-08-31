import crypto from 'crypto'

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

/**
 * Hash a password using Node.js crypto scryptSync.
 * Returns a string in the format: salt:hash (both hex-encoded)
 */
export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex')
  const derivedKey = crypto.scryptSync(
    password,
    salt,
    SCRYPT_KEYLEN,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }
  )
  const hash = derivedKey.toString('hex')
  return `${salt}:${hash}`
}

/**
 * Verify a password against a stored hash.
 * The stored hash must be in the format: salt:hash (both hex-encoded)
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const [salt, hash] = storedHash.split(':')
  if (!salt || !hash) return false

  const derivedKey = crypto.scryptSync(
    password,
    salt,
    SCRYPT_KEYLEN,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }
  )
  const computedHash = derivedKey.toString('hex')
  return crypto.timingSafeEqual(
    Buffer.from(hash, 'hex'),
    Buffer.from(computedHash, 'hex')
  )
}
