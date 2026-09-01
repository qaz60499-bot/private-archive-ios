import { useEffect, useState, type ReactNode } from 'react'
import { api } from '../lib/api'
import { usePrivateMediaUrl } from '../lib/native-media'

export function AssetPreviewById({ assetId, alt = '', loading = 'lazy', fallback = null }: {
  assetId: string
  alt?: string
  loading?: 'eager' | 'lazy'
  fallback?: ReactNode
}) {
  const [resolved, setResolved] = useState<{ assetId: string; src: string | null; failed: boolean } | null>(null)

  useEffect(() => {
    let active = true
    void api.getAsset(assetId).then(({ asset }) => {
      if (!active) return
      setResolved({ assetId, src: asset.previewSupported ? asset.previewUrl : null, failed: !asset.previewSupported })
    }).catch(() => { if (active) setResolved({ assetId, src: null, failed: true }) })
    return () => { active = false }
  }, [assetId])

  const privateMedia = usePrivateMediaUrl(resolved?.src, { enabled: Boolean(resolved && !resolved.failed && resolved.assetId === assetId) })

  if (!resolved || resolved.assetId !== assetId) return null
  if (resolved.failed || privateMedia.failed) return <>{fallback}</>
  if (!privateMedia.url) return null
  return <img src={privateMedia.url} alt={alt} loading={loading} decoding="async" onError={() => setResolved({ assetId, src: null, failed: true })} />
}
