import { describe, expect, it } from 'vitest'
import { verifyAccessJwt } from '../../src/worker/lib/access-jwt'

function base64Url(value: Uint8Array | string): string {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

async function createFixture(overrides: Record<string, unknown> = {}) {
  const pair = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  )
  const jwk = await crypto.subtle.exportKey('jwk', pair.publicKey) as JsonWebKey & { kid?: string }
  jwk.kid = 'test-key'
  jwk.alg = 'RS256'
  const now = 2_000_000_000
  const header = base64Url(JSON.stringify({ alg: 'RS256', kid: 'test-key', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({
    aud: ['archive-aud'],
    email: 'qaz60499@gmail.com',
    exp: now + 600,
    iss: 'https://private-archive.cloudflareaccess.com',
    nbf: now - 30,
    ...overrides,
  }))
  const input = `${header}.${payload}`
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(input)))
  return {
    token: `${input}.${base64Url(signature)}`,
    jwk,
    now,
  }
}

function fetchJwk(jwk: JsonWebKey): typeof fetch {
  return async () => new Response(JSON.stringify({ keys: [jwk] }), { status: 200 })
}

describe('Cloudflare Access JWT verification', () => {
  it('accepts a valid signed token for the configured owner', async () => {
    const fixture = await createFixture()
    await expect(verifyAccessJwt(fixture.token, {
      audience: 'archive-aud',
      ownerEmail: 'qaz60499@gmail.com',
      teamDomain: 'https://private-archive.cloudflareaccess.com',
      fetcher: fetchJwk(fixture.jwk),
      nowSeconds: fixture.now,
    })).resolves.toBe(true)
  })

  it('rejects a token for a different email', async () => {
    const fixture = await createFixture({ email: 'other@example.com' })
    await expect(verifyAccessJwt(fixture.token, {
      audience: 'archive-aud',
      ownerEmail: 'qaz60499@gmail.com',
      teamDomain: 'https://private-archive.cloudflareaccess.com',
      fetcher: fetchJwk(fixture.jwk),
      nowSeconds: fixture.now,
    })).resolves.toBe(false)
  })

  it('rejects a token without an email claim when owner identity is required', async () => {
    const fixture = await createFixture({ email: undefined })
    await expect(verifyAccessJwt(fixture.token, {
      audience: 'archive-aud',
      ownerEmail: 'qaz60499@gmail.com',
      teamDomain: 'https://private-archive.cloudflareaccess.com',
      fetcher: fetchJwk(fixture.jwk),
      nowSeconds: fixture.now,
    })).resolves.toBe(false)
  })

  it('rejects the wrong audience and expired tokens before trusting identity', async () => {
    const wrongAudience = await createFixture({ aud: ['other-aud'] })
    const expired = await createFixture({ exp: wrongAudience.now - 1 })
    const options = {
      audience: 'archive-aud',
      ownerEmail: 'qaz60499@gmail.com',
      teamDomain: 'https://private-archive.cloudflareaccess.com',
      nowSeconds: wrongAudience.now,
    }
    await expect(verifyAccessJwt(wrongAudience.token, { ...options, fetcher: fetchJwk(wrongAudience.jwk) })).resolves.toBe(false)
    await expect(verifyAccessJwt(expired.token, { ...options, fetcher: fetchJwk(expired.jwk) })).resolves.toBe(false)
  })

  it('rejects a token whose signature does not match the published key', async () => {
    const signed = await createFixture()
    const otherKey = await createFixture()
    await expect(verifyAccessJwt(signed.token, {
      audience: 'archive-aud',
      ownerEmail: 'qaz60499@gmail.com',
      teamDomain: 'https://private-archive.cloudflareaccess.com',
      fetcher: fetchJwk(otherKey.jwk),
      nowSeconds: signed.now,
    })).resolves.toBe(false)
  })
})
