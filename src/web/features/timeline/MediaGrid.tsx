import { useEffect, useRef, useState } from 'react'
import { Check, Heart, ImageOff, Play, RefreshCw, Send } from 'lucide-react'
import { useArchive } from '../../context/ArchiveContext'
import { usePrivateMediaUrl } from '../../lib/native-media'
import type { Asset } from '../../types'

export function VideoBadge() {
  return <span className="video-badge"><Play fill="currentColor" />视频</span>
}

export function MediaTile({
  asset,
  priority = false,
  selectionMode = false,
  selected = false,
  onToggleSelection,
}: {
  asset: Asset
  priority?: boolean
  selectionMode?: boolean
  selected?: boolean
  onToggleSelection?: (asset: Asset) => void
}) {
  const { openViewer, toggleFavorite } = useArchive()
  const ratio = asset.width && asset.height ? `${asset.width} / ${asset.height}` : '4 / 3'
  const tileRef = useRef<HTMLElement>(null)
  const [nearViewport, setNearViewport] = useState(priority || typeof IntersectionObserver === 'undefined')
  // Track the exact preview URL that failed instead of a sticky boolean. If the
  // server later publishes a new preview URL for the same asset, it becomes eligible
  // immediately without an effect-driven state reset.
  const [failedPreviewUrl, setFailedPreviewUrl] = useState<string | null>(null)
  const failed = !asset.previewSupported || failedPreviewUrl === asset.previewUrl
  const [reloadNonce, setReloadNonce] = useState(0)
  const previewSrc = reloadNonce
    ? `${asset.previewUrl}${asset.previewUrl.includes('?') ? '&' : '?'}retry=${reloadNonce}`
    : asset.previewUrl
  useEffect(() => {
    if (priority || nearViewport || typeof IntersectionObserver === 'undefined') return
    const node = tileRef.current
    if (!node) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setNearViewport(true)
        observer.disconnect()
      }
    }, { rootMargin: '500px 0px' })
    observer.observe(node)
    return () => observer.disconnect()
  }, [nearViewport, priority])
  const previewEnabled = asset.previewSupported && !failed && (priority || nearViewport)
  const nativePreview = usePrivateMediaUrl(previewSrc, { enabled: previewEnabled, retryKey: reloadNonce, priority: priority ? 'high' : 'low' })
  const previewFailed = failed || previewEnabled && nativePreview.failed
  const retryPreview = () => { setFailedPreviewUrl(null); setNearViewport(true); setReloadNonce((value) => value + 1) }
  const takenTime = new Date(asset.takenAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  const archiveContext = asset.albumNames?.[0] ?? asset.tags?.[0]?.name ?? null
  return (
    <article ref={tileRef} className={`media-tile media-${asset.mediaType}${selectionMode ? ' selection-mode' : ''}${selected ? ' selected' : ''}${previewFailed ? ' media-failed' : ''}`} style={{ aspectRatio: ratio }}>
      <button
        type="button"
        className="media-open"
        onClick={() => selectionMode ? onToggleSelection?.(asset) : openViewer(asset)}
        aria-label={selectionMode ? `${selected ? '取消选择' : '选择'} ${asset.originalName}` : `打开 ${asset.originalName}`}
        aria-pressed={selectionMode ? selected : undefined}
      >
        {!previewFailed && nativePreview.url ? <img
          src={nativePreview.url}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'low'}
          decoding="async"
          width={asset.width ?? undefined}
          height={asset.height ?? undefined}
          draggable={false}
          onLoad={(event) => { event.currentTarget.dataset.loaded = 'true' }}
          onError={() => setFailedPreviewUrl(asset.previewUrl)}
        /> : previewFailed ? <span className="media-preview-unavailable"><ImageOff /><b>预览不可用</b><small>点“重新加载”再试一次</small></span> : null}
        <span className="media-overlay">
          <span className="media-overlay-copy">
            <small>{takenTime}</small>
            <strong>{asset.originalName}</strong>
            {archiveContext ? <em>{archiveContext}</em> : null}
          </span>
        </span>
      </button>
      {previewFailed && asset.previewSupported && <button type="button" className="media-retry" onClick={retryPreview} aria-label={`重新加载 ${asset.originalName}`}><RefreshCw /><span>重新加载</span></button>}
      {selectionMode && <span className="selection-indicator" aria-hidden="true">{selected ? <Check /> : null}</span>}
      {asset.mediaType === 'video' && <VideoBadge />}
      {!asset.originalAvailableInApp && asset.mediaType !== 'file' && <span className="telegram-only" title="原文件仅在 Telegram 打开"><Send /></span>}
      {!selectionMode && <button type="button" className={`favorite-button${asset.favorite ? ' active' : ''}`} aria-label={asset.favorite ? '取消收藏' : '收藏'} aria-pressed={asset.favorite} onClick={() => void toggleFavorite(asset)}>
        <Heart fill={asset.favorite ? 'currentColor' : 'none'} />
      </button>}
    </article>
  )
}

export function MediaGrid({
  assets,
  eagerCount = 4,
  selectionMode = false,
  selectedIds,
  onToggleSelection,
}: {
  assets: Asset[]
  eagerCount?: number
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelection?: (asset: Asset) => void
}) {
  return <div className="media-grid">{assets.map((asset, index) => <MediaTile key={asset.id} asset={asset} priority={index < eagerCount} selectionMode={selectionMode} selected={selectedIds?.has(asset.id)} onToggleSelection={onToggleSelection} />)}</div>
}

export function TimelineSection({
  date,
  assets,
  eager = false,
  selectionMode = false,
  selectedIds,
  onToggleSelection,
}: {
  date: string
  assets: Asset[]
  eager?: boolean
  selectionMode?: boolean
  selectedIds?: Set<string>
  onToggleSelection?: (asset: Asset) => void
}) {
  const parsed = new Date(date)
  return (
    <section className="timeline-section">
      <header className="folio-heading"><div className="folio-rule" /><div><p>{parsed.toLocaleDateString('zh-CN', { weekday: 'long' })}</p><h2>{parsed.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}</h2></div><span>{String(assets.length).padStart(2, '0')} / ARCHIVE</span></header>
      <MediaGrid assets={assets} eagerCount={eager ? 4 : 0} selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelection={onToggleSelection} />
    </section>
  )
}

