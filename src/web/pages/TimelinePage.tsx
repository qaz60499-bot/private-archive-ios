import { useEffect, useMemo, useState } from 'react'
import { ArchiveRestore, CheckSquare, ImagePlus, Trash2, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useArchive } from '../context/ArchiveContext'
import { FilterChips } from '../components/FilterChips'
import { EmptyState, ErrorState, LoadMore, PageIntro, SkeletonGrid } from '../components/States'
import { MemoryAperture } from '../components/MemoryAperture'
import { TimelineMonthJump } from '../components/TimelineMonthJump'
import { TimelineSection } from '../features/timeline/MediaGrid'
import { api } from '../lib/api'
import { importFiles, type ImportFilesProgress } from '../lib/import-files'
import { parseArchiveSearch } from '../lib/search-query'
import type { Asset } from '../types'

const filters = [{ value: 'all', label: '全部' }, { value: 'photo', label: '照片' }, { value: 'video', label: '视频' }, { value: 'favorite', label: '收藏' }]
const categoryLabels: Record<string, string> = { people: '人物', gathering: '聚会', travel: '旅途', city: '城市', nature: '自然', food: '食物', screenshot: '截屏', other: '其他' }

export function TimelinePage() {
  const { assets, loading, loadingMore, nextCursor, error, load, loadMore, setUploadOpen } = useArchive()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState('all')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mobileImportProgress, setMobileImportProgress] = useState<ImportFilesProgress | null>(null)
  const query = searchParams.get('q') ?? undefined
  const category = searchParams.get('category') ?? undefined
  const categoryLabel = searchParams.get('label') ?? undefined
  const focusSearch = searchParams.get('focus') === 'search'
  const month = searchParams.get('month') ?? undefined
  const showMemoryAperture = !query && !category && !focusSearch && !month
  const parsedSearch = useMemo(() => parseArchiveSearch(query), [query])
  const monthRange = useMemo(() => {
    if (!month || !/^\d{4}-(0[1-9]|1[0-2])$/u.test(month)) return null
    const [year, monthNumber] = month.split('-').map(Number)
    const after = new Date(Date.UTC(year, monthNumber - 1, 1)).toISOString()
    const before = new Date(Date.UTC(monthNumber === 12 ? year + 1 : year, monthNumber === 12 ? 0 : monthNumber, 1)).toISOString()
    return { after, before }
  }, [month])
  const loadOptions = useMemo(() => ({
    q: parsedSearch.q,
    category,
    mediaType: filter === 'photo' || filter === 'video' ? filter : parsedSearch.mediaType,
    favorite: filter === 'favorite' ? true : parsedSearch.favorite,
    takenAfter: monthRange?.after ?? parsedSearch.takenAfter,
    takenBefore: monthRange?.before ?? parsedSearch.takenBefore,
  }), [category, filter, monthRange, parsedSearch])

  useEffect(() => {
    void load(loadOptions)
    if (focusSearch) window.setTimeout(() => document.querySelector<HTMLInputElement>('#archive-search')?.focus(), 50)
  }, [focusSearch, load, loadOptions])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setSelectionMode(false)
      setSelectedIds(new Set())
    }, 0)
    return () => window.clearTimeout(timer)
  }, [category, filter, month, query])

  const sections = useMemo(() => {
    const grouped = new Map<string, typeof assets>()
    for (const asset of assets) {
      const key = asset.takenAt.slice(0, 10)
      grouped.set(key, [...(grouped.get(key) ?? []), asset])
    }
    return [...grouped.entries()]
  }, [assets])

  const seed = async () => { await api.seedMock(); await load() }
  const importMobilePhotos = async (files: File[]) => {
    if (!files.length) return
    setActionError(null)
    setMobileImportProgress({ total: files.length, processed: 0, queued: 0, window: 1, windows: Math.max(1, Math.ceil(files.length / 8)), phase: 'registering' })
    try {
      const result = await importFiles(files, navigator.onLine, { mobile: true, onProgress: setMobileImportProgress })
      if (result.errors.length) setActionError(result.errors.join('；'))
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '手机照片导入失败')
    }
  }
  const toggleSelection = (asset: Asset) => {
    setSelectedIds((current) => {
      const next = new Set(current)
      if (next.has(asset.id)) next.delete(asset.id)
      else next.add(asset.id)
      return next
    })
  }

  const cancelSelection = () => {
    setSelectionMode(false)
    setSelectedIds(new Set())
    setActionError(null)
  }

  const deleteSelected = async () => {
    if (!selectedIds.size || bulkBusy) return
    if (!window.confirm(`将选中的 ${selectedIds.size} 项移入回收站？Telegram 中的原文件不会被删除。`)) return
    setBulkBusy(true)
    setActionError(null)
    try {
      await api.bulkTrashAssets([...selectedIds])
      setSelectedIds(new Set())
      setSelectionMode(false)
      await load(loadOptions)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '批量删除失败')
    } finally {
      setBulkBusy(false)
    }
  }

  return (
    <div className={`page timeline-page${showMemoryAperture ? ' timeline-page-memory' : ''}`}>
      {showMemoryAperture
        ? <MemoryAperture count={assets.length} />
        : <PageIntro eyebrow="私人影像库 · 01" title={query ? `“${query}”` : category ? `分类 · ${categoryLabel ?? categoryLabels[category] ?? category}` : month ? `月度 · ${month.replace('-', ' · ')}` : '私人影像库'} description="按真实拍摄时间归档。原件沉静地留在 Telegram，眼前只呈现值得重看的部分。" count={assets.length} />}
      <div className="timeline-control-row">
        <FilterChips options={filters} value={filter} onChange={setFilter} />
        <div className="timeline-actions">
          <TimelineMonthJump value={month} onChange={(nextMonth) => {
            const next = new URLSearchParams(searchParams)
            if (nextMonth) next.set('month', nextMonth)
            else next.delete('month')
            setSearchParams(next)
          }} />
          <input id="timeline-mobile-photo-input" className="timeline-mobile-photo-input" type="file" multiple accept="image/*" aria-hidden="true" tabIndex={-1} onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (selected.length) void importMobilePhotos(selected) }} />
          <label className="secondary-button mobile-library-import" htmlFor="timeline-mobile-photo-input" role="button" tabIndex={0}><ImagePlus />{mobileImportProgress?.phase === 'registering' ? `正在加入 ${mobileImportProgress.processed}/${mobileImportProgress.total}` : '导入手机相册'}</label>
          {!selectionMode ? (
            <button className="secondary-button timeline-select-button" type="button" onClick={() => setSelectionMode(true)}><CheckSquare />选择</button>
          ) : (
            <>
              <span className="selection-count">已选 {selectedIds.size} 项</span>
              <button className="secondary-button" type="button" onClick={() => setSelectedIds(new Set(assets.map((asset) => asset.id)))}>全选当前</button>
              <button className="selection-delete-button" type="button" disabled={!selectedIds.size || bulkBusy} onClick={() => void deleteSelected()}><Trash2 />{bulkBusy ? '删除中' : '删除选中'}</button>
              <button className="icon-button" type="button" onClick={cancelSelection} aria-label="取消选择"><X /></button>
            </>
          )}
        </div>
      </div>
      {mobileImportProgress ? <p className="mobile-import-status" role="status">{mobileImportProgress.phase === 'complete' ? `已加入 ${mobileImportProgress.queued} 张照片，正在后台上传；你可以继续浏览图库。` : `正在接收手机照片：${mobileImportProgress.processed}/${mobileImportProgress.total}`}</p> : null}
      {actionError ? <p className="inline-error timeline-action-error" role="alert">{actionError}</p> : null}
      {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load(loadOptions)} /> : sections.length ? <>{sections.map(([date, items], index) => <TimelineSection key={date} date={date} assets={items} eager={index === 0} selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelection={toggleSelection} />)}{nextCursor && <LoadMore loading={loadingMore} onLoad={() => void loadMore()} />}</> : <EmptyState action={<div className="empty-actions"><button className="primary-button" type="button" onClick={() => setUploadOpen(true)}>加入第一项</button><button className="secondary-button" type="button" onClick={() => void seed()}><ArchiveRestore />载入 Mock 馆藏</button></div>} />}
    </div>
  )
}
