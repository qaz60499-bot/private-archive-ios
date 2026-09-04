// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const mainSource = readFileSync(new URL('../../src/web/main.tsx', import.meta.url), 'utf8')

describe('desktop loopback service worker regression guard', () => {
  it('does not keep a PWA service worker controlling the installed desktop bundle', () => {
    expect(mainSource).toContain("['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname)")
    expect(mainSource).toContain('navigator.serviceWorker.getRegistrations()')
    expect(mainSource).toContain('registration.unregister()')
    expect(mainSource).toContain("sessionStorage.getItem('private-archive:desktop-sw-reset')")
  })

  it('still registers the service worker for non-native hosted web surfaces', () => {
    expect(mainSource).toContain('} else if (!nativeApp) {')
    expect(mainSource).toContain('registerSW({')
  })
})
