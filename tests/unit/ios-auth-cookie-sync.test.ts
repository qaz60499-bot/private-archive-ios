// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../ios/App/App/NativeBackgroundUpload.swift', import.meta.url), 'utf8')

describe('iOS application auth cookie bridge', () => {
  it('observes the WKWebView cookie store and mirrors pa_account into native URLSession storage', () => {
    expect(source).toContain('WKHTTPCookieStoreObserver')
    expect(source).toContain('cookieStore.add(self)')
    expect(source).toContain('func cookiesDidChange(in cookieStore: WKHTTPCookieStore)')
    expect(source).toContain('HTTPCookieStorage.shared.setCookie(cookie)')
    expect(source).toContain('private let appSessionCookieName = "pa_account"')
  })

  it('keeps WKWebView authoritative, removes stale native auth on logout, and wakes pending transfers after auth restoration', () => {
    expect(source).toContain('HTTPCookieStorage.shared.deleteCookie(cookie)')
    expect(source).toContain('bootstrapAuthenticationCookieStores(cookieStore)')
    expect(source).toContain('syncWebAuthenticationCookieToNative(cookieStore)')
    expect(source).not.toContain('cookieStore.setCookie(nativeCookie)')
    expect(source.match(/resumePendingTransfers\(\)/g)?.length).toBeGreaterThanOrEqual(1)
  })
})
