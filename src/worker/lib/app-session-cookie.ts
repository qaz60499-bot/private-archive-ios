const IOS_NATIVE_PLATFORM = 'ios'

export function nativeAppCookieDomain(requestUrl: string, nativePlatform: string | undefined): string | null {
  if (nativePlatform?.trim().toLowerCase() !== IOS_NATIVE_PLATFORM) return null
  try {
    const url = new URL(requestUrl)
    if (url.protocol !== 'https:') return null
    const hostname = url.hostname.toLowerCase()
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || hostname.endsWith('.localhost')) return null
    return hostname
  } catch {
    return null
  }
}

export function appendCookieDomain(cookie: string, domain: string | null): string {
  return domain ? `${cookie}; Domain=${domain}` : cookie
}
