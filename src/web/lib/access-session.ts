import { ApiError } from './api'

export function isAccessSignInRequired(error: unknown): boolean {
  if (error instanceof ApiError) return error.code === 'ACCESS_SIGN_IN_REQUIRED'
  if (error instanceof Error) return error.message === 'ACCESS_SIGN_IN_REQUIRED'
  return error === 'ACCESS_SIGN_IN_REQUIRED'
}

export function reauthenticateAccess(returnTo = `${window.location.pathname}${window.location.search}${window.location.hash}`): void {
  const target = new URL('/access-check', window.location.origin)
  target.searchParams.set('return', returnTo || '/')
  target.searchParams.set('t', String(Date.now()))
  window.location.assign(target.toString())
}

// Cloudflare Access sessions expire (default 1-day TTL); a stale cookie turns every
// /api fetch into an opaqueredirect. We must re-run the Access login by doing a real
// top-level navigation — but guard against a redirect loop when the API keeps failing
// even after a fresh login (e.g. misconfiguration), so the user sees a real error
// instead of an endless bounce.
const REAUTH_GUARD_KEY = 'archive:access-reauth-at'
const REAUTH_MIN_INTERVAL_MS = 15_000

export function requestAccessReauth(returnTo?: string): boolean {
  try {
    const last = Number(sessionStorage.getItem(REAUTH_GUARD_KEY) ?? '0')
    if (Number.isFinite(last) && Date.now() - last < REAUTH_MIN_INTERVAL_MS) return false
    sessionStorage.setItem(REAUTH_GUARD_KEY, String(Date.now()))
  } catch {
    // sessionStorage may be unavailable (private mode); still attempt one redirect.
  }
  reauthenticateAccess(returnTo)
  return true
}

export function clearAccessReauthGuard(): void {
  try {
    sessionStorage.removeItem(REAUTH_GUARD_KEY)
  } catch {
    // Nothing persisted to clear.
  }
}
