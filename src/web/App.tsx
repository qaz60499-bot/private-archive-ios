import { lazy, Suspense } from 'react'
import { BrowserRouter } from 'react-router-dom'
import { ArchiveProvider } from './context/ArchiveContext'
import { resolveAppSurface } from './lib/app-surface'
import { setLocalUploadPrincipal } from './lib/offline/store'
import { WebUploadPage } from './pages/WebUploadPage'

const DesktopApp = lazy(() => import('./DesktopApp'))
const SharePage = lazy(() => import('./pages/SharePage').then((module) => ({ default: module.SharePage })))

function LoadingSurface() {
  return <main className="surface-loading" aria-live="polite">正在打开 Private Archive…</main>
}

export default function App() {
  const surface = resolveAppSurface(window.location)
  if (surface === 'shared') return <Suspense fallback={<LoadingSurface />}><SharePage /></Suspense>
  if (surface === 'web-upload') {
    // Hosted Web is an Access-protected upload portal. It deliberately does not depend
    // on the desktop app-account session: the Worker maps a validated Access owner to
    // the D1 Owner only for the narrow hosted-upload API allowlist. The fixed principal
    // below is only a browser-local queue namespace; it grants no server capability.
    setLocalUploadPrincipal('hosted-access-owner', { adoptLegacy: true })
    return <BrowserRouter><ArchiveProvider><WebUploadPage /></ArchiveProvider></BrowserRouter>
  }
  return <Suspense fallback={<LoadingSurface />}><DesktopApp /></Suspense>
}
