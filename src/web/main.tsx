import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/main.css'
import { wakeUploadScheduler } from './lib/offline/processor'
import { clearSensitivePrivateCaches } from './lib/private-cache'
import { isNativeApp, nativePlatform } from './lib/native-platform'
import { initializeIosBackgroundUploadSync, syncIosBackgroundUploads } from './lib/native-background-upload'

const nativeApp = isNativeApp()
const appSurface = new URLSearchParams(window.location.search).get('app')
if (appSurface === 'personal-desktop' || nativeApp) {
  document.documentElement.dataset.appSurface = 'personal-desktop'
} else {
  delete document.documentElement.dataset.appSurface
}
if (nativeApp) document.documentElement.dataset.nativePlatform = nativePlatform() ?? 'native'
else delete document.documentElement.dataset.nativePlatform

// Older builds cached private previews in a runtime cache that did not carry
// account/permission context. Purge those generations on startup before the
// updated Service Worker takes control.
void clearSensitivePrivateCaches().catch(() => undefined)

const localDesktopSurface = !nativeApp && ['127.0.0.1', 'localhost', '::1'].includes(window.location.hostname)

if (localDesktopSurface) {
  // The Windows desktop app serves an immutable bundle from the installed EXE.
  // A PWA Service Worker on the loopback origin can outlive an upgrade and keep
  // rendering stale authentication state (for example, showing Owner bootstrap
  // even when the live API reports initialized=true). Remove legacy registrations
  // and UI caches on startup; cookies and saved credentials are unaffected.
  if ('serviceWorker' in navigator) {
    void navigator.serviceWorker.getRegistrations().then(async (registrations) => {
      await Promise.all(registrations.map((registration) => registration.unregister()))
      if ('caches' in globalThis) {
        const keys = await caches.keys()
        await Promise.all(keys.map((key) => caches.delete(key)))
      }
      if (navigator.serviceWorker.controller && sessionStorage.getItem('private-archive:desktop-sw-reset') !== '1') {
        sessionStorage.setItem('private-archive:desktop-sw-reset', '1')
        window.location.reload()
      }
    }).catch(() => undefined)
  }
} else if (!nativeApp) {
  registerSW({
    immediate: true,
    onRegisteredSW: (_swUrl, registration) => {
      if (!registration) return
      void registration.update()
      // Keep long-lived installed PWAs current without asking the user to clear caches.
      window.setInterval(() => void registration.update(), 10 * 60_000)
    },
  })
}
window.addEventListener('online', () => void wakeUploadScheduler('online'))
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return
  void syncIosBackgroundUploads()
  void wakeUploadScheduler('visible')
})
void initializeIosBackgroundUploadSync()
void wakeUploadScheduler('startup')

// Cloudflare's production Web build is intentionally upload-only. The regular
// production build remains the complete Windows desktop surface. Vite replaces
// import.meta.env.MODE at build time, allowing the unused branch to be removed.
const { default: App } = import.meta.env.MODE === 'web' ? await import('./WebApp') : await import('./App')
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
