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
