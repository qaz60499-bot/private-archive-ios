import { Hono } from 'hono'
import type { Env } from '../env'
import {
  appUsersInitialized,
  createAppUser,
  getAppUserById,
  getAppUserByUsername,
  listAppUsers,
  resetAllAppUserPasswords,
  toPublicAppUser,
  updateAppUser,
  type AppUserRow,
} from '../db/app-users-repository'
import {
  applyAppUserPreset,
  deriveAccessPreset,
  listAppUserGrants,
  replaceAppUserGrants,
  type AppUserGrant,
} from '../db/app-user-access-repository'
import { APP_SESSION_COOKIE, APP_SESSION_TTL_SECONDS, createAppSessionToken, hashAppPassword, verifyAppPassword } from '../lib/app-auth'
import { appendCookieDomain, nativeAppCookieDomain } from '../lib/app-session-cookie'
import {
  clearLoginFailuresRuntime,
  createAppSessionRuntime,
  deleteAppSessionRuntime,
  pruneAuthRuntime,
  recentAccountLoginFailuresRuntime,
  recentLoginFailuresRuntime,
  recordLoginAttemptRuntime,
  refreshAppSessionRuntime,
} from '../lib/auth-runtime'
import { readCookieValue } from '../lib/cookies'
import { isDesktopApiRequest, requireAccess, requireAccessOwner, resolveRequestAppUser } from '../lib/security'

export const authRoutes = new Hono<{ Bindings: Env }>()

// Keep unknown-user and wrong-password login paths computationally similar so the
// response time does not become a useful username-enumeration signal.
const DUMMY_PASSWORD_HASH = 'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA$rviEDng25ewevI55dpOubgFIgkXY1jczBVJ9GBW19E4'

function secureCookie(url: string): boolean {
  return new URL(url).protocol === 'https:'
}

function sessionCookie(token: string, secure: boolean, domain: string | null): string {
  const cookie = `${APP_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${APP_SESSION_TTL_SECONDS}${secure ? '; Secure' : ''}`
  return appendCookieDomain(cookie, domain)
}

function clearSessionCookie(secure: boolean, domain: string | null): string {
  const cookie = `${APP_SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
  return appendCookieDomain(cookie, domain)
}

function requestCookieDomain(context: { req: { url: string; header(name: string): string | undefined } }): string | null {
  return nativeAppCookieDomain(context.req.url, context.req.header('X-Private-Archive-Native'))
}

function rawSessionToken(cookieHeader: string | undefined): string | null {
  return readCookieValue(cookieHeader, APP_SESSION_COOKIE)
}

function hostedRecoveryRequestAllowed(context: { req: { url: string }; env: Env }): boolean {
  try {
    const requestHost = new URL(context.req.url).hostname.toLowerCase()
    const hostedHost = context.env.SHARE_ORIGIN ? new URL(context.env.SHARE_ORIGIN).hostname.toLowerCase() : ''
    return Boolean(hostedHost && requestHost === hostedHost)
  } catch {
    return false
  }
}

function clientIp(headers: Headers, requestUrl: string): string {
  const cloudflareIp = headers.get('cf-connecting-ip')?.trim()
  if (cloudflareIp) return cloudflareIp
  const hostname = new URL(requestUrl).hostname.toLowerCase()
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname.endsWith('.localhost')) {
    return headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local-unknown'
  }
  // The production custom domain is Cloudflare-fronted. If that trusted header is
  // unexpectedly absent, fail closed onto one shared throttle bucket rather than
  // trusting a client-supplied X-Forwarded-For value.
  return 'unknown'
}

function validateUsername(value: unknown): string {
  const username = typeof value === 'string' ? value.trim() : ''
  if (!/^[\p{L}\p{N}._-]{3,40}$/u.test(username)) throw new Error('USERNAME_INVALID')
  return username
}

function validateDisplayName(value: unknown): string {
  const displayName = typeof value === 'string' ? value.trim() : ''
  if (!displayName || displayName.length > 80) throw new Error('DISPLAY_NAME_INVALID')
  return displayName
}

function validatePassword(value: unknown): string {
  const password = typeof value === 'string' ? value : ''
  if (password.length < 9 || password.length > 256) throw new Error('PASSWORD_INVALID')
  return password
}

const MAX_AUTH_JSON_BYTES = 16 * 1024

async function jsonBody(context: { req: { raw: Request } }): Promise<Record<string, unknown>> {
  const request = context.req.raw
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new Error('REQUEST_BODY_INVALID')
    if (parsedLength > MAX_AUTH_JSON_BYTES) throw new Error('REQUEST_BODY_TOO_LARGE')
  }
  if (!request.body) throw new Error('REQUEST_BODY_INVALID')

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_AUTH_JSON_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new Error('REQUEST_BODY_TOO_LARGE')
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    throw new Error('REQUEST_BODY_INVALID')
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('REQUEST_BODY_INVALID')
  return body as Record<string, unknown>
}

function authBodyErrorStatus(code: string): 400 | 413 | 500 {
  if (code === 'REQUEST_BODY_TOO_LARGE') return 413
  return code.endsWith('_INVALID') ? 400 : 500
}

async function verifyLoginPassword(env: Env, password: string, encodedHash: string): Promise<boolean> {
  const verifier = env.PASSWORD_VERIFIER
  if (!verifier) return verifyAppPassword(password, encodedHash)
  return verifier.getByName('app-login-password-verifier').verify(password, encodedHash)
}

async function requireCurrentOwner(context: Parameters<typeof resolveRequestAppUser>[0]) {
  const user = await resolveRequestAppUser(context)
  return user?.role === 'OWNER' && user.status === 'ACTIVE' ? user : null
}

async function publicUserWithAccess(db: D1Database, user: AppUserRow) {
  if (user.role === 'OWNER') return { ...toPublicAppUser(user), accessPreset: 'FULL' as const, grants: [] as AppUserGrant[] }
  const grants = await listAppUserGrants(db, user.id)
  return { ...toPublicAppUser(user), accessPreset: deriveAccessPreset(grants), grants }
}

function parseAccessPreset(value: unknown): 'FULL' | 'VIEWER' | 'UPLOAD_ONLY' | null {
  return value === 'FULL' || value === 'VIEWER' || value === 'UPLOAD_ONLY' ? value : null
}

function parseAccessGrants(value: unknown): AppUserGrant[] | null {
  if (!Array.isArray(value)) return null
  const grants: AppUserGrant[] = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null
    const candidate = item as Record<string, unknown>
    if (typeof candidate.scopeType !== 'string' || typeof candidate.scopeId !== 'string' || typeof candidate.permission !== 'string') return null
    grants.push({
      scopeType: candidate.scopeType as AppUserGrant['scopeType'],
      scopeId: candidate.scopeId,
      permission: candidate.permission as AppUserGrant['permission'],
    })
  }
  return grants
}

authRoutes.get('/status', requireAccess, async (context) => {
  await pruneAuthRuntime(context.env)
  const presentedSession = rawSessionToken(context.req.header('Cookie'))
  const [initialized, user] = await Promise.all([
    appUsersInitialized(context.env.DB),
    resolveRequestAppUser(context),
  ])
  if (presentedSession && user) {
    try {
      await refreshAppSessionRuntime(context.env, user, presentedSession)
      context.header('Set-Cookie', sessionCookie(presentedSession, secureCookie(context.req.url), requestCookieDomain(context)))
    } catch (error) {
      console.warn('App session rolling refresh unavailable', { error: error instanceof Error ? error.message : String(error) })
    }
  } else if (presentedSession) {
    context.header('Set-Cookie', clearSessionCookie(secureCookie(context.req.url), requestCookieDomain(context)))
  }
  return context.json({
    initialized,
    authenticated: Boolean(user),
    user: user ? await publicUserWithAccess(context.env.DB, user) : null,
  })
})

authRoutes.post('/bootstrap', requireAccessOwner, async (context) => {
  try {
    // A bootstrap credential embedded in a distributable desktop binary is not a secret.
    // Initial owner creation is therefore allowed only through the hosted Access-protected
    // surface (or local development), never through the public desktop API hostname.
    if (isDesktopApiRequest(context)) return context.json({ error: 'DESKTOP_BOOTSTRAP_NOT_ALLOWED' }, 403)
    if (await appUsersInitialized(context.env.DB)) return context.json({ error: 'APP_ALREADY_INITIALIZED' }, 409)
    const body = await jsonBody(context)
    const username = validateUsername(body.username)
    const displayName = validateDisplayName(body.displayName)
    const password = validatePassword(body.password)
    const passwordHash = await hashAppPassword(password)
    const user = await createAppUser(context.env.DB, { username, displayName, passwordHash, role: 'OWNER' })
    const token = createAppSessionToken()
    await createAppSessionRuntime(context.env, user.id, token, user.password_hash)
    context.header('Set-Cookie', sessionCookie(token, secureCookie(context.req.url), requestCookieDomain(context)))
    return context.json({ user: await publicUserWithAccess(context.env.DB, user) }, 201)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_BOOTSTRAP_FAILED'
    if (code.includes('UNIQUE')) return context.json({ error: 'APP_ALREADY_INITIALIZED' }, 409)
    const status = authBodyErrorStatus(code)
    return context.json({ error: status === 500 ? 'APP_BOOTSTRAP_FAILED' : code }, status)
  }
})

authRoutes.post('/recover-passwords', requireAccessOwner, async (context) => {
  if (!hostedRecoveryRequestAllowed(context)) return context.json({ error: 'APP_RECOVERY_NOT_ALLOWED' }, 403)
  try {
    const body = await jsonBody(context)
    const password = validatePassword(body.password)
    const users = await listAppUsers(context.env.DB)
    const updates = await Promise.all(users.map(async (user) => ({
      id: user.id,
      passwordHash: await hashAppPassword(password),
    })))
    const count = await resetAllAppUserPasswords(context.env.DB, updates)
    return context.json({ ok: true, count })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_PASSWORD_RECOVERY_FAILED'
    const status = authBodyErrorStatus(code)
    return context.json({ error: status === 500 ? 'APP_PASSWORD_RECOVERY_FAILED' : code }, status)
  }
})

authRoutes.post('/login', requireAccess, async (context) => {
  const ip = clientIp(context.req.raw.headers, context.req.url)
  let stage = 'prune'
  try {
    await pruneAuthRuntime(context.env)
    stage = 'request-body'
    const body = await jsonBody(context)
    const username = validateUsername(body.username)
    const password = validatePassword(body.password)
    stage = 'preflight'
    const [initialized, ipFailures, accountFailures, user] = await Promise.all([
      appUsersInitialized(context.env.DB),
      recentLoginFailuresRuntime(context.env, ip),
      recentAccountLoginFailuresRuntime(context.env, username),
      getAppUserByUsername(context.env.DB, username),
    ])
    if (!initialized) return context.json({ error: 'APP_NOT_INITIALIZED' }, 409)
    if (ipFailures >= 8 || accountFailures >= 20) {
      context.header('Retry-After', '900')
      return context.json({ error: 'LOGIN_RATE_LIMITED' }, 429)
    }
    stage = 'verify-password'
    const passwordMatches = await verifyLoginPassword(context.env, password, user?.password_hash ?? DUMMY_PASSWORD_HASH)
    const ok = Boolean(user && user.status === 'ACTIVE' && passwordMatches)
    if (!ok || !user) {
      stage = 'record-failure'
      await recordLoginAttemptRuntime(context.env, ip, username, false)
      return context.json({ error: 'LOGIN_INVALID' }, 401)
    }
    stage = 'clear-failures'
    await clearLoginFailuresRuntime(context.env, ip, username)
    // Do not synchronously rehash legacy passwords during login. A stronger PBKDF2
    // migration can exceed the Worker request CPU budget after verification has
    // already succeeded, which turns a valid password into LOGIN_FAILED and leaves
    // no session. Explicit password changes still use the current stronger hash.
    stage = 'create-session'
    const token = createAppSessionToken()
    await createAppSessionRuntime(context.env, user.id, token, user.password_hash)
    context.header('Set-Cookie', sessionCookie(token, secureCookie(context.req.url), requestCookieDomain(context)))
    return context.json({ user: await publicUserWithAccess(context.env.DB, user) })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'LOGIN_FAILED'
    const status = authBodyErrorStatus(code)
    if (status === 500) console.error('App login failed', { stage, code })
    return context.json({ error: status === 500 ? 'LOGIN_FAILED' : code }, status)
  }
})

authRoutes.post('/logout', requireAccess, async (context) => {
  const token = rawSessionToken(context.req.header('Cookie'))
  if (token) await deleteAppSessionRuntime(context.env, token)
  context.header('Set-Cookie', clearSessionCookie(secureCookie(context.req.url), requestCookieDomain(context)))
  return context.json({ ok: true })
})

authRoutes.get('/me', requireAccess, async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  return context.json({ user: await publicUserWithAccess(context.env.DB, user) })
})

authRoutes.get('/users', requireAccess, async (context) => {
  const owner = await requireCurrentOwner(context)
  if (!owner) return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  const users = await listAppUsers(context.env.DB)
  return context.json({ items: await Promise.all(users.map(async (user) => {
    const row = await getAppUserById(context.env.DB, user.id)
    return row ? publicUserWithAccess(context.env.DB, row) : user
  })) })
})

authRoutes.post('/users', requireAccess, async (context) => {
  const owner = await requireCurrentOwner(context)
  if (!owner) return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  try {
    const body = await jsonBody(context)
    const username = validateUsername(body.username)
    const displayName = validateDisplayName(body.displayName)
    const password = validatePassword(body.password)
    const accessPreset = body.accessPreset === undefined ? 'VIEWER' : parseAccessPreset(body.accessPreset)
    if (!accessPreset) return context.json({ error: 'APP_ACCESS_PRESET_INVALID' }, 400)
    if (await getAppUserByUsername(context.env.DB, username)) return context.json({ error: 'USERNAME_EXISTS' }, 409)
    const user = await createAppUser(context.env.DB, {
      username,
      displayName,
      passwordHash: await hashAppPassword(password),
      role: 'MEMBER',
    })
    await applyAppUserPreset(context.env.DB, user.id, accessPreset)
    return context.json({ user: await publicUserWithAccess(context.env.DB, user) }, 201)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_USER_CREATE_FAILED'
    if (code.includes('UNIQUE')) return context.json({ error: 'USERNAME_EXISTS' }, 409)
    const status = authBodyErrorStatus(code)
    return context.json({ error: status === 500 ? 'APP_USER_CREATE_FAILED' : code }, status)
  }
})

authRoutes.post('/users/reset-passwords', requireAccess, async (context) => {
  const owner = await requireCurrentOwner(context)
  if (!owner) return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  try {
    const body = await jsonBody(context)
    const password = validatePassword(body.password)
    const users = await listAppUsers(context.env.DB)
    const updates = await Promise.all(users.map(async (user) => ({
      id: user.id,
      passwordHash: await hashAppPassword(password),
    })))
    const count = await resetAllAppUserPasswords(context.env.DB, updates)
    return context.json({ ok: true, count })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_PASSWORD_RESET_FAILED'
    const status = authBodyErrorStatus(code)
    return context.json({ error: status === 500 ? 'APP_PASSWORD_RESET_FAILED' : code }, status)
  }
})

authRoutes.put('/users/:id/access', requireAccess, async (context) => {
  const owner = await requireCurrentOwner(context)
  if (!owner) return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  const userId = context.req.param('id')
  const target = userId ? await getAppUserById(context.env.DB, userId) : null
  if (!target) return context.json({ error: 'APP_USER_NOT_FOUND' }, 404)
  if (target.role === 'OWNER') return context.json({ error: 'OWNER_ACCESS_IMMUTABLE' }, 409)
  try {
    const body = await jsonBody(context)
    const hasPreset = body.accessPreset !== undefined
    const hasGrants = body.grants !== undefined
    if (hasPreset === hasGrants) return context.json({ error: 'APP_ACCESS_UPDATE_INVALID' }, 400)
    if (hasPreset) {
      const preset = parseAccessPreset(body.accessPreset)
      if (!preset) return context.json({ error: 'APP_ACCESS_PRESET_INVALID' }, 400)
      await applyAppUserPreset(context.env.DB, target.id, preset)
    } else {
      const grants = parseAccessGrants(body.grants)
      if (!grants) return context.json({ error: 'APP_ACCESS_GRANTS_INVALID' }, 400)
      await replaceAppUserGrants(context.env.DB, target.id, grants)
    }
    const current = await getAppUserById(context.env.DB, target.id)
    return context.json({ user: current ? await publicUserWithAccess(context.env.DB, current) : null })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_ACCESS_UPDATE_FAILED'
    const status = code.includes('_INVALID') || code === 'APP_ACCESS_SCOPE_NOT_FOUND' || code === 'APP_ACCESS_TOO_MANY_GRANTS' ? 400 : 500
    return context.json({ error: status === 500 ? 'APP_ACCESS_UPDATE_FAILED' : code }, status)
  }
})

authRoutes.patch('/users/:id', requireAccess, async (context) => {
  const owner = await requireCurrentOwner(context)
  if (!owner) return context.json({ error: 'APP_OWNER_REQUIRED' }, 403)
  const userId = context.req.param('id')
  if (!userId) return context.json({ error: 'APP_USER_NOT_FOUND' }, 404)
  const target = await getAppUserById(context.env.DB, userId)
  if (!target) return context.json({ error: 'APP_USER_NOT_FOUND' }, 404)
  try {
    const body = await jsonBody(context)
    const status = body.status === undefined ? undefined : body.status === 'ACTIVE' || body.status === 'DISABLED' ? body.status : null
    if (status === null) return context.json({ error: 'STATUS_INVALID' }, 400)
    if (target.role === 'OWNER' && status === 'DISABLED') return context.json({ error: 'OWNER_CANNOT_BE_DISABLED' }, 409)
    const displayName = body.displayName === undefined ? undefined : validateDisplayName(body.displayName)
    const passwordHash = body.password === undefined ? undefined : await hashAppPassword(validatePassword(body.password))
    const updated = await updateAppUser(context.env.DB, target.id, { status, displayName, passwordHash })
    return context.json({ user: updated ? await publicUserWithAccess(context.env.DB, updated) : null })
  } catch (error) {
    const code = error instanceof Error ? error.message : 'APP_USER_UPDATE_FAILED'
    const status = authBodyErrorStatus(code)
    return context.json({ error: status === 500 ? 'APP_USER_UPDATE_FAILED' : code }, status)
  }
})
