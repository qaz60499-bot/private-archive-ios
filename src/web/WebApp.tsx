import { BrowserRouter } from 'react-router-dom'
import { ArchiveProvider } from './context/ArchiveContext'
import { setLocalUploadPrincipal } from './lib/offline/store'
import { WebUploadPage } from './pages/WebUploadPage'

export default function WebApp() {
  // Browser-local namespace only. Cloudflare Access + Worker hosted-upload scope remain
  // the authority for every server request.
  setLocalUploadPrincipal('hosted-access-owner', { adoptLegacy: true })
  return <BrowserRouter><ArchiveProvider><WebUploadPage /></ArchiveProvider></BrowserRouter>
}
