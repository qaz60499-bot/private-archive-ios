import { hashToken } from './crypto'

const encoder = new TextEncoder()
const CURRENT_PASSWORD_ITERATIONS = 600_000
const LEGACY_PASSWORD_ITERATIONS = new Set([100_000])
const PASSWORD_BYTES = 32

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function constantTimeBytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  const max = Math.max(left.length, right.length)
  let difference = left.length ^ right.length
  for (let index = 0; index < max; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0)
  return difference === 0
}

async function derivePassword(password: string, salt: Uint8Array, iterations: number, byteLength: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const saltBytes = new Uint8Array(salt.byteLength)
  saltBytes.set(salt)
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes.buffer, iterations },
    key,
    byteLength * 8,
  )
  return new Uint8Array(bits)
}

export async function hashAppPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const derived = await derivePassword(password, salt, CURRENT_PASSWORD_ITERATIONS, PASSWORD_BYTES)
  return `pbkdf2-sha256$${CURRENT_PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(derived)}`
}

export async function verifyAppPassword(password: string, encodedHash: string): Promise<boolean> {
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = encodedHash.split('$')
  const iterations = Number(iterationsRaw)
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || !saltRaw || !hashRaw) return false
  if (iterations !== CURRENT_PASSWORD_ITERATIONS && !LEGACY_PASSWORD_ITERATIONS.has(iterations)) return false
  try {
    const salt = decodeBase64Url(saltRaw)
    const expected = decodeBase64Url(hashRaw)
    const actual = await derivePassword(password, salt, iterations, expected.byteLength)
    return constantTimeBytesEqual(actual, expected)
  } catch {
    return false
  }
}

export function appPasswordNeedsUpgrade(encodedHash: string): boolean {
  const [algorithm, iterationsRaw] = encodedHash.split('$')
  const iterations = Number(iterationsRaw)
  return algorithm !== 'pbkdf2-sha256' || iterations !== CURRENT_PASSWORD_ITERATIONS
}

export function createAppSessionToken(): string {
  return encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
}

export async function hashAppSessionToken(token: string): Promise<string> {
  return hashToken(token)
}

export const APP_SESSION_COOKIE = 'pa_account'
// Keep a signed-in device persistent across normal app restarts. Browsers cap
// persistent cookies at roughly 400 days, so use that as the rolling window and
// refresh it on authenticated app startup. Explicit logout, password changes, or
// account disablement still revoke the session immediately.
export const APP_SESSION_TTL_SECONDS = 400 * 24 * 60 * 60
