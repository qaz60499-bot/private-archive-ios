const NATIVE_API_ORIGIN = 'https://api.photo.joye.cc.cd'

type CapacitorRuntime = {
  isNativePlatform?: () => boolean
  getPlatform?: () => string
}

function capacitorRuntime(): CapacitorRuntime | undefined {
  return (globalThis as typeof globalThis & { Capacitor?: CapacitorRuntime }).Capacitor
}

export function isNativeApp(): boolean {
  const runtime = capacitorRuntime()
  if (runtime?.isNativePlatform?.()) return true
  return typeof location !== 'undefined' && location.protocol === 'capacitor:'
}

export function nativePlatform(): string | null {
  if (!isNativeApp()) return null
  return capacitorRuntime()?.getPlatform?.() ?? (typeof location !== 'undefined' && location.protocol === 'capacitor:' ? 'ios' : 'native')
}

export function apiRequestUrl(path: string): string {
  if (!isNativeApp() || !path.startsWith('/')) return path
  return `${NATIVE_API_ORIGIN}${path}`
}

export function nativeApiResourceUrl(path: string | null): string | null {
  if (!path || !isNativeApp() || !path.startsWith('/api/')) return path
  return `${NATIVE_API_ORIGIN}${path}`
}
