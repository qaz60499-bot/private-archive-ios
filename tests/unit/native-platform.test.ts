import { afterEach, describe, expect, it } from 'vitest'
import { apiRequestUrl, isNativeApp, nativeApiResourceUrl, nativePlatform } from '../../src/web/lib/native-platform'

const originalCapacitor = (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor

afterEach(() => {
  if (originalCapacitor === undefined) delete (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor
  else (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = originalCapacitor
})

describe('native platform routing', () => {
  it('keeps browser requests relative', () => {
    delete (globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor
    expect(isNativeApp()).toBe(false)
    expect(apiRequestUrl('/api/health')).toBe('/api/health')
    expect(nativeApiResourceUrl('/api/assets/1/preview')).toBe('/api/assets/1/preview')
  })

  it('routes iOS API requests to the dedicated API hostname', () => {
    ;(globalThis as typeof globalThis & { Capacitor?: unknown }).Capacitor = {
      isNativePlatform: () => true,
      getPlatform: () => 'ios',
    }
    expect(isNativeApp()).toBe(true)
    expect(nativePlatform()).toBe('ios')
    expect(apiRequestUrl('/api/health')).toBe('https://api.photo.joye.cc.cd/api/health')
    expect(nativeApiResourceUrl('/api/assets/1/preview')).toBe('https://api.photo.joye.cc.cd/api/assets/1/preview')
    expect(nativeApiResourceUrl('/__telegram_storage/asset/1/file')).toBe('/__telegram_storage/asset/1/file')
  })
})
