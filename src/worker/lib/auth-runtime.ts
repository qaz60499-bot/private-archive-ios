import type { Env } from '../env'
import {
  clearLoginFailures as clearD1LoginFailures,
  createAppSession as createD1AppSession,
  deleteAppSession as deleteD1AppSession,
  getAppUserById,
  pruneAppAuth as pruneD1AppAuth,
  recentAccountLoginFailures as recentD1AccountLoginFailures,
  recentLoginFailures as recentD1LoginFailures,
  recordLoginAttempt as recordD1LoginAttempt,
  resolveAppSession as resolveD1AppSession,
  type AppUserRow,
} from '../db/app-users-repository'
import { APP_SESSION_TTL_SECONDS, hashAppSessionToken } from './app-auth'

const AUTH_RUNTIME_NAME = 'app-login-password-verifier'

function authRuntime(env: Env) {
  return env.PASSWORD_VERIFIER?.getByName(AUTH_RUNTIME_NAME) ?? null
}

export async function pruneAuthRuntime(env: Env): Promise<void> {
  const runtime = authRuntime(env)
  if (runtime) {
    await runtime.prune()
    return
  }
  await pruneD1AppAuth(env.DB)
}

export async function recentLoginFailuresRuntime(env: Env, ip: string, windowMinutes = 15): Promise<number> {
  const runtime = authRuntime(env)
  return runtime ? runtime.recentFailures(ip, windowMinutes) : recentD1LoginFailures(env.DB, ip, windowMinutes)
}

export async function recentAccountLoginFailuresRuntime(env: Env, username: string, windowMinutes = 15): Promise<number> {
  const runtime = authRuntime(env)
  return runtime
    ? runtime.recentFailures(`account:${username.trim().toLowerCase()}`, windowMinutes)
    : recentD1AccountLoginFailures(env.DB, username, windowMinutes)
}

export async function recordLoginAttemptRuntime(env: Env, ip: string, username: string, success: boolean): Promise<void> {
  const runtime = authRuntime(env)
  if (runtime) {
    await runtime.recordAttempt(ip, username, success)
    return
  }
  await recordD1LoginAttempt(env.DB, ip, username, success)
}

export async function clearLoginFailuresRuntime(env: Env, ip: string, username: string): Promise<void> {
  const runtime = authRuntime(env)
  if (runtime) {
    await runtime.clearFailures(ip, username)
    return
  }
  await clearD1LoginFailures(env.DB, ip, username)
}

export async function createAppSessionRuntime(env: Env, userId: string, rawToken: string, authVersion?: string): Promise<string> {
  const runtime = authRuntime(env)
  if (!runtime || !authVersion) return createD1AppSession(env.DB, userId, rawToken)

  const tokenHash = await hashAppSessionToken(rawToken)
  let runtimeExpiry: string
  try {
    runtimeExpiry = await runtime.createSession(tokenHash, userId, APP_SESSION_TTL_SECONDS, authVersion)
  } catch {
    // If the Durable Object is temporarily unavailable, a login should still be
    // able to establish the legacy D1-backed session instead of accepting the
    // password and then returning a broken unauthenticated client.
    return createD1AppSession(env.DB, userId, rawToken)
  }

  try {
    // Keep one low-write fallback copy for newly issued sessions. Session reads
    // still prefer the Durable Object, while the existing revocation/auth-version
    // rules prevent this backup from reviving a logged-out or password-rotated
    // token. This makes a still-valid desktop/iOS cookie survive a DO namespace or
    // storage interruption without putting per-request writes back on D1.
    await createD1AppSession(env.DB, userId, rawToken)
  } catch (error) {
    console.warn('D1 auth session backup unavailable', { userId, error: error instanceof Error ? error.message : String(error) })
  }
  return runtimeExpiry
}

export async function resolveAppSessionRuntime(env: Env, rawToken: string): Promise<AppUserRow | null> {
  const runtime = authRuntime(env)
  if (!runtime) return resolveD1AppSession(env.DB, rawToken)

  const tokenHash = await hashAppSessionToken(rawToken)
  let session: { userId: string; authVersion?: string } | null
  try {
    session = await runtime.resolveSession(tokenHash)
  } catch (error) {
    // A Durable Object outage must not turn an otherwise harmless stale desktop/iOS
    // cookie into HTTP 500. Newly issued sessions are mirrored into D1 specifically
    // so reads can survive a runtime outage.
    console.warn('Durable auth session lookup unavailable; falling back to D1', { error: error instanceof Error ? error.message : String(error) })
    return resolveD1AppSession(env.DB, rawToken)
  }
  if (session) {
    const user = await getAppUserById(env.DB, session.userId)
    if (!user || user.status !== 'ACTIVE' || !session.authVersion || session.authVersion !== user.password_hash) {
      // Missing authVersion means the token came from the short-lived migration
      // generation. Fail it closed so password changes cannot leave a DO session alive.
      try { await runtime.deleteSession(tokenHash) } catch { /* invalid session still fails closed */ }
      return null
    }
    return user
  }

  try {
    if (await runtime.isLegacyRevoked(tokenHash)) return null
  } catch (error) {
    console.warn('Durable auth revocation lookup unavailable; falling back to D1', { error: error instanceof Error ? error.message : String(error) })
    return resolveD1AppSession(env.DB, rawToken)
  }
  return resolveD1AppSession(env.DB, rawToken)
}

export async function deleteAppSessionRuntime(env: Env, rawToken: string): Promise<void> {
  const runtime = authRuntime(env)
  if (!runtime) {
    await deleteD1AppSession(env.DB, rawToken)
    return
  }

  const tokenHash = await hashAppSessionToken(rawToken)
  try {
    await runtime.deleteSession(tokenHash)
  } catch (error) {
    console.warn('Durable auth session delete unavailable', { error: error instanceof Error ? error.message : String(error) })
  }

  let runtimeRevoked = false
  try {
    // Revoke before relying on the D1 cleanup so a mirrored token cannot be revived
    // by the normal legacy fallback if the D1 delete is temporarily unavailable.
    await runtime.revokeLegacySession(tokenHash, APP_SESSION_TTL_SECONDS)
    runtimeRevoked = true
  } catch (error) {
    console.warn('Durable auth session revocation unavailable', { error: error instanceof Error ? error.message : String(error) })
  }

  let d1Deleted = false
  try {
    await deleteD1AppSession(env.DB, rawToken)
    d1Deleted = true
  } catch (error) {
    console.warn('D1 auth session delete unavailable', { error: error instanceof Error ? error.message : String(error) })
  }

  if (!runtimeRevoked && !d1Deleted) throw new Error('APP_SESSION_REVOKE_UNAVAILABLE')
}
