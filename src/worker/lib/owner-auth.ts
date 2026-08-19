import { hashToken } from './crypto'

const encoder = new TextEncoder()

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

export async function verifyOwnerPassword(password: string, encodedHash: string | undefined): Promise<boolean> {
  if (!encodedHash) return false
  const [algorithm, iterationsRaw, saltRaw, hashRaw] = encodedHash.split('$')
  const iterations = Number(iterationsRaw)
  if (algorithm !== 'pbkdf2-sha256' || !Number.isInteger(iterations) || iterations < 100_000 || !saltRaw || !hashRaw) return false
  try {
    const salt = decodeBase64Url(saltRaw)
    const saltBuffer = new Uint8Array(salt.byteLength)
    saltBuffer.set(salt)
    const expected = decodeBase64Url(hashRaw)
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBuffer.buffer, iterations }, key, expected.length * 8)
    return constantTimeBytesEqual(new Uint8Array(bits), expected)
  } catch {
    return false
  }
}

export function createOwnerSessionToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function hashOwnerSessionToken(token: string): Promise<string> {
  return hashToken(token)
}

export const OWNER_SESSION_COOKIE = 'pa_session'
export const OWNER_SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
