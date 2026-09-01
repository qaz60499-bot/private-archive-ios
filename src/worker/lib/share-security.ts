import type { Env } from '../env'
import { resolveShareSession, type ShareSessionPrincipal } from '../db/share-access-repository'
import { readCookieValue } from './cookies'

export const SHARE_SESSION_COOKIE = 'private_archive_share'

function isLocalHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase()
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized.endsWith('.localhost')
}

export function isShareHostAllowed(env: Env, requestUrl: string): boolean {
  const url = new URL(requestUrl)
  if (isLocalHost(url.hostname)) return true
  if (!env.SHARE_ORIGIN) return false
  try {
    return new URL(env.SHARE_ORIGIN).origin === url.origin
  } catch {
    return false
  }
}

export function readCookie(request: Request, name: string): string | null {
  return readCookieValue(request.headers.get('Cookie'), name)
}

export async function resolveShareRequestPrincipal(env: Env, request: Request): Promise<ShareSessionPrincipal | null> {
  if (!isShareHostAllowed(env, request.url)) return null
  const token = readCookie(request, SHARE_SESSION_COOKIE)
  if (!token) return null
  return resolveShareSession(env.DB, token)
}

export function shareSessionCookie(token: string, expiresAt: string, secure: boolean): string {
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - Date.now()) / 1000))
  return `${SHARE_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/api/share; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`
}

export function clearShareSessionCookie(secure: boolean): string {
  return `${SHARE_SESSION_COOKIE}=; Path=/api/share; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`
}
