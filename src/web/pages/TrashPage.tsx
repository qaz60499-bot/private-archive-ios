import { useCallback, useEffect, useState } from 'react'
import { Eye, FileText, Film, ImageOff, RotateCcw, Trash2 } from 'lucide-react'
import { EmptyState, ErrorState, PageIntro, SkeletonGrid } from '../components/States'
import { useArchive } from '../context/ArchiveContext'
import { assetKindLabel, assetSourceLabel, formatArchiveDate, formatBytes } from '../lib/asset-display'
import { api } from '../lib/api'
import { purgeAssetThroughStorage } from '../lib/telegram-user-group'
import { usePrivateMediaUrl } from '../lib/native-media'
import type { Asset } from '../types'

function purgeLabel(asset: Asset): string {
  if (!asset.purgeAt) return '永久保留，直到手动清理'
  const time = Date.parse(asset.purgeAt)
  if (!Number.isFinite(time)) return '等待清理'
  const days = Math.max(0, Math.ceil((time - Date.now()) / 86_400_000))
  return days > 0 ? `${days} 天后可按策略清理` : '已达到保留期限'
}

function TrashPreview({ asset, onOpen }: { asset: Asset; onOpen: () => void }) {
  const [failed, setFailed] = useState(false)
  const privatePreview = usePrivateMediaUrl(asset.previewUrl, { enabled: asset.previewSupported && !failed })
  const hasPreview = asset.previewSupported && Boolean(privatePreview.url) && !failed && !privatePreview.failed
  const Icon = asset.mediaType === 'video' ? Film : asset.mediaType === 'file' ? FileText : ImageOff

  return <button className={`trash-preview-button${hasPreview ? '' : ' unavailable'}`} type="button" onClick={onOpen} aria-label={`查看 ${asset.originalName}`}>
    <span className="trash-preview">
      {hasPreview ? <img src={privatePreview.url ?? undefined} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} /> : null}
      {!hasPreview ? <span className="trash-preview-fallback"><Icon /><b>{assetKindLabel(asset)}</b><small>预览不可用</small></span> : null}
      {asset.mediaType === 'video' && hasPreview ? <span className="trash-media-badge">VIDEO</span> : null}
    </span>
    <span className="trash-preview-open"><Eye />查看</span>
  </button>
}

export function TrashPage() {
  const { openViewer } = useArchive()
  const [items, setItems] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const params = new URLSearchParams({ status: 'trashed', limit: '60' })
      setItems((await api.listAssets(params)).items)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '回收站加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  const restore = async (asset: Asset) => {
    setBusyId(asset.id)
    setError(null)
    try {
      await api.restoreAsset(asset.id)
      setItems((current) => current.filter((item) => item.id !== asset.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '恢复失败')
    } finally {
      setBusyId(null)
    }
  }

  const purge = async (asset: Asset) => {
    if (!window.confirm(`永久删除“${asset.originalName}”？只有当它是 Telegram 物理对象的最后一个引用时，Worker 才会删除 Telegram 原件。此操作不可恢复。`)) return
    setBusyId(asset.id)
    setError(null)
    try {
      await purgeAssetThroughStorage(asset)
      setItems((current) => current.filter((item) => item.id !== asset.id))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '永久删除失败')
    } finally {
      setBusyId(null)
    }
  }

  return <div className="page trash-page">
    <PageIntro eyebrow="ARCHIVE · TRASH" title="回收站" description="删除的项目先留在这里。先确认来源和内容，再决定恢复或永久清理；Telegram 原件仍受最后引用保护。" count={items.length} />
    {error ? <ErrorState message={error} onRetry={() => void load()} /> : loading ? <SkeletonGrid /> : items.length ? <div className="trash-grid">{items.map((asset) => <article className="trash-card" key={asset.id}>
      <TrashPreview asset={asset} onOpen={() => openViewer(asset)} />
      <div className="trash-copy">
        <div className="trash-title-row"><div><p className="eyebrow">{assetSourceLabel(asset.source)} · {assetKindLabel(asset)}</p><strong title={asset.originalName}>{asset.originalName}</strong></div><span>{formatBytes(asset.sizeBytes)}</span></div>
        <dl className="trash-metadata">
          <div><dt>来源</dt><dd>{assetSourceLabel(asset.source)}</dd></div>
          <div><dt>删除时间</dt><dd>{formatArchiveDate(asset.deletedAt)}</dd></div>
          <div><dt>拍摄时间</dt><dd>{formatArchiveDate(asset.takenAt)}</dd></div>
          <div><dt>导入时间</dt><dd>{formatArchiveDate(asset.uploadedAt)}</dd></div>
          <div><dt>原路径</dt><dd title={asset.logicalPath}>{asset.logicalPath || '/'}</dd></div>
          <div><dt>文件</dt><dd>{asset.mimeType} · {formatBytes(asset.sizeBytes)}</dd></div>
          {asset.albumNames?.length ? <div className="trash-metadata-wide"><dt>原相册</dt><dd>{asset.albumNames.join('、')}</dd></div> : null}
        </dl>
        <p className="trash-retention-note">{purgeLabel(asset)}</p>
      </div>
      <div className="trash-actions">
        <button className="secondary-button" type="button" disabled={busyId === asset.id} onClick={() => openViewer(asset)}><Eye />查看</button>
        <button className="secondary-button" type="button" disabled={busyId === asset.id} onClick={() => void restore(asset)}><RotateCcw />恢复</button>
        <button className="danger-button" type="button" disabled={busyId === asset.id} onClick={() => void purge(asset)}><Trash2 />永久删除</button>
      </div>
    </article>)}</div> : <EmptyState title="回收站为空" description="移入回收站的照片、视频和文件会先在这里保留，不会立即删除 Telegram 原件。" />}
  </div>
}
