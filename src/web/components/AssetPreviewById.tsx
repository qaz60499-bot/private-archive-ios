import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { usePrivateMediaUrl } from '../lib/native-media'

type ResolvedAssetPreview = { assetId: string; src: string | null; failed: boolean }
const resolvedPreviewCache = new Map<string, ResolvedAssetPreview>()
const resolvedPreviewInflight = new Map<string, Promise<ResolvedAssetPreview>>()

async function resolveAssetPreview(assetId: string): Promise<ResolvedAssetPreview> {
  const cached = resolvedPreviewCache.get(assetId)
  if (cached) return cached
  const inflight = resolvedPreviewInflight.get(assetId)
  if (inflight) return inflight
  const request = api.getAsset(assetId).then(({ asset }) => ({
    assetId,
    src: asset.previewSupported ? asset.previewUrl : null,
    failed: !asset.previewSupported,
  }))
  resolvedPreviewInflight.set(assetId, request)
  try {
    const result = await request
    resolvedPreviewCache.set(assetId, result)
    return result
  } finally {
    resolvedPreviewInflight.delete(assetId)
  }
}

export function AssetPreviewById({ assetId, alt = '', loading = 'lazy', fallback = null }: {
  assetId: string
  alt?: string
  loading?: 'eager' | 'lazy'
  fallback?: ReactNode
}) {
  const [resolved, setResolved] = useState<ResolvedAssetPreview | null>(() => resolvedPreviewCache.get(assetId) ?? null)

  useEffect(() => {
    let active = true
    void resolveAssetPreview(assetId).then((result) => { if (active) setResolved(result) }).catch(() => {
      if (active) setResolved({ assetId, src: null, failed: true })
    })
    return () => { active = false }
  }, [assetId])

  const privateMedia = usePrivateMediaUrl(resolved?.src, {
    enabled: Boolean(resolved && !resolved.failed && resolved.assetId === assetId),
    priority: loading === 'eager' ? 'high' : 'normal',
  })

  if (!resolved || resolved.assetId !== assetId) return null
  if (resolved.failed || privateMedia.failed) return <>{fallback}</>
  if (!privateMedia.url) return null
  return <img src={privateMedia.url} alt={alt} loading={loading} decoding="async" onError={() => setResolved({ assetId, src: null, failed: true })} />
}
