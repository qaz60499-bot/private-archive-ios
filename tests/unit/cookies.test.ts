import { describe, expect, it } from 'vitest'
import { readCookieValue } from '../../src/worker/lib/cookies'
import { SHARE_SESSION_COOKIE, isShareHostAllowed, shareSessionCookie } from '../../src/worker/lib/share-security'
import type { Env } from '../../src/worker/env'

describe('cookie parsing security', () => {
  it('returns null instead of throwing on malformed percent encoding', () => {
    expect(() => readCookieValue(`${SHARE_SESSION_COOKIE}=%`, SHARE_SESSION_COOKIE)).not.toThrow()
    expect(readCookieValue(`${SHARE_SESSION_COOKIE}=%`, SHARE_SESSION_COOKIE)).toBeNull()
  })

  it('decodes the requested cookie and ignores unrelated cookies', () => {
    expect(readCookieValue('other=1; target=a%2Fb%3Dc', 'target')).toBe('a/b=c')
    expect(readCookieValue('other=1', 'target')).toBeNull()
  })
})

describe('share perimeter hardening', () => {
  const env = {
    MOCK_TELEGRAM: 'true',
    SHARE_ORIGIN: 'https://photo.example.com/shared?app=shared',
  } as Env

  it('does not let MOCK_TELEGRAM widen the share host allowlist on public hosts', () => {
    expect(isShareHostAllowed(env, 'https://photo.example.com/api/share/session')).toBe(true)
    expect(isShareHostAllowed(env, 'https://attacker.example/api/share/session')).toBe(false)
  })

  it('keeps local development hosts available and scopes the bearer cookie to share APIs', () => {
    expect(isShareHostAllowed(env, 'http://photo.localhost:8799/api/share/session')).toBe(true)
    const cookie = shareSessionCookie('token-value', new Date(Date.now() + 60_000).toISOString(), true)
    expect(cookie).toContain('Path=/api/share')
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('SameSite=Lax')
    expect(cookie).toContain('Secure')
  })
})
