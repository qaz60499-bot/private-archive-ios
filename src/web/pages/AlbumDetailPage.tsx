import { useEffect, useMemo, useState } from 'react'
import { ArrowLeft, Check, ImagePlus, LoaderCircle, Star, Trash2, X } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { EmptyState, ErrorState, LoadMore, SkeletonGrid } from '../components/States'
import { AssetPreviewById } from '../components/AssetPreviewById'
import { useArchive } from '../context/ArchiveContext'
import { MediaGrid } from '../features/timeline/MediaGrid'
import { api } from '../lib/api'
import { usePrivateMediaUrl } from '../lib/native-media'
import type { Album, Asset } from '../types'

function formatRange(album: Album): string {
  if (!album.first_taken_at || !album.latest_taken_at) return '尚无拍摄时间'
  const first = new Date(album.first_taken_at).toLocaleDateString('zh-CN')
  const latest = new Date(album.latest_taken_at).toLocaleDateString('zh-CN')
  return first === latest ? first : `${first} — ${latest}`
}

function AlbumPickerPreview({ asset }: { asset: Asset }) {
  const preview = usePrivateMediaUrl(asset.previewUrl, { enabled: asset.previewSupported, priority: 'low' })
  if (!preview.url) return <span className="album-picker-preview-placeholder" aria-hidden="true"><ImagePlus /></span>
  return <img src={preview.url} alt="" loading="lazy" decoding="async" />
}

function AddToAlbumDialog({ album, currentIds, onClose, onAdded }: { album: Album; currentIds: Set<string>; onClose: () => void; onAdded: () => Promise<void> }) {
  const [items, setItems] = useState<Asset[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const params = new URLSearchParams({ limit: '60' })
    void api.listAssets(params).then(({ items: next }) => {
      setItems(next.filter((asset) => !currentIds.has(asset.id)))
    }).catch(() => setError('最近媒体加载失败，请重试。')).finally(() => setLoading(false))
  }, [currentIds])

  const toggle = (id: string) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })

  const add = async () => {
    if (!selected.size || saving) return
    setSaving(true)
    setError(null)
    try {
      await Promise.all([...selected].map((assetId) => api.addToAlbum(album.id, assetId)))
      await onAdded()
      onClose()
    } catch {
      setError('加入相册失败，请重试。')
    } finally {
      setSaving(false)
    }
  }

  return <div className="album-picker-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="album-picker" role="dialog" aria-modal="true" aria-label={`加入 ${album.name}`}>
      <header><div><p className="eyebrow">ADD TO ALBUM</p><h2>从最近档案加入</h2></div><button className="icon-button" type="button" aria-label="关闭" onClick={onClose}><X /></button></header>
      {loading ? <SkeletonGrid /> : error && !items.length ? <p className="album-error" role="alert">{error}</p> : items.length ? <div className="album-picker-grid">{items.map((asset) => {
        const checked = selected.has(asset.id)
        return <button key={asset.id} className={`album-picker-item${checked ? ' selected' : ''}`} type="button" aria-pressed={checked} onClick={() => toggle(asset.id)}>
          <AlbumPickerPreview asset={asset} />
          <span>{checked ? <Check /> : null}</span>
          <small>{asset.originalName}</small>
        </button>
      })}</div> : <EmptyState title="最近档案都已在相册中" description="可以从时间线继续加入新的照片。" />}
      <footer><span>{selected.size ? `已选 ${selected.size} 项` : '选择要加入的照片'}</span><button className="primary-button" type="button" disabled={!selected.size || saving} onClick={() => void add()}>{saving ? <LoaderCircle className="spin" /> : <ImagePlus />}{saving ? '加入中' : '加入相册'}</button></footer>
      {error && items.length ? <p className="album-error" role="alert">{error}</p> : null}
    </section>
  </div>
}

export function AlbumDetailPage() {
  const { id = '' } = useParams()
  const { assets, loading, loadingMore, nextCursor, error, load, loadMore } = useArchive()
  const [album, setAlbum] = useState<Album | null>(null)
  const [albumError, setAlbumError] = useState<string | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [mutating, setMutating] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)

  const refresh = async () => {
    const [{ album: nextAlbum }] = await Promise.all([api.getAlbum(id), load({ albumId: id })])
    setAlbum(nextAlbum)
    setSelected(new Set())
  }

  useEffect(() => {
    if (!id) return
    let active = true
    void api.getAlbum(id).then(({ album: nextAlbum }) => {
      if (active) {
        setAlbum(nextAlbum)
        setAlbumError(null)
      }
    }).catch(() => { if (active) setAlbumError('相册不存在或暂时无法打开。') })
    void load({ albumId: id })
    return () => { active = false }
  }, [id, load])

  const toggleSelected = (asset: Asset) => setSelected((current) => {
    const next = new Set(current)
    if (next.has(asset.id)) next.delete(asset.id)
    else next.add(asset.id)
    return next
  })

  const removeSelected = async () => {
    if (!album || !selected.size || mutating) return
    if (!window.confirm(`从“${album.name}”移出 ${selected.size} 项？不会删除照片或 Telegram 原件。`)) return
    setMutating(true)
    try {
      await Promise.all([...selected].map((assetId) => api.removeFromAlbum(album.id, assetId)))
      await refresh()
    } catch {
      setAlbumError('移出相册失败，请重试。')
    } finally {
      setMutating(false)
    }
  }

  const setCover = async () => {
    if (!album || selected.size !== 1 || mutating) return
    setMutating(true)
    try {
      await api.setAlbumCover(album.id, [...selected][0])
      setAlbum((await api.getAlbum(album.id)).album)
      setSelected(new Set())
      setSelectionMode(false)
    } catch {
      setAlbumError('设置封面失败，请重试。')
    } finally {
      setMutating(false)
    }
  }

  const currentIds = useMemo(() => new Set(assets.map((asset) => asset.id)), [assets])

  if (albumError && !album) return <div className="page"><ErrorState message={albumError} onRetry={() => void refresh()} /></div>
  if (!album) return <div className="page"><SkeletonGrid /></div>

  return <div className="page album-detail-page">
    <header className="album-detail-hero">
      <Link className="album-back" to="/albums"><ArrowLeft />相册</Link>
      <div className="album-detail-cover" aria-hidden="true">{album.cover_asset_id ? <AssetPreviewById assetId={album.cover_asset_id} loading="eager" fallback={<ImagePlus />} /> : <ImagePlus />}</div>
      <div className="album-detail-copy"><p className="eyebrow">PRIVATE COLLECTION</p><h1>{album.name}</h1><p>{formatRange(album)} · {album.asset_count} 项</p></div>
      <div className="album-detail-actions">
        <button className="secondary-button" type="button" onClick={() => setPickerOpen(true)}><ImagePlus />加入照片</button>
        <button className={`secondary-button${selectionMode ? ' active' : ''}`} type="button" onClick={() => { setSelectionMode((value) => !value); setSelected(new Set()) }}>{selectionMode ? '完成' : '选择'}</button>
      </div>
    </header>

    {albumError ? <p className="album-error" role="alert">{albumError}</p> : null}
    {selectionMode ? <div className="album-selection-bar" aria-live="polite"><span>{selected.size ? `已选 ${selected.size} 项` : '选择照片后可移出或设为封面'}</span><div><button className="secondary-button" type="button" disabled={selected.size !== 1 || mutating} onClick={() => void setCover()}><Star />设为封面</button><button className="danger-button" type="button" disabled={!selected.size || mutating} onClick={() => void removeSelected()}>{mutating ? <LoaderCircle className="spin" /> : <Trash2 />}移出相册</button></div></div> : null}

    {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load({ albumId: id })} /> : assets.length ? <>
      <MediaGrid assets={assets} eagerCount={6} selectionMode={selectionMode} selectedIds={selected} onToggleSelection={toggleSelected} />
      {nextCursor ? <LoadMore loading={loadingMore} onLoad={() => void loadMore()} /> : null}
    </> : <EmptyState title="这个相册还没有照片" description="从最近档案加入，或在 Viewer 里把照片归入这个相册。" action={<button className="primary-button" type="button" onClick={() => setPickerOpen(true)}><ImagePlus />加入照片</button>} />}

    {pickerOpen ? <AddToAlbumDialog album={album} currentIds={currentIds} onClose={() => setPickerOpen(false)} onAdded={refresh} /> : null}
  </div>
}
