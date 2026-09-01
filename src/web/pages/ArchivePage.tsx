import { useEffect, useState } from 'react'
import { ArchiveRestore, CheckSquare, Trash2, X } from 'lucide-react'
import { EmptyState, ErrorState, LoadMore, PageIntro, SkeletonGrid } from '../components/States'
import { useArchive } from '../context/ArchiveContext'
import { MediaGrid } from '../features/timeline/MediaGrid'
import { api } from '../lib/api'
import type { Asset } from '../types'

export function ArchivePage() {
  const { assets, loading, loadingMore, nextCursor, error, load, loadMore } = useArchive()
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  useEffect(() => { void load({ archived: true }) }, [load])

  const toggle = (asset: Asset) => setSelectedIds((current) => {
    const next = new Set(current)
    if (next.has(asset.id)) next.delete(asset.id)
    else next.add(asset.id)
    return next
  })

  const finish = async (action: 'restore' | 'trash') => {
    if (!selectedIds.size || busy) return
    setBusy(true)
    setActionError(null)
    try {
      if (action === 'restore') await api.bulkPatchAssets([...selectedIds], { archived: false })
      else await api.bulkTrashAssets([...selectedIds])
      setSelectedIds(new Set())
      setSelectionMode(false)
      await load({ archived: true })
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '归档操作失败')
    } finally {
      setBusy(false)
    }
  }

  return <div className="page archive-page">
    <PageIntro eyebrow="LIBRARY · ARCHIVE" title="归档" description="把暂时不想出现在日常时间线里的内容收进这里。它们仍然完整保留，随时可以取消归档。" count={assets.length} />
    <div className="timeline-control-row archive-actions">
      {!selectionMode
        ? <button className="secondary-button" type="button" onClick={() => setSelectionMode(true)}><CheckSquare />批量选择</button>
        : <><span className="selection-count">已选 {selectedIds.size} 项</span><button className="secondary-button" type="button" onClick={() => setSelectedIds(new Set(assets.map((item) => item.id)))}>全选当前</button><button className="secondary-button" type="button" disabled={!selectedIds.size || busy} onClick={() => void finish('restore')}><ArchiveRestore />取消归档</button><button className="selection-delete-button" type="button" disabled={!selectedIds.size || busy} onClick={() => void finish('trash')}><Trash2 />移入回收站</button><button className="icon-button" type="button" aria-label="取消选择" onClick={() => { setSelectionMode(false); setSelectedIds(new Set()) }}><X /></button></>}
    </div>
    {actionError ? <p className="inline-error" role="alert">{actionError}</p> : null}
    {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load({ archived: true })} /> : assets.length ? <><MediaGrid assets={assets} selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelection={toggle} />{nextCursor ? <LoadMore loading={loadingMore} onLoad={() => void loadMore()} /> : null}</> : <EmptyState title="暂无归档内容" description="把暂时不想出现在主时间线的内容归档后，会出现在这里。" />}
  </div>
}
