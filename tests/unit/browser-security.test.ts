import { describe, expect, it } from 'vitest'
import { applyBrowserSecurityHeaders } from '../../src/worker/lib/browser-security'

describe('hosted browser security headers', () => {
  it('adds CSP, anti-framing and HTTPS transport hardening without changing the body', async () => {
    const secured = applyBrowserSecurityHeaders(new Response('<html>ok</html>', {
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }), 'https://photo.example.com/')

    expect(secured.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
    expect(secured.headers.get('Content-Security-Policy')).toContain("img-src 'self' data: blob:")
    expect(secured.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(secured.headers.get('X-Frame-Options')).toBe('DENY')
    expect(secured.headers.get('Referrer-Policy')).toBe('no-referrer')
    expect(secured.headers.get('Strict-Transport-Security')).toBe('max-age=31536000')
    expect(await secured.text()).toBe('<html>ok</html>')
  })

  it('does not advertise HSTS on local HTTP development', () => {
    const secured = applyBrowserSecurityHeaders(new Response('ok'), 'http://127.0.0.1:8799/')
    expect(secured.headers.has('Strict-Transport-Security')).toBe(false)
  })
})
