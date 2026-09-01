import { useCallback, useEffect, useState } from 'react'
import { Download, Image as ImageIcon, LoaderCircle, LockKeyhole } from 'lucide-react'
import type { Album, Asset } from '../types'

interface SharePrincipal {
  id: string
  displayName: string
  linkId: string
  expiresAt: string
}

async function shareRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) throw new Error(body.error ?? 'SHARE_REQUEST_FAILED')
  return body
}

function tokenFromHash(): string | null {
  const match = window.location.hash.match(/^#\/share\/([^/?#]+)/)
  return match ? decodeURIComponent(match[1]) : null
}

export function SharePage() {
  const [principal, setPrincipal] = useState<SharePrincipal | null>(null)
  const [assets, setAssets] = useState<Asset[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadArchive = useCallback(async () => {
    const [{ items }, albumResponse] = await Promise.all([
      shareRequest<{ items: Asset[] }>('/api/share/assets?limit=60'),
      shareRequest<{ items: Album[] }>('/api/share/albums'),
    ])
    setAssets(items)
    setAlbums(albumResponse.items)
  }, [])

  useEffect(() => {
    let active = true
    void (async () => {
      try {
        const token = tokenFromHash()
        let session: { principal: SharePrincipal }
        if (token) {
          session = await shareRequest('/api/share/exchange', { method: 'POST', body: JSON.stringify({ token }) })
          history.replaceState(null, '', `${window.location.pathname}#/shared`)
        } else {
          session = await shareRequest('/api/share/session')
        }
        if (!active) return
        setPrincipal(session.principal)
        await loadArchive()
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : 'SHARE_ACCESS_FAILED')
      } finally {
        if (active) setLoading(false)
      }
    })()
    return () => { active = false }
  }, [loadArchive])

  if (loading) return <main className="share-page share-state"><LoaderCircle className="spin" /><p>正在打开共享档案…</p></main>
  if (error || !principal) return <main className="share-page share-state"><LockKeyhole /><h1>这个共享链接不可用</h1><p>{error ?? '链接可能已撤销或过期。'}</p></main>

  return <main className="share-page">
    <header className="share-header">
      <div><p className="eyebrow">PRIVATE ARCHIVE · SHARED VIEW</p><h1>{principal.displayName}</h1><p>只显示拥有授权的内容。共享访问不会进入 Owner 管理平面。</p></div>
      <LockKeyhole aria-hidden="true" />
    </header>

    {albums.length ? <section className="share-albums" aria-label="可访问相册">
      {albums.map((album) => <button key={album.id} type="button" onClick={() => void shareRequest<{ items: Asset[] }>(`/api/share/assets?albumId=${encodeURIComponent(album.id)}&limit=60`).then((result) => setAssets(result.items))}>
        <strong>{album.name}</strong><span>{album.asset_count} 项</span>
      </button>)}
      <button type="button" onClick={() => void loadArchive()}><strong>全部</strong><span>当前授权</span></button>
    </section> : null}

    {assets.length ? <section className="share-grid" aria-label="共享内容">
      {assets.map((asset) => <article className="share-asset" key={asset.id}>
        <div className="share-thumb">{asset.previewSupported ? <img src={asset.previewUrl} alt={asset.originalName} loading="lazy" /> : <ImageIcon />}</div>
        <div className="share-asset-meta"><strong>{asset.originalName}</strong><span>{new Date(asset.takenAt).toLocaleDateString()}</span></div>
        {asset.downloadSupported ? <a className="share-download" href={`/api/share/assets/${asset.id}/download`}><Download />下载</a> : null}
      </article>)}
    </section> : <section className="share-empty"><p>这个共享范围目前没有可显示的内容。</p></section>}
  </main>
}
