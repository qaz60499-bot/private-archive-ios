import { useEffect, useMemo, useState } from 'react'
import { Archive, ArchiveRestore, CheckSquare, ImagePlus, Star, Tag, Trash2, X } from 'lucide-react'
import { useSearchParams } from 'react-router-dom'
import { useArchive } from '../context/ArchiveContext'
import { FilterChips } from '../components/FilterChips'
import { EmptyState, ErrorState, LoadMore, PageIntro, SkeletonGrid } from '../components/States'
import { MemoryAperture } from '../components/MemoryAperture'
import { TimelineMonthJump } from '../components/TimelineMonthJump'
import { TimelineSection } from '../features/timeline/MediaGrid'
import { api } from '../lib/api'
import { parseArchiveSearch } from '../lib/search-query'
import { telegramUserGroupBridge } from '../lib/telegram-user-group'
import type { Asset, StorageBackend } from '../types'

const filters = [{ value: 'all', label: '全部' }, { value: 'photo', label: '照片' }, { value: 'video', label: '视频' }, { value: 'favorite', label: '收藏' }]
const categoryLabels: Record<string, string> = { people: '人物', gathering: '聚会', travel: '旅途', city: '城市', nature: '自然', food: '食物', screenshot: '截屏', other: '其他' }

export function TimelinePage() {
  const { assets, loading, loadingMore, nextCursor, error, load, loadMore, setUploadOpen, importStatus, runImport } = useArchive()
  const [searchParams, setSearchParams] = useSearchParams()
  const [filter, setFilter] = useState('all')
  const [selectionMode, setSelectionMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [bulkBusy, setBulkBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [mobileStorageBackend, setMobileStorageBackend] = useState<StorageBackend>('telegram_user_group')
  const [timelineMonthCounts, setTimelineMonthCounts] = useState<Map<string, number>>(new Map())
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
    archived: parsedSearch.archived,
    fileCategory: parsedSearch.fileCategory,
    extension: parsedSearch.extension,
    tag: parsedSearch.tag,
    minSizeBytes: parsedSearch.minSizeBytes,
    maxSizeBytes: parsedSearch.maxSizeBytes,
    takenAfter: monthRange?.after ?? parsedSearch.takenAfter,
    takenBefore: monthRange?.before ?? parsedSearch.takenBefore,
  }), [category, filter, monthRange, parsedSearch])

  useEffect(() => {
    void load(loadOptions)
    if (focusSearch) window.setTimeout(() => document.querySelector<HTMLInputElement>('#archive-search')?.focus(), 50)
  }, [focusSearch, load, loadOptions])

  useEffect(() => {
    let active = true
    void Promise.all([
      api.timelineMonths(),
      api.storagePreference(),
    ]).then(([{ items }, preference]) => {
      if (!active) return
      setTimelineMonthCounts(new Map(items.map((item) => [item.month, item.asset_count])))
      setMobileStorageBackend(preference.defaultStorageBackend)
    }).catch(() => {
      // Month totals/storage preference are convenience state, never browsing prerequisites.
    })
    return () => { active = false }
  }, [])

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

  const monthChapters = useMemo(() => {
    const grouped = new Map<string, Array<[string, Asset[]]>>()
    for (const [date, items] of sections) {
      const monthKey = date.slice(0, 7)
      grouped.set(monthKey, [...(grouped.get(monthKey) ?? []), [date, items]])
    }
    return [...grouped.entries()]
  }, [sections])

  const seed = async () => { await api.seedMock(); await load() }
  const importMobilePhotos = async (files: File[]) => {
    if (!files.length) return
    setActionError(null)
    try {
      // Same app-level importer as the upload sheet, so the global toast and this row
      // stay in sync and feedback survives navigation.
      const result = await runImport(files, { mobile: true, storageBackend: mobileStorageBackend })
      if (result?.errors.length) setActionError(result.errors.join('；'))
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

  const patchSelected = async (patch: { favorite?: boolean; archived?: boolean; tags?: string[] }) => {
    if (!selectedIds.size || bulkBusy) return
    setBulkBusy(true)
    setActionError(null)
    try {
      await api.bulkPatchAssets([...selectedIds], patch)
      setSelectedIds(new Set())
      setSelectionMode(false)
      await load(loadOptions)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '批量更新失败')
    } finally {
      setBulkBusy(false)
    }
  }

  const tagSelected = () => {
    const entered = window.prompt('输入标签，可用逗号分隔多个标签。已有手动标签会被本次设置替换。')
    if (entered === null) return
    const tags = entered.split(/[，,]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 10)
    void patchSelected({ tags })
  }

  return (
    <div className={`page timeline-page${showMemoryAperture ? ' timeline-page-memory' : ''}`}>
      {showMemoryAperture
        ? <MemoryAperture assets={assets} onImport={() => setUploadOpen(true)} />
        : <PageIntro eyebrow="私人影像库 · 01" title={query ? `“${query}”` : category ? `分类 · ${categoryLabel ?? categoryLabels[category] ?? category}` : month ? `月度 · ${month.replace('-', ' · ')}` : '私人影像库'} description="按真实拍摄时间归档。原件沉静地留在 Telegram，眼前只呈现值得重看的部分。" count={assets.length} />}
      <div className="timeline-control-row" id="archive-timeline">
        <FilterChips options={filters} value={filter} onChange={setFilter} />
        <div className="timeline-actions">
          <TimelineMonthJump value={month} onChange={(nextMonth) => {
            const next = new URLSearchParams(searchParams)
            if (nextMonth) next.set('month', nextMonth)
            else next.delete('month')
            setSearchParams(next)
          }} />
          <input id="timeline-mobile-photo-input" className="timeline-mobile-photo-input" type="file" multiple accept="image/*" aria-hidden="true" tabIndex={-1} onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (selected.length) void importMobilePhotos(selected) }} />
          <label className="secondary-button mobile-library-import" htmlFor="timeline-mobile-photo-input" role="button" tabIndex={0} onClick={(event) => {
            if (mobileStorageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available) {
              event.preventDefault()
              setActionError('默认存储是 Telegram 私人群组。手机端请把照片直接分享到 Telegram 的 ai 私人群组；如需用 Bot 存储，请在上传面板里主动切换。')
              setUploadOpen(true)
            }
          }}><ImagePlus />{importStatus?.active ? `正在加入 ${importStatus.processed}/${importStatus.total}` : '导入手机相册'}</label>
          {!selectionMode ? (
            <button className="secondary-button timeline-select-button" type="button" onClick={() => setSelectionMode(true)}><CheckSquare />选择</button>
          ) : (
            <>
              <span className="selection-count">已选 {selectedIds.size} 项</span>
              <button className="secondary-button" type="button" onClick={() => setSelectedIds(new Set(assets.map((asset) => asset.id)))}>全选当前</button>
              <button className="secondary-button" type="button" disabled={!selectedIds.size || bulkBusy} onClick={() => void patchSelected({ favorite: true })}><Star />收藏</button>
              <button className="secondary-button" type="button" disabled={!selectedIds.size || bulkBusy} onClick={() => void patchSelected({ archived: true })}><Archive />归档</button>
              <button className="secondary-button" type="button" disabled={!selectedIds.size || bulkBusy} onClick={tagSelected}><Tag />标签</button>
              <button className="selection-delete-button" type="button" disabled={!selectedIds.size || bulkBusy} onClick={() => void deleteSelected()}><Trash2 />{bulkBusy ? '处理中' : '删除选中'}</button>
              <button className="icon-button" type="button" onClick={cancelSelection} aria-label="取消选择"><X /></button>
            </>
          )}
        </div>
      </div>
      {importStatus ? <p className="mobile-import-status" role="status">{importStatus.phase === 'complete' ? (importStatus.error ? `部分照片未能写入本机队列：${importStatus.error}` : `已加入 ${importStatus.queued} 项；本机已保存，Telegram 正在后台确认，你可以继续浏览图库。`) : `正在接收：${importStatus.processed}/${importStatus.total}，并写入本机恢复队列。`}</p> : null}
      {actionError ? <p className="inline-error timeline-action-error" role="alert">{actionError}</p> : null}
      {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load(loadOptions)} /> : sections.length ? <>
        <div className="timeline-month-chapters">
          {monthChapters.map(([monthKey, daySections], monthIndex) => {
            const [year, monthNumber] = monthKey.split('-').map(Number)
            const monthLabel = new Date(Date.UTC(year, monthNumber - 1, 1)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }).toUpperCase()
            const exactCount = timelineMonthCounts.get(monthKey)
            return <section className="timeline-month-chapter" key={monthKey} data-month={monthKey}>
              <header className="timeline-month-marker" aria-label={`${year}年${monthNumber}月`}>
                <span>{year}</span>
                <strong>{monthLabel}</strong>
                {exactCount !== undefined ? <p>这个月留下了 <b>{exactCount}</b> 项记录。</p> : null}
              </header>
              <div className="timeline-month-days">
                {daySections.map(([date, items], dayIndex) => <TimelineSection key={date} date={date} assets={items} eager={monthIndex === 0 && dayIndex === 0} selectionMode={selectionMode} selectedIds={selectedIds} onToggleSelection={toggleSelection} />)}
              </div>
            </section>
          })}
        </div>
        {nextCursor && <LoadMore loading={loadingMore} onLoad={() => void loadMore()} />}
      </> : <EmptyState action={<div className="empty-actions"><button className="primary-button" type="button" onClick={() => setUploadOpen(true)}>加入第一项</button><button className="secondary-button" type="button" onClick={() => void seed()}><ArchiveRestore />载入 Mock 馆藏</button></div>} />}
    </div>
  )
}
