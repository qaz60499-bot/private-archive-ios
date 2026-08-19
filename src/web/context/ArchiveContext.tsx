import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import type { Asset } from '../types'

interface LoadOptions {
  q?: string
  mediaType?: string
  favorite?: boolean
  category?: string
  status?: string
  albumId?: string
  takenAfter?: string
  takenBefore?: string
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
  if (options.category) params.set('category', options.category)
  if (options.status) params.set('status', options.status)
  if (options.albumId) params.set('albumId', options.albumId)
  if (options.takenAfter) params.set('takenAfter', options.takenAfter)
  if (options.takenBefore) params.set('takenBefore', options.takenBefore)
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
  const [lastOptions, setLastOptions] = useState<LoadOptions>({})
  const [hasLoadedMore, setHasLoadedMore] = useState(false)

  const load = useCallback(async (options: LoadOptions = {}) => {
    setLoading(true)
    setError(null)
    setLastOptions(options)
    try {
      const result = await api.listAssets(buildAssetParams(options))
      setAssets(result.items)
      setNextCursor(result.nextCursor)
      setHasLoadedMore(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载档案失败')
    } finally {
      setLoading(false)
    }
  }, [])

  const loadMore = useCallback(async () => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    try {
      const result = await api.listAssets(buildAssetParams(lastOptions, nextCursor))
      setAssets((current) => {
        const existing = new Set(current.map((item) => item.id))
        return [...current, ...result.items.filter((item) => !existing.has(item.id))]
      })
      setNextCursor(result.nextCursor)
      setHasLoadedMore(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载更多档案失败')
    } finally {
      setLoadingMore(false)
    }
  }, [lastOptions, loadingMore, nextCursor])

  const refresh = useCallback(() => load(lastOptions), [lastOptions, load])

  const syncLatest = useCallback(async () => {
    if (!navigator.onLine || document.visibilityState !== 'visible') return
    try {
      const result = await api.listAssets(buildAssetParams(lastOptions))
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
      if (document.visibilityState === 'visible' && navigator.onLine) void syncLatest()
    }
    const interval = window.setInterval(syncIfVisible, 8000)
    window.addEventListener('focus', syncIfVisible)
    document.addEventListener('visibilitychange', syncIfVisible)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', syncIfVisible)
      document.removeEventListener('visibilitychange', syncIfVisible)
    }
  }, [syncLatest])

  const value = useMemo<ArchiveContextValue>(() => ({
    assets, loading, loadingMore, nextCursor, error, viewerAsset, uploadOpen, online, load, loadMore, refresh, toggleFavorite, setAssetCategory, trashAsset,
    openViewer: setViewerAsset, closeViewer: () => setViewerAsset(null), setUploadOpen,
  }), [assets, loading, loadingMore, nextCursor, error, viewerAsset, uploadOpen, online, load, loadMore, refresh, toggleFavorite, setAssetCategory, trashAsset])

  return <ArchiveContext.Provider value={value}>{children}</ArchiveContext.Provider>
}

// The hook intentionally lives beside its provider so the context contract stays private.
// eslint-disable-next-line react-refresh/only-export-components
export function useArchive(): ArchiveContextValue {
  const context = useContext(ArchiveContext)
  if (!context) throw new Error('useArchive must be used inside ArchiveProvider')
  return context
}
