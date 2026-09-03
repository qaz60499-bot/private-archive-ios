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
  return runtime.createSession(tokenHash, userId, APP_SESSION_TTL_SECONDS, authVersion)
}

export async function resolveAppSessionRuntime(env: Env, rawToken: string): Promise<AppUserRow | null> {
  const runtime = authRuntime(env)
  if (!runtime) return resolveD1AppSession(env.DB, rawToken)

  const tokenHash = await hashAppSessionToken(rawToken)
  const session = await runtime.resolveSession(tokenHash)
  if (session) {
    const user = await getAppUserById(env.DB, session.userId)
    if (!user || user.status !== 'ACTIVE' || !session.authVersion || session.authVersion !== user.password_hash) {
      // Missing authVersion means the token came from the short-lived migration
      // generation. Fail it closed so password changes cannot leave a DO session alive.
      await runtime.deleteSession(tokenHash)
      return null
    }
    return user
  }

  if (await runtime.isLegacyRevoked(tokenHash)) return null
  return resolveD1AppSession(env.DB, rawToken)
}

export async function deleteAppSessionRuntime(env: Env, rawToken: string): Promise<void> {
  const runtime = authRuntime(env)
  if (!runtime) {
    await deleteD1AppSession(env.DB, rawToken)
    return
  }

  const tokenHash = await hashAppSessionToken(rawToken)
  await runtime.deleteSession(tokenHash)
  // Existing sessions created before the Durable Object migration remain in D1.
  // D1 may be temporarily write-exhausted, so revoke the legacy token in the DO
  // instead of making logout depend on a D1 DELETE succeeding.
  await runtime.revokeLegacySession(tokenHash, APP_SESSION_TTL_SECONDS)
}
