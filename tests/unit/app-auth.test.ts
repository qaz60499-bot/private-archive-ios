import { describe, expect, it } from 'vitest'
import { APP_SESSION_TTL_SECONDS, appPasswordNeedsUpgrade, createAppSessionToken, hashAppPassword, hashAppSessionToken, verifyAppPassword } from '../../src/worker/lib/app-auth'

describe('application account authentication', () => {
  it('hashes and verifies passwords without storing plaintext', async () => {
    const password = 'correct-horse-photo-archive'
    const encoded = await hashAppPassword(password)
    expect(encoded).toMatch(/^pbkdf2-sha256\$600000\$/)
    expect(appPasswordNeedsUpgrade(encoded)).toBe(false)
    expect(encoded).not.toContain(password)
    expect(await verifyAppPassword(password, encoded)).toBe(true)
    expect(await verifyAppPassword('wrong-password', encoded)).toBe(false)
  })

  it('accepts the legacy password work factor so login can upgrade it in place', async () => {
    const password = 'legacy-photo-password'
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: 100_000 }, key, 256)
    const encode = (bytes: Uint8Array) => {
      let binary = ''
      for (const byte of bytes) binary += String.fromCharCode(byte)
      return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
    }
    const encoded = `pbkdf2-sha256$100000$${encode(salt)}$${encode(new Uint8Array(bits))}`
    expect(await verifyAppPassword(password, encoded)).toBe(true)
    expect(appPasswordNeedsUpgrade(encoded)).toBe(true)
  })

  it('uses a long rolling device-session window', () => {
    expect(APP_SESSION_TTL_SECONDS).toBe(400 * 24 * 60 * 60)
  })

  it('creates opaque session tokens and stable one-way hashes', async () => {
    const token = createAppSessionToken()
    expect(token.length).toBeGreaterThanOrEqual(40)
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/)
    const first = await hashAppSessionToken(token)
    const second = await hashAppSessionToken(token)
    expect(first).toBe(second)
    expect(first).not.toContain(token)
  })
})
