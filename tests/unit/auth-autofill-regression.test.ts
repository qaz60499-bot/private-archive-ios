// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const authGate = readFileSync(new URL('../../src/web/components/AuthGate.tsx', import.meta.url), 'utf8')

describe('application login autofill regression guard', () => {
  it('submits the live DOM values so browser and iOS password autofill are accepted', () => {
    expect(authGate).toContain('const fields = new FormData(form)')
    expect(authGate).toContain("fields.get('username')")
    expect(authGate).toContain("fields.get('password')")
    expect(authGate).not.toContain('value={password}')
    expect(authGate).not.toContain('value={username}')
  })

  it('keeps credential-manager hints and focuses the password field for a saved account', () => {
    expect(authGate).toContain('autoComplete="on"')
    expect(authGate).toContain('autoComplete="username"')
    expect(authGate).toContain("autoComplete={auth.initialized ? 'current-password' : 'new-password'}")
    expect(authGate).toContain('passwordInput.current?.focus()')
  })
})
