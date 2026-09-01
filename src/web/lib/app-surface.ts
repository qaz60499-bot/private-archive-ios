export type AppSurface = 'shared' | 'desktop' | 'web-upload'

interface SurfaceLocation {
  hostname: string
  search: string
}

export function resolveAppSurface(location: SurfaceLocation): AppSurface {
  const hostname = location.hostname.toLowerCase()
  const params = new URLSearchParams(location.search)
  if (hostname.startsWith('share.') || params.get('app') === 'shared') return 'shared'
  if (hostname === '127.0.0.1' || hostname === 'localhost') return 'desktop'
  return 'web-upload'
}
