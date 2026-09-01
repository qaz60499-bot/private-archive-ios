import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { registerSW } from 'virtual:pwa-register'
import './styles/main.css'
import { wakeUploadScheduler } from './lib/offline/processor'
import { clearSensitivePrivateCaches } from './lib/private-cache'
import { isNativeApp } from './lib/native-platform'

const nativeApp = isNativeApp()
const appSurface = new URLSearchParams(window.location.search).get('app')
if (appSurface === 'personal-desktop' || nativeApp) {
  document.documentElement.dataset.appSurface = 'personal-desktop'
} else {
  delete document.documentElement.dataset.appSurface
}

// Older builds cached private previews in a runtime cache that did not carry
// account/permission context. Purge those generations on startup before the
// updated Service Worker takes control.
void clearSensitivePrivateCaches().catch(() => undefined)

if (!nativeApp) {
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
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void wakeUploadScheduler('visible') })
void wakeUploadScheduler('startup')

// Cloudflare's production Web build is intentionally upload-only. The regular
// production build remains the complete Windows desktop surface. Vite replaces
// import.meta.env.MODE at build time, allowing the unused branch to be removed.
const { default: App } = import.meta.env.MODE === 'web' ? await import('./WebApp') : await import('./App')
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
