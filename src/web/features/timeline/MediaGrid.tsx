import { useState } from 'react'
import { Check, Heart, Play, RefreshCw, Send } from 'lucide-react'
import { useArchive } from '../../context/ArchiveContext'
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
  // A failed preview must reach a real terminal state with a retry, not shimmer forever.
  const [failed, setFailed] = useState(false)
  const [reloadNonce, setReloadNonce] = useState(0)
  const previewSrc = reloadNonce
    ? `${asset.previewUrl}${asset.previewUrl.includes('?') ? '&' : '?'}retry=${reloadNonce}`
    : asset.previewUrl
  const retryPreview = () => { setFailed(false); setReloadNonce((value) => value + 1) }
  return (
    <article className={`media-tile media-${asset.mediaType}${selectionMode ? ' selection-mode' : ''}${selected ? ' selected' : ''}${failed ? ' media-failed' : ''}`} style={{ aspectRatio: ratio }}>
      <button
        type="button"
        className="media-open"
        onClick={() => selectionMode ? onToggleSelection?.(asset) : openViewer(asset)}
        aria-label={selectionMode ? `${selected ? '取消选择' : '选择'} ${asset.originalName}` : `打开 ${asset.originalName}`}
        aria-pressed={selectionMode ? selected : undefined}
      >
        <img
          src={previewSrc}
          alt=""
          loading={priority ? 'eager' : 'lazy'}
          fetchPriority={priority ? 'high' : 'low'}
          decoding="async"
          width={asset.width ?? undefined}
          height={asset.height ?? undefined}
          draggable={false}
          onLoad={(event) => { event.currentTarget.dataset.loaded = 'true'; if (failed) setFailed(false) }}
          onError={() => setFailed(true)}
        />
        <span className="media-overlay"><strong>{asset.originalName}</strong><small>{new Date(asset.takenAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</small></span>
      </button>
      {failed && <button type="button" className="media-retry" onClick={retryPreview} aria-label={`重新加载 ${asset.originalName}`}><RefreshCw /><span>重新加载</span></button>}
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

