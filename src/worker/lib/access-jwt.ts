interface AccessJwtHeader {
  alg?: string
  kid?: string
}

interface AccessJwtPayload {
  aud?: string | string[]
  email?: string
  exp?: number
  iss?: string
  nbf?: number
}

interface AccessJwk extends JsonWebKey {
  kid?: string
}

interface AccessJwksResponse {
  keys?: AccessJwk[]
}

export interface VerifyAccessJwtOptions {
  audience: string
  ownerEmail?: string
  teamDomain: string
  fetcher?: typeof fetch
  nowSeconds?: number
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

function decodeJson<T>(value: string): T {
  const bytes = decodeBase64Url(value)
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}

function normalizeTeamDomain(teamDomain: string): string {
  return teamDomain.trim().replace(/\/$/, '')
}

function audienceMatches(actual: string | string[] | undefined, expected: string): boolean {
  if (typeof actual === 'string') return actual === expected
  return Array.isArray(actual) && actual.includes(expected)
}

export async function verifyAccessJwt(token: string, options: VerifyAccessJwtOptions): Promise<boolean> {
  const parts = token.split('.')
  if (parts.length !== 3) return false

  let header: AccessJwtHeader
  let payload: AccessJwtPayload
  try {
    header = decodeJson<AccessJwtHeader>(parts[0])
    payload = decodeJson<AccessJwtPayload>(parts[1])
  } catch {
    return false
  }

  if (header.alg !== 'RS256' || !header.kid) return false

  const teamDomain = normalizeTeamDomain(options.teamDomain)
  if (!teamDomain.startsWith('https://') || payload.iss !== teamDomain) return false
  if (!audienceMatches(payload.aud, options.audience)) return false
  if (options.ownerEmail && (!payload.email || payload.email.toLowerCase() !== options.ownerEmail.toLowerCase())) return false

  const now = options.nowSeconds ?? Math.floor(Date.now() / 1000)
  if (typeof payload.exp !== 'number' || payload.exp <= now) return false
  if (typeof payload.nbf === 'number' && payload.nbf > now + 30) return false

  const fetcher = options.fetcher ?? fetch
  let jwks: AccessJwksResponse
  try {
    const response = await fetcher(`${teamDomain}/cdn-cgi/access/certs`, {
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: 3600 },
    } as RequestInit)
    if (!response.ok) return false
    jwks = await response.json() as AccessJwksResponse
  } catch {
    return false
  }

  const jwk = jwks.keys?.find((key) => key.kid === header.kid)
  if (!jwk || jwk.kty !== 'RSA') return false

  try {
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    )
    const signatureBytes = decodeBase64Url(parts[2])
    const signature = signatureBytes.buffer.slice(signatureBytes.byteOffset, signatureBytes.byteOffset + signatureBytes.byteLength) as ArrayBuffer
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, signingInput)
  } catch {
    return false
  }
}
