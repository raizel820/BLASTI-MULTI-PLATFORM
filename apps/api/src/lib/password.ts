import crypto from 'crypto'
import { promisify } from 'util'

const SCRYPT_KEYLEN = 64
const SCRYPT_COST = 16384
const SCRYPT_BLOCK_SIZE = 8
const SCRYPT_PARALLELIZATION = 1

// 0.6.127 perf — the previous implementation used crypto.scryptSync, which
// BLOCKS the single event loop for ~50-150ms per call. Every login, every
// wrong-username timing probe and every password change froze ALL concurrent
// requests (queue polling included) for that duration — very visible during
// morning-shift login bursts. crypto.scrypt runs on libuv's thread pool, so
// concurrent requests keep flowing while the hash works.
const scrypt = promisify(crypto.scrypt) as (
  password: string,
  salt: string,
  keylen: number,
  options: crypto.ScryptOptions
) => Promise<Buffer>

/**
 * Hash a password using Node.js crypto scrypt (async — thread pool).
 * Returns a string in the format: salt:hash (both hex-encoded)
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16).toString('hex')
  const derivedKey = await scrypt(
    password,
    salt,
    SCRYPT_KEYLEN,
    {
      N: SCRYPT_COST,
      r: SCRYPT_BLOCK_SIZE,
      p: SCRYPT_PARALLELIZATION,
    }
  )
  const hash = (derivedKey as Buffer).toString('hex')
  return `${salt}:${hash}`
}

/**
 * Verify a password against a stored hash.
 * The stored hash must be in the format: salt:hash (both hex-encoded)
 */
export async function verifyPassword(password: string, storedHash: string): Promise<boolean> {
  const [salt, hash] = storedHash.split(':')
  if (!salt || !hash) return false

  const expected = Buffer.from(hash, 'hex')
  let derivedKey: Buffer
  try {
    derivedKey = (await scrypt(
      password,
      salt,
      SCRYPT_KEYLEN,
      {
        N: SCRYPT_COST,
        r: SCRYPT_BLOCK_SIZE,
        p: SCRYPT_PARALLELIZATION,
      }
    )) as Buffer
  } catch {
    return false
  }
  const computedHash = derivedKey.toString('hex')
  const computed = Buffer.from(computedHash, 'hex')
  // timingSafeEqual throws ERR_TIMING_EQUAL on length mismatch — a corrupted
  // stored hash must return false, not crash the request.
  if (expected.length !== computed.length) return false
  return crypto.timingSafeEqual(expected, computed)
}
