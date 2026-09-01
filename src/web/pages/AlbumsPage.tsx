import { useEffect, useState } from 'react'
import { Album as AlbumIcon, ImageOff, LoaderCircle, Plus, Trash2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { AssetPreviewById } from '../components/AssetPreviewById'
import type { Album } from '../types'
import { EmptyState, PageIntro } from '../components/States'

function AlbumCover({ album }: { album: Album }) {
  if (!album.cover_asset_id) return <div className="album-cover-fallback"><AlbumIcon /><span>等待第一张封面</span></div>
  return <AssetPreviewById assetId={album.cover_asset_id} fallback={<div className="album-cover-fallback"><ImageOff /><span>封面暂不可用</span></div>} />
}

export function AlbumsPage() {
  const [albums, setAlbums] = useState<Album[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void api.listAlbums().then(({ items }) => setAlbums(items)).catch(() => setError('相册加载失败，请重试。'))
  }, [])

  const create = async () => {
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const { album } = await api.createAlbum(trimmed)
      setAlbums((current) => [album, ...current.filter((item) => item.id !== album.id)])
      setName('')
    } catch {
      setError('相册创建失败，请重试。')
    } finally {
      setCreating(false)
    }
  }

  const remove = async (album: Album) => {
    if (deletingId) return
    if (!window.confirm(`删除相册“${album.name}”？只会删除相册和归类关系，不会删除任何照片或 Telegram 原件。`)) return
    setDeletingId(album.id)
    setError(null)
    try {
      await api.deleteAlbum(album.id)
      setAlbums((current) => current.filter((item) => item.id !== album.id))
    } catch {
      setError('相册删除失败，请重试。')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="page">
      <PageIntro eyebrow="COLLECTIONS · ALBUMS" title="相册" description="把属于同一段旅程、人物或主题的内容放在一起；原件不会因为加入相册而被复制。" />
      <form className="album-create" onSubmit={(event) => { event.preventDefault(); void create() }}>
        <label htmlFor="album-name">新相册名称</label>
        <input id="album-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={80} placeholder="例如：东京旅行" />
        <button className="primary-button" type="submit" disabled={creating || !name.trim()}>
          {creating ? <LoaderCircle className="spin" /> : <Plus />}{creating ? '创建中' : '创建'}
        </button>
        {error ? <p className="album-error" role="alert">{error}</p> : null}
      </form>
      {albums.length ? (
        <div className="album-grid">
          {albums.map((album) => (
            <article className="album-card" key={album.id}>
              <Link className="album-card-link" to={`/albums/${album.id}`} aria-label={`打开相册 ${album.name}`}>
                <div className="album-card-stack" aria-hidden="true">
                  <span className="album-card-sheet album-card-sheet-back" />
                  <span className="album-card-sheet album-card-sheet-mid" />
                  <div className="album-card-cover"><AlbumCover album={album} /></div>
                </div>
                <p>PRIVATE COLLECTION</p>
                <h2>{album.name}</h2>
                <span>{album.asset_count} 项{album.latest_taken_at ? ` · ${new Date(album.latest_taken_at).getFullYear()}` : ''}</span>
              </Link>
              <button className="album-delete" type="button" aria-label={`删除相册 ${album.name}`} disabled={deletingId === album.id} onClick={() => void remove(album)}>
                {deletingId === album.id ? <LoaderCircle className="spin" /> : <Trash2 />}
              </button>
            </article>
          ))}
        </div>
      ) : <EmptyState title="还没有相册" description="创建相册后，可在暗色 Viewer 的信息面板中加入媒体。" />}
    </div>
  )
}
