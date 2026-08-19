import type { Context, Next } from 'hono'
import type { Env } from '../env'
import { verifyAccessJwt } from './access-jwt'
import { constantTimeEqual } from './crypto'

type WorkerContext = Context<{ Bindings: Env }>

function isLocalHost(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost'
}

export async function requireOwner(context: WorkerContext, next: Next): Promise<Response | void> {
  const env = context.env
  const url = new URL(context.req.url)
  const mockLocal = env.MOCK_TELEGRAM === 'true' || isLocalHost(url.hostname)
  if (!mockLocal) {
    if (!env.OWNER_EMAIL || !env.POLICY_AUD || !env.TEAM_DOMAIN) {
      return context.json({ error: 'ACCESS_NOT_CONFIGURED' }, 503)
    }
    const accessJwt = context.req.header('Cf-Access-Jwt-Assertion')
    const accessEmail = context.req.header('Cf-Access-Authenticated-User-Email')
    const jwtValid = Boolean(accessJwt) && await verifyAccessJwt(accessJwt as string, {
      audience: env.POLICY_AUD,
      ownerEmail: env.OWNER_EMAIL,
      teamDomain: env.TEAM_DOMAIN,
    })
    const ownerMatches = Boolean(accessEmail) && accessEmail!.toLowerCase() === env.OWNER_EMAIL.toLowerCase()
    if (!jwtValid || !ownerMatches) return context.json({ error: 'OWNER_AUTH_REQUIRED' }, 401)
  }

  if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method)) {
    const origin = context.req.header('Origin')
    const allowedOrigin = env.ALLOWED_ORIGIN || url.origin
    if (!mockLocal && (!origin || origin !== allowedOrigin)) {
      return context.json({ error: 'ORIGIN_NOT_ALLOWED' }, 403)
    }
  }
  await next()
}

export function verifyWebhookSecret(actual: string | undefined, expected: string | undefined): boolean {
  return Boolean(actual && expected && constantTimeEqual(actual, expected))
}
