// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { resolveAppSurface } from '../../src/web/lib/app-surface'

const authGate = readFileSync(new URL('../../src/web/components/AuthGate.tsx', import.meta.url), 'utf8')
const settingsPage = readFileSync(new URL('../../src/web/pages/SettingsPage.tsx', import.meta.url), 'utf8')
const webUploadPage = readFileSync(new URL('../../src/web/pages/WebUploadPage.tsx', import.meta.url), 'utf8')

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

  it('keeps client password constraints aligned with the worker 9-character minimum', () => {
    expect(authGate).toContain('minLength={9} maxLength={256}')
    expect(authGate).toContain('密码长度为 9–256 个字符。')
    expect(authGate).not.toContain('minLength={10}')
    expect(settingsPage).toContain('minLength={9} maxLength={256} autoComplete="new-password"')
    expect(settingsPage).not.toContain('minLength={10}')
    expect(authGate).toContain('minLength={9} maxLength={256} aria-describedby="recovery-password-help"')
    expect(webUploadPage).toContain('minLength={9} maxLength={256}')
    expect(webUploadPage).toContain('9–256 个字符')
  })

  it('sends native account recovery to the Access-protected hosted portal', () => {
    expect(authGate).toContain("window.location.protocol === 'capacitor:'")
    expect(authGate).toContain("const HOSTED_RECOVERY_URL = 'https://photo.joye.cc.cd/'")
    expect(authGate).toContain('target="_blank" rel="noreferrer"')
    expect(authGate).toContain('在浏览器打开密码恢复')
    expect(authGate).toContain('Cloudflare Access 验证')
    expect(resolveAppSurface({ hostname: 'photo.joye.cc.cd', search: '' })).toBe('web-upload')
    expect(resolveAppSurface({ hostname: 'photo.joye.cc.cd', search: '?app=shared' })).toBe('shared')
  })
})
