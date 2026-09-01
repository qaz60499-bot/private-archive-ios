import { describe, expect, it } from 'vitest'
import { appendCookieDomain, nativeAppCookieDomain } from '../../src/worker/lib/app-session-cookie'

describe('native app session cookie domain', () => {
  it('adds the production API hostname for iOS native requests', () => {
    expect(nativeAppCookieDomain('https://api.photo.joye.cc.cd/api/auth/login', 'ios')).toBe('api.photo.joye.cc.cd')
  })

  it('does not add Domain for normal browser requests', () => {
    expect(nativeAppCookieDomain('https://api.photo.joye.cc.cd/api/auth/login', undefined)).toBeNull()
    expect(nativeAppCookieDomain('https://photo.joye.cc.cd/api/auth/login', 'web')).toBeNull()
  })

  it('does not add Domain on non-HTTPS or loopback development URLs', () => {
    expect(nativeAppCookieDomain('http://127.0.0.1:8787/api/auth/login', 'ios')).toBeNull()
    expect(nativeAppCookieDomain('https://localhost/api/auth/login', 'ios')).toBeNull()
  })

  it('appends Domain only when one is provided', () => {
    const base = 'pa_account=value; Path=/; HttpOnly; SameSite=Lax; Secure'
    expect(appendCookieDomain(base, 'api.photo.joye.cc.cd')).toBe(`${base}; Domain=api.photo.joye.cc.cd`)
    expect(appendCookieDomain(base, null)).toBe(base)
  })
})
