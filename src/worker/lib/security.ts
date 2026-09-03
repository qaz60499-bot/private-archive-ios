import type { Context, Next } from 'hono'
import type { Env } from '../env'
import type { AppUserRow } from '../db/app-users-repository'
import { getActiveAppOwner } from '../db/app-users-repository'
import { resolveAppSessionRuntime } from './auth-runtime'
import { APP_SESSION_COOKIE } from './app-auth'
import { verifyAccessJwt } from './access-jwt'
import { constantTimeEqual } from './crypto'
import { readCookieValue } from './cookies'

type WorkerContext = Context<{ Bindings: Env }>

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized.endsWith('.localhost')
}

function isLocalOrMock(context: WorkerContext): boolean {
  // MOCK_TELEGRAM changes storage behavior, but must never become an auth bypass
  // merely because the flag was accidentally deployed on a public hostname.
  return isLocalHost(new URL(context.req.url).hostname)
}

export function isDesktopApiRequest(context: WorkerContext): boolean {
  const hostname = new URL(context.req.url).hostname.toLowerCase()
  const expectedHosts = (context.env.DESKTOP_API_HOST ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  return expectedHosts.includes(hostname)
}

function shouldBypassAppAuth(context: WorkerContext): boolean {
  return isLocalOrMock(context) && context.env.E2E_APP_AUTH_MODE !== 'strict'
}

function isHostedUploadRequest(context: WorkerContext): boolean {
  if (isLocalOrMock(context) || isDesktopApiRequest(context)) return false
  try {
    const requestHost = new URL(context.req.url).hostname.toLowerCase()
    const uploadHost = context.env.SHARE_ORIGIN ? new URL(context.env.SHARE_ORIGIN).hostname.toLowerCase() : ''
    return Boolean(uploadHost && requestHost === uploadHost)
  } catch {
    return false
  }
}

export function isHostedUploadApiRequestAllowed(method: string, pathname: string): boolean {
  const verb = method.toUpperCase()
  const path = pathname.length > 1 && pathname.endsWith('/') ? pathname.slice(0, -1) : pathname

  // Share sessions are a separate, token-scoped security principal and retain their
  // own route-level authorization. The upload portal restriction only removes the
  // implicit D1 OWNER capability from normal archive/admin APIs on the hosted host.
  if (path === '/api/share' || path.startsWith('/api/share/')) return true
  if (path === '/api/health') return verb === 'GET' || verb === 'HEAD'
  if (path === '/api/storage-preference') return verb === 'GET'
  if (path === '/api/assets/reserve') return verb === 'POST'
  if (/^\/api\/assets\/[^/]+\/content$/.test(path)) return verb === 'PUT'
  if (/^\/api\/assets\/[^/]+\/preview$/.test(path)) return verb === 'POST'
  return false
}

export async function restrictHostedUploadApiScope(context: WorkerContext, next: Next): Promise<Response | void> {
  if (!isHostedUploadRequest(context)) {
    await next()
    return
  }
  const url = new URL(context.req.url)
  if (!isHostedUploadApiRequestAllowed(context.req.method, url.pathname)) {
    return context.json({ error: 'WEB_UPLOAD_PORTAL_SCOPE_DENIED' }, 403)
  }
  await next()
}

async function verifyAccessPerimeter(context: WorkerContext, ownerOnly: boolean): Promise<Response | null> {
  if (isLocalOrMock(context) || isDesktopApiRequest(context)) return null
  const env = context.env
  if (!env.POLICY_AUD || !env.TEAM_DOMAIN || (ownerOnly && !env.OWNER_EMAIL)) {
    return context.json({ error: 'ACCESS_NOT_CONFIGURED' }, 503)
  }
  const accessJwt = context.req.header('Cf-Access-Jwt-Assertion')
  if (!accessJwt) return context.json({ error: 'ACCESS_SIGN_IN_REQUIRED' }, 401)
  const valid = await verifyAccessJwt(accessJwt, {
    audience: env.POLICY_AUD,
    teamDomain: env.TEAM_DOMAIN,
    ownerEmail: ownerOnly ? env.OWNER_EMAIL : undefined,
  })
  if (!valid) return context.json({ error: ownerOnly ? 'OWNER_AUTH_REQUIRED' : 'ACCESS_SIGN_IN_REQUIRED' }, 401)
  return null
}

export function isDesktopMutationOriginAllowed(origin: string | undefined, nativePlatform: string | undefined): boolean {
  const platform = nativePlatform?.trim().toLowerCase()
  const nativeClient = platform === 'ios'
  if (nativeClient && !origin) return true
  if (!origin) return false
  try {
    const originUrl = new URL(origin)
    const loopbackHttp = originUrl.protocol === 'http:' && isLocalHost(originUrl.hostname)
    const capacitorIos = nativeClient && originUrl.protocol === 'capacitor:' && originUrl.hostname.toLowerCase() === 'localhost'
    return loopbackHttp || capacitorIos
  } catch {
    return false
  }
}

function verifyMutationOrigin(context: WorkerContext): Response | null {
  if (['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) || isLocalOrMock(context)) return null
  const origin = context.req.header('Origin')
  if (isDesktopApiRequest(context)) {
    if (!isDesktopMutationOriginAllowed(origin, context.req.header('X-Private-Archive-Native'))) {
      return context.json({ error: 'ORIGIN_NOT_ALLOWED' }, 403)
    }
    return null
  }
  const url = new URL(context.req.url)
  const allowedOrigin = context.env.ALLOWED_ORIGIN || url.origin
  if (!origin || origin !== allowedOrigin) return context.json({ error: 'ORIGIN_NOT_ALLOWED' }, 403)
  return null
}

export async function resolveRequestAppUser(context: WorkerContext): Promise<AppUserRow | null> {
  const rawToken = readCookieValue(context.req.header('Cookie'), APP_SESSION_COOKIE)
  if (!rawToken && shouldBypassAppAuth(context)) {
    const now = new Date(0).toISOString()
    return {
      id: 'mock-owner', workspace_id: 'personal', username: 'owner', display_name: 'Mock Owner',
      password_hash: '', role: 'OWNER', status: 'ACTIVE', last_login_at: null, created_at: now, updated_at: now,
    }
  }
  if (rawToken) {
    const sessionUser = await resolveAppSessionRuntime(context.env, rawToken)
    if (sessionUser) return sessionUser
  }
  // Hosted Web is a private owner-only upload portal behind Cloudflare Access.
  // Route middleware validates the Access JWT against OWNER_EMAIL before this
  // identity is resolved, so Web reuses the D1 OWNER without a second app login.
  // Desktop keeps its normal app-session / multi-account model.
  if (isHostedUploadRequest(context)) return getActiveAppOwner(context.env.DB)
  return null
}

export async function requireAccess(context: WorkerContext, next: Next): Promise<Response | void> {
  const perimeterError = await verifyAccessPerimeter(context, isHostedUploadRequest(context))
  if (perimeterError) return perimeterError
  const originError = verifyMutationOrigin(context)
  if (originError) return originError
  await next()
}

export async function requireAccount(context: WorkerContext, next: Next): Promise<Response | void> {
  const presentedSession = Boolean(readCookieValue(context.req.header('Cookie'), APP_SESSION_COOKIE))
  if (shouldBypassAppAuth(context) && !presentedSession) {
    await next()
    return
  }
  const perimeterError = await verifyAccessPerimeter(context, isHostedUploadRequest(context))
  if (perimeterError) return perimeterError
  const user = await resolveRequestAppUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const originError = verifyMutationOrigin(context)
  if (originError) return originError
  await next()
}

export async function requireOwner(context: WorkerContext, next: Next): Promise<Response | void> {
  const presentedSession = Boolean(readCookieValue(context.req.header('Cookie'), APP_SESSION_COOKIE))
  if (shouldBypassAppAuth(context) && !presentedSession) {
    await next()
    return
  }
  const perimeterError = await verifyAccessPerimeter(context, isHostedUploadRequest(context))
  if (perimeterError) return perimeterError
  const user = await resolveRequestAppUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  if (user.role !== 'OWNER') return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  const originError = verifyMutationOrigin(context)
  if (originError) return originError
  await next()
}

export async function requireAccessOwner(context: WorkerContext, next: Next): Promise<Response | void> {
  const perimeterError = await verifyAccessPerimeter(context, true)
  if (perimeterError) return perimeterError
  const originError = verifyMutationOrigin(context)
  if (originError) return originError
  await next()
}

export function verifyWebhookSecret(actual: string | undefined, expected: string | undefined): boolean {
  return Boolean(actual && expected && constantTimeEqual(actual, expected))
}
