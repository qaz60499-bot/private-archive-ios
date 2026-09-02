import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { summarizeImportErrors } from '../lib/import-error-summary'
import { importFiles, type ImportFilesResult } from '../lib/import-files'
import { pickIosBackgroundPhotos } from '../lib/native-background-upload'
import { getLocalUploadsByBatch } from '../lib/offline/store'
import { clearAccessReauthGuard, isAccessSignInRequired, requestAccessReauth } from '../lib/access-session'
import type { Asset, StorageBackend } from '../types'

// Translate the low-level ApiError codes (message === code, see ApiError) into calm
// Chinese copy. Without this the timeline surfaces raw tokens like ACCESS_SIGN_IN_REQUIRED.
function friendlyLoadError(caught: unknown, fallback: string): string {
  const code = caught instanceof Error ? caught.message : ''
  switch (code) {
    case 'ACCESS_SIGN_IN_REQUIRED': return '登录状态已过期。请刷新页面重新登录后再查看档案。'
    case 'NETWORK_OFFLINE': return '当前网络不可用。恢复网络后会自动重试。'
    case 'REQUEST_TIMEOUT': return '连接档案服务超时。请检查网络后重试。'
    case 'ACCESS_OR_NETWORK_FAILED': return '暂时无法连接档案服务。请稍后重试。'
    default: return code || fallback
  }
}

interface LoadOptions {
  q?: string
  mediaType?: string
  favorite?: boolean
  archived?: boolean
  category?: string
  fileCategory?: string
  extension?: string
  mimeType?: string
  tag?: string
  status?: string
  albumId?: string
  logicalPath?: string
  takenAfter?: string
  takenBefore?: string
  minSizeBytes?: number
  maxSizeBytes?: number
}

// Immediate, app-level feedback for "add / 添加". It is set the instant files are
// selected — before the durable enqueue loop finishes — so the UI never looks idle
// after the picker closes, and it keeps reporting queued/total as each item lands.
export interface ImportStatus {
  batchId: string
  active: boolean
  total: number
  queued: number
  processed: number
  phase: 'registering' | 'complete'
  error: string | null
}

interface ArchiveContextValue {
  assets: Asset[]
  loading: boolean
  loadingMore: boolean
  nextCursor: string | null
  error: string | null
  viewerAsset: Asset | null
  uploadOpen: boolean
  online: boolean
  importStatus: ImportStatus | null
  runImport: (files: FileList | File[], options?: { mobile?: boolean; storageBackend?: StorageBackend }) => Promise<ImportFilesResult | undefined>
  runNativePhotoImport: () => Promise<{ batchId: string; count: number } | undefined>
  dismissImportStatus: () => void
  load: (options?: LoadOptions) => Promise<void>
  loadMore: () => Promise<void>
  refresh: () => Promise<void>
  toggleFavorite: (asset: Asset) => Promise<void>
  setAssetCategory: (asset: Asset, categoryOverride: string | null) => Promise<void>
  trashAsset: (asset: Asset) => Promise<void>
  openViewer: (asset: Asset) => void
  closeViewer: () => void
  setUploadOpen: (open: boolean) => void
}

const ArchiveContext = createContext<ArchiveContextValue | null>(null)

function buildAssetParams(options: LoadOptions, cursor?: string | null): URLSearchParams {
  const params = new URLSearchParams({ limit: '36' })
  if (options.q) params.set('q', options.q)
  if (options.mediaType) params.set('mediaType', options.mediaType)
  if (options.favorite !== undefined) params.set('favorite', String(options.favorite))
  if (options.archived !== undefined) params.set('archived', String(options.archived))
  if (options.category) params.set('category', options.category)
  if (options.fileCategory) params.set('fileCategory', options.fileCategory)
  if (options.extension) params.set('extension', options.extension)
  if (options.mimeType) params.set('mimeType', options.mimeType)
  if (options.tag) params.set('tag', options.tag)
  if (options.status) params.set('status', options.status)
  if (options.albumId) params.set('albumId', options.albumId)
  if (options.takenAfter) params.set('takenAfter', options.takenAfter)
  if (options.logicalPath) params.set('logicalPath', options.logicalPath)
  if (options.takenBefore) params.set('takenBefore', options.takenBefore)
  if (options.minSizeBytes !== undefined) params.set('minSizeBytes', String(options.minSizeBytes))
  if (options.maxSizeBytes !== undefined) params.set('maxSizeBytes', String(options.maxSizeBytes))
  if (cursor) params.set('cursor', cursor)
  return params
}

export function ArchiveProvider({ children }: { children: ReactNode }) {
  const [assets, setAssets] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [viewerAsset, setViewerAsset] = useState<Asset | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  const [online, setOnline] = useState(navigator.onLine)
  const [importStatus, setImportStatus] = useState<ImportStatus | null>(null)
  const currentImportBatchRef = useRef<string | null>(null)
  const dismissedImportBatchesRef = useRef<Set<string>>(new Set())
  const nativePickerMissingJobsRef = useRef<Map<string, Set<string>>>(new Map())
  const [lastOptions, setLastOptions] = useState<LoadOptions>({})
  const [hasLoadedMore, setHasLoadedMore] = useState(false)
  const prefetchedNextRef = useRef<{ cursor: string; result: Awaited<ReturnType<typeof api.listAssets>> } | null>(null)
  const requestEpochRef = useRef(0)
  const loadMoreRequestRef = useRef(0)
  const syncInFlightRef = useRef<Promise<void> | null>(null)

  const load = useCallback(async (options: LoadOptions = {}) => {
    const epoch = ++requestEpochRef.current
    loadMoreRequestRef.current += 1
    setLoading(true)
    setLoadingMore(false)
    setError(null)
    setLastOptions(options)
    prefetchedNextRef.current = null
    try {
      const result = await api.listAssets(buildAssetParams(options))
      if (requestEpochRef.current !== epoch) return
      clearAccessReauthGuard()
      setAssets(result.items)
      setNextCursor(result.nextCursor)
      setHasLoadedMore(false)
    } catch (caught) {
      if (requestEpochRef.current !== epoch) return
      // A stale Cloudflare Access cookie is the dominant first-open failure: recover by
      // re-running the Access login instead of stranding the user on a dead error card.
      if (isAccessSignInRequired(caught) && requestAccessReauth()) return
      setError(friendlyLoadError(caught, '加载档案失败'))
    } finally {
      if (requestEpochRef.current === epoch) setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    const epoch = requestEpochRef.current
    const requestId = ++loadMoreRequestRef.current
    const cursor = nextCursor
    setLoadingMore(true)
    try {
      const prefetched = prefetchedNextRef.current?.cursor === cursor ? prefetchedNextRef.current.result : null
      prefetchedNextRef.current = null
      const result = prefetched ?? await api.listAssets(buildAssetParams(lastOptions, cursor))
      if (requestEpochRef.current !== epoch || loadMoreRequestRef.current !== requestId) return
      setAssets((current) => {
        const existing = new Set(current.map((item) => item.id))
        return [...current, ...result.items.filter((item) => !existing.has(item.id))]
      })
      setNextCursor(result.nextCursor)
      setHasLoadedMore(true)
    } catch (caught) {
      if (requestEpochRef.current === epoch && loadMoreRequestRef.current === requestId) setError(friendlyLoadError(caught, '加载更多档案失败'))
    } finally {
      if (loadMoreRequestRef.current === requestId) setLoadingMore(false)
    }
  }, [lastOptions, loadingMore, nextCursor])

  const refresh = useCallback(() => load(lastOptions), [lastOptions, load])

  useEffect(() => {
    if (!nextCursor || loading || document.visibilityState !== 'visible' || !navigator.onLine) return
    const cursor = nextCursor
    const epoch = requestEpochRef.current
    const timer = window.setTimeout(() => {
      void api.listAssets(buildAssetParams(lastOptions, cursor)).then((result) => {
        if (requestEpochRef.current === epoch) prefetchedNextRef.current = { cursor, result }
      }).catch(() => undefined)
    }, 1_200)
    return () => window.clearTimeout(timer)
  }, [lastOptions, loading, nextCursor])

  const syncLatest = useCallback(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    if (syncInFlightRef.current) return syncInFlightRef.current
    const epoch = requestEpochRef.current
    const promise = (async () => {
      try {
        const result = await api.listAssets(buildAssetParams(lastOptions))
        if (requestEpochRef.current !== epoch) return
        setAssets((current) => {
          if (!hasLoadedMore) return result.items
          const freshIds = new Set(result.items.map((item) => item.id))
          return [...result.items, ...current.filter((item) => !freshIds.has(item.id))]
        })
        if (!hasLoadedMore) setNextCursor(result.nextCursor)
        setViewerAsset((current) => {
          if (!current) return current
          return result.items.find((item) => item.id === current.id) ?? current
        })
      } catch {
        // Background synchronization is best-effort. Foreground loads still surface errors.
      }
    })()
    syncInFlightRef.current = promise
    try {
      await promise
    } finally {
      if (syncInFlightRef.current === promise) syncInFlightRef.current = null
    }
  }, [hasLoadedMore, lastOptions])

  const toggleFavorite = useCallback(async (asset: Asset) => {
    const favorite = !asset.favorite
    setAssets((current) => current.map((item) => item.id === asset.id ? { ...item, favorite } : item))
    setViewerAsset((current) => current?.id === asset.id ? { ...current, favorite } : current)
    try {
      const updated = (await api.patchAsset(asset.id, { favorite })).asset
      setAssets((current) => current.map((item) => item.id === updated.id ? updated : item))
      setViewerAsset((current) => current?.id === updated.id ? updated : current)
    } catch {
      setAssets((current) => current.map((item) => item.id === asset.id ? asset : item))
      setViewerAsset((current) => current?.id === asset.id ? asset : current)
    }
  }, [])

  const setAssetCategory = useCallback(async (asset: Asset, categoryOverride: string | null) => {
    const previous = asset
    try {
      const updated = (await api.patchAsset(asset.id, { categoryOverride })).asset
      setAssets((current) => current.map((item) => item.id === updated.id ? updated : item))
      setViewerAsset((current) => current?.id === updated.id ? updated : current)
    } catch (caught) {
      setAssets((current) => current.map((item) => item.id === previous.id ? previous : item))
      setViewerAsset((current) => current?.id === previous.id ? previous : current)
      setError(caught instanceof Error ? caught.message : '调整模块失败')
      throw caught
    }
  }, [])

  const trashAsset = useCallback(async (asset: Asset) => {
    try {
      await api.deleteAsset(asset.id)
      setAssets((current) => current.filter((item) => item.id !== asset.id))
      setViewerAsset((current) => current?.id === asset.id ? null : current)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '移入回收站失败')
    }
  }, [])

  const dismissImportStatus = useCallback(() => {
    setImportStatus((current) => {
      if (current) {
        dismissedImportBatchesRef.current.add(current.batchId)
        if (currentImportBatchRef.current === current.batchId) currentImportBatchRef.current = null
      }
      return null
    })
  }, [])

  const runNativePhotoImport = useCallback(async () => {
    const batchId = crypto.randomUUID()
    currentImportBatchRef.current = batchId
    dismissedImportBatchesRef.current.delete(batchId)
    nativePickerMissingJobsRef.current.delete(batchId)
    setUploadOpen(false)
    setImportStatus({ batchId, active: true, total: 0, queued: 0, processed: 0, phase: 'registering', error: null })
    try {
      const result = await pickIosBackgroundPhotos(batchId)
      if (!result.count) {
        if (currentImportBatchRef.current === batchId) currentImportBatchRef.current = null
        setImportStatus((current) => current?.batchId === batchId ? null : current)
        return result
      }
      const jobs = await getLocalUploadsByBatch(batchId)
      const processed = Math.min(result.count, jobs.length)
      const complete = processed >= result.count
      setImportStatus((current) => current?.batchId === batchId ? {
        batchId,
        active: !complete,
        total: result.count,
        queued: jobs.length,
        processed,
        phase: complete ? 'complete' : 'registering',
        error: current.error,
      } : current)
      return result
    } catch (caught) {
      setImportStatus((current) => current?.batchId === batchId ? {
        batchId, active: false, total: current.total, queued: current.queued, processed: current.processed,
        phase: 'complete', error: caught instanceof Error ? caught.message : '无法打开系统照片选择器。',
      } : current)
      return undefined
    }
  }, [])

  const runImport = useCallback(async (files: FileList | File[], options?: { mobile?: boolean; storageBackend?: StorageBackend }) => {
    const selected = Array.from(files)
    if (!selected.length) return undefined
    const batchId = crypto.randomUUID()
    // Set the status synchronously so feedback is visible the moment the picker closes.
    // "queued" means durable local recovery state only; Telegram confirmation is
    // tracked separately by ImportToast from the jobs in this batch.
    currentImportBatchRef.current = batchId
    dismissedImportBatchesRef.current.delete(batchId)
    setImportStatus({ batchId, active: true, total: selected.length, queued: 0, processed: 0, phase: 'registering', error: null })
    try {
      const result = await importFiles(selected, navigator.onLine, {
        mobile: options?.mobile,
        storageBackend: options?.storageBackend,
        batchId,
        onProgress: (progress) => {
          if (currentImportBatchRef.current !== progress.batchId || dismissedImportBatchesRef.current.has(progress.batchId)) return
          setImportStatus({
            batchId: progress.batchId,
            active: progress.phase !== 'complete',
            total: progress.total,
            queued: progress.queued,
            processed: progress.processed,
            phase: progress.phase,
            error: null,
          })
        },
      })
      if (currentImportBatchRef.current === result.batchId && !dismissedImportBatchesRef.current.has(result.batchId)) {
        setImportStatus({
          batchId: result.batchId,
          active: false, total: result.total, queued: result.queued, processed: result.processed,
          phase: 'complete', error: summarizeImportErrors(result.errors),
        })
      }
      return result
    } catch (caught) {
      if (currentImportBatchRef.current === batchId && !dismissedImportBatchesRef.current.has(batchId)) {
        setImportStatus({
          batchId, active: false, total: selected.length, queued: 0, processed: 0,
          phase: 'complete', error: caught instanceof Error ? caught.message : '无法加入上传队列',
        })
      }
      throw caught
    }
  }, [])

  useEffect(() => {
    const refreshNativeBatch = async (batchId: string) => {
      if (currentImportBatchRef.current !== batchId || dismissedImportBatchesRef.current.has(batchId)) return
      const jobs = await getLocalUploadsByBatch(batchId)
      const missing = nativePickerMissingJobsRef.current.get(batchId)
      if (missing) {
        for (const job of jobs) missing.delete(job.id)
        if (!missing.size) nativePickerMissingJobsRef.current.delete(batchId)
      }
      setImportStatus((current) => {
        if (!current || current.batchId !== batchId) return current
        const missingCount = nativePickerMissingJobsRef.current.get(batchId)?.size ?? 0
        const processed = current.total > 0 ? Math.min(current.total, jobs.length + missingCount) : jobs.length + missingCount
        const complete = current.total > 0 && processed >= current.total
        return {
          ...current,
          active: !complete,
          queued: jobs.length,
          processed,
          phase: complete ? 'complete' : 'registering',
        }
      })
    }
    const onNativeState = (event: Event) => {
      const detail = (event as CustomEvent<{ batchId?: string }>).detail
      if (detail?.batchId) void refreshNativeBatch(detail.batchId)
    }
    const onNativePickerError = (event: Event) => {
      const detail = (event as CustomEvent<{ batchId?: string; jobId?: string; message?: string }>).detail
      if (!detail?.batchId || currentImportBatchRef.current !== detail.batchId) return
      void (async () => {
        if (detail.jobId) {
          const jobs = await getLocalUploadsByBatch(detail.batchId as string)
          if (!jobs.some((job) => job.id === detail.jobId)) {
            const missing = nativePickerMissingJobsRef.current.get(detail.batchId as string) ?? new Set<string>()
            missing.add(detail.jobId)
            nativePickerMissingJobsRef.current.set(detail.batchId as string, missing)
          }
        }
        setImportStatus((current) => {
          if (!current || current.batchId !== detail.batchId) return current
          return { ...current, error: detail.message ?? '部分照片无法读取。' }
        })
        await refreshNativeBatch(detail.batchId as string)
      })()
    }
    window.addEventListener('private-archive:native-upload-state', onNativeState)
    window.addEventListener('private-archive:native-picker-error', onNativePickerError)
    return () => {
      window.removeEventListener('private-archive:native-upload-state', onNativeState)
      window.removeEventListener('private-archive:native-picker-error', onNativePickerError)
    }
  }, [])

  useEffect(() => {
    const onOnline = () => {
      setOnline(true)
      void syncLatest()
    }
    const onOffline = () => setOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [syncLatest])

  useEffect(() => {
    const syncIfVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine && !loading && !loadingMore) void syncLatest()
    }
    const interval = window.setInterval(syncIfVisible, 20_000)
    window.addEventListener('focus', syncIfVisible)
    document.addEventListener('visibilitychange', syncIfVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', syncIfVisible)
      document.removeEventListener('visibilitychange', syncIfVisible)
    }
  }, [loading, loadingMore, syncLatest])

  const value = useMemo<ArchiveContextValue>(() => ({
    assets, loading, loadingMore, nextCursor, error, viewerAsset, uploadOpen, online, importStatus, runImport, runNativePhotoImport, dismissImportStatus,
    load, loadMore, refresh, toggleFavorite, setAssetCategory, trashAsset,
    openViewer: setViewerAsset, closeViewer: () => setViewerAsset(null), setUploadOpen,
  }), [assets, loading, loadingMore, nextCursor, error, viewerAsset, uploadOpen, online, importStatus, runImport, runNativePhotoImport, dismissImportStatus, load, loadMore, refresh, toggleFavorite, setAssetCategory, trashAsset])

  return <ArchiveContext.Provider value={value}>{children}</ArchiveContext.Provider>
}

// The hook intentionally lives beside its provider so the context contract stays private.
// eslint-disable-next-line react-refresh/only-export-components
export function useArchive(): ArchiveContextValue {
  const context = useContext(ArchiveContext)
  if (!context) throw new Error('useArchive must be used inside ArchiveProvider')
  return context
}
