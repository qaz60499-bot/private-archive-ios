// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

function source(path: string): string {
  return readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8')
}

describe('desktop security boundary', () => {
  it('never embeds a reusable bootstrap secret into the distributable executable', () => {
    const buildScript = source('desktop/windows/build-desktop.cmd')
    const launcher = source('desktop/windows/DesktopLauncher.cs')
    const authRoute = source('src/worker/routes/auth.ts')

    expect(buildScript).not.toContain('.desktop-bootstrap-token')
    expect(buildScript).not.toContain('PrivateArchive.Bootstrap')
    expect(launcher).not.toContain('X-Private-Archive-Bootstrap')
    expect(authRoute).not.toContain('DESKTOP_BOOTSTRAP_TOKEN')
    expect(authRoute).toContain("DESKTOP_BOOTSTRAP_NOT_ALLOWED")
  })

  it('forwards only the Private Archive app-session cookie to the remote API', () => {
    const launcher = source('desktop/windows/DesktopLauncher.cs')

    expect(launcher).toContain('AppSessionCookieName = "pa_account"')
    expect(launcher).toContain('CopyAppSessionCookie(context.Request, outbound)')
    expect(launcher).toContain('CopyAppSessionCookie(source, request)')
    expect(launcher).not.toContain('CopyRequestHeader(context.Request, outbound, "Cookie")')
    expect(launcher).not.toContain('CopyRequestHeader(source, request, "Cookie")')
    expect(launcher).toContain('RewriteAppSessionCookieForLoopback')
  })

  it('requires the exact loopback app origin for local state-changing requests and blocks framing', () => {
    const launcher = source('desktop/windows/DesktopLauncher.cs')

    expect(launcher).toContain('LOCAL_ORIGIN_NOT_ALLOWED')
    expect(launcher).toContain('http://127.0.0.1:')
    expect(launcher).toContain('Content-Security-Policy')
    expect(launcher).toContain('frame-ancestors \'none\'')
    expect(launcher).toContain('X-Frame-Options')
    expect(launcher).toContain('DENY')
    expect(launcher).toContain('X-Content-Type-Options')
    expect(launcher).toContain('nosniff')
  })
})
