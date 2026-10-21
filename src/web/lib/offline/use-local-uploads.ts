import { useCallback, useSyncExternalStore } from 'react'
import type { LocalUploadJob } from '../../types'
import { subscribeUploadScheduler } from './processor'
import { getLocalUploadPrincipalVersion, listLocalUploads, subscribeLocalUploadPrincipal } from './store'

const EVENT_REFRESH_DELAY_MS = 250
const SAFETY_REFRESH_INTERVAL_MS = 30_000
const EMPTY_UPLOADS: LocalUploadJob[] = []
const visibleJobFields: (keyof LocalUploadJob)[] = [
  'id', 'batchId', 'fileName', 'sizeBytes', 'mediaType', 'status', 'prepareStatus', 'controlState',
  'stage', 'progress', 'attempts', 'createdAt', 'updatedAt', 'nextAttemptAt', 'retryAfterMs',
  'error', 'deduplicated', 'nativeBackground',
]

let uploadSnapshot = EMPTY_UPLOADS
let snapshotPrincipalVersion = getLocalUploadPrincipalVersion()
const uploadListeners = new Set<() => void>()
let listening = false
let refreshTimer: number | undefined
let safetyTimer: number | undefined
let refreshInFlight: Promise<void> | null = null
let refreshAfterFlight = false
let immediateAfterFlight = false
let detachSources: (() => void) | null = null
let snapshotGeneration = 0

function snapshotsMatch(current: LocalUploadJob[], next: LocalUploadJob[]): boolean {
  if (current.length !== next.length) return false
  return current.every((job, index) => {
    const candidate = next[index]
    return visibleJobFields.every((field) => Object.is(job[field], candidate[field]))
  })
}

function publishUploads(next: LocalUploadJob[], principalVersion = getLocalUploadPrincipalVersion()): void {
  snapshotPrincipalVersion = principalVersion
  if (snapshotsMatch(uploadSnapshot, next)) return
  uploadSnapshot = next
  uploadListeners.forEach((listener) => listener())
}

function scheduleRefresh(immediate = false): void {
  if (!listening) return
  if (refreshInFlight) {
    refreshAfterFlight = true
    immediateAfterFlight ||= immediate
    return
  }
  if (refreshTimer !== undefined) {
    if (!immediate) return
    window.clearTimeout(refreshTimer)
  }
  refreshTimer = window.setTimeout(() => {
    refreshTimer = undefined
    void refreshUploadsSnapshot()
  }, immediate ? 0 : EVENT_REFRESH_DELAY_MS)
}

async function refreshUploadsSnapshot(): Promise<void> {
  if (refreshInFlight) {
    refreshAfterFlight = true
    return refreshInFlight
  }
  const generation = snapshotGeneration
  const principalVersion = getLocalUploadPrincipalVersion()
  const operation = (async () => {
    try {
      const next = await listLocalUploads()
      if (listening && generation === snapshotGeneration && principalVersion === getLocalUploadPrincipalVersion()) {
        publishUploads(next, principalVersion)
      }
    } catch {
      // Keep the last complete snapshot; a later event or safety refresh can recover.
    }
  })()
  refreshInFlight = operation
  try {
    await operation
  } finally {
    if (refreshInFlight === operation) refreshInFlight = null
    if (refreshAfterFlight) {
      const immediate = immediateAfterFlight
      refreshAfterFlight = false
      immediateAfterFlight = false
      scheduleRefresh(immediate)
    }
  }
}

function onVisible(): void {
  if (document.visibilityState === 'visible' && navigator.onLine) scheduleRefresh(true)
}

function startListening(): void {
  if (listening) return
  const principalVersion = getLocalUploadPrincipalVersion()
  if (snapshotPrincipalVersion !== principalVersion) {
    snapshotGeneration += 1
    uploadSnapshot = EMPTY_UPLOADS
    snapshotPrincipalVersion = principalVersion
  }
  listening = true

  const onStateChange = () => scheduleRefresh()
  const onPrincipalChange = () => {
    // Clear the previous account synchronously so its filenames cannot remain visible
    // while the next account's IndexedDB snapshot is loading.
    snapshotGeneration += 1
    publishUploads(EMPTY_UPLOADS, getLocalUploadPrincipalVersion())
    scheduleRefresh(true)
  }
  const onOnline = () => scheduleRefresh(true)
  const onVisibilityChange = () => { if (document.visibilityState === 'visible') onVisible() }

  const unsubscribeScheduler = subscribeUploadScheduler(onStateChange)
  const unsubscribePrincipal = subscribeLocalUploadPrincipal(onPrincipalChange)
  window.addEventListener('private-archive:native-upload-state', onStateChange)
  window.addEventListener('focus', onVisible)
  window.addEventListener('online', onOnline)
  document.addEventListener('visibilitychange', onVisibilityChange)
  safetyTimer = window.setInterval(onVisible, SAFETY_REFRESH_INTERVAL_MS)
  detachSources = () => {
    unsubscribeScheduler()
    unsubscribePrincipal()
    window.removeEventListener('private-archive:native-upload-state', onStateChange)
    window.removeEventListener('focus', onVisible)
    window.removeEventListener('online', onOnline)
    document.removeEventListener('visibilitychange', onVisibilityChange)
  }
  scheduleRefresh(true)
}

function stopListening(): void {
  if (!listening) return
  listening = false
  // Invalidate an in-flight read and avoid briefly showing one account's snapshot if
  // a queue component mounts again after an account switch.
  snapshotGeneration += 1
  uploadSnapshot = EMPTY_UPLOADS
  snapshotPrincipalVersion = getLocalUploadPrincipalVersion()
  refreshAfterFlight = false
  immediateAfterFlight = false
  detachSources?.()
  detachSources = null
  if (refreshTimer !== undefined) window.clearTimeout(refreshTimer)
  if (safetyTimer !== undefined) window.clearInterval(safetyTimer)
  refreshTimer = undefined
  safetyTimer = undefined
}

function subscribe(listener: () => void): () => void {
  uploadListeners.add(listener)
  if (uploadListeners.size === 1) startListening()
  return () => {
    uploadListeners.delete(listener)
    if (uploadListeners.size === 0) stopListening()
  }
}

function getSnapshot(): LocalUploadJob[] {
  return snapshotPrincipalVersion === getLocalUploadPrincipalVersion() ? uploadSnapshot : EMPTY_UPLOADS
}

async function refreshNow(): Promise<void> {
  if (!listening) return
  if (refreshTimer !== undefined) {
    window.clearTimeout(refreshTimer)
    refreshTimer = undefined
  }
  if (refreshInFlight) {
    refreshAfterFlight = true
    immediateAfterFlight = true
    await refreshInFlight
    return
  }
  await refreshUploadsSnapshot()
}

export function useLocalUploads(active = true): { jobs: LocalUploadJob[]; reload: () => Promise<void> } {
  const subscribeWhenActive = useCallback((listener: () => void) => active ? subscribe(listener) : () => undefined, [active])
  const jobs = useSyncExternalStore(subscribeWhenActive, getSnapshot, () => EMPTY_UPLOADS)
  const reload = useCallback(() => refreshNow(), [])
  return { jobs, reload }
}
