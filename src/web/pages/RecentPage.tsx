import { useCallback, useEffect, useState } from 'react'
import { EmptyState, ErrorState, PageIntro, SkeletonGrid } from '../components/States'
import { MediaGrid } from '../features/timeline/MediaGrid'
import { api } from '../lib/api'
import type { Asset } from '../types'

export function RecentPage() {
  const [kind, setKind] = useState<'added' | 'viewed'>('added')
  const [items, setItems] = useState<Asset[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems((await api.recent(kind, 60)).items)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '最近项目加载失败')
    } finally {
      setLoading(false)
    }
  }, [kind])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  return <div className="page recent-page">
    <PageIntro eyebrow="RECENT · MEMORY" title="最近" description="回到刚刚加入或最近打开过的内容，不需要重新翻找整条时间线。" count={items.length} />
    <div className="recent-tabs" role="tablist" aria-label="最近内容类型"><button className={kind === 'added' ? 'active' : ''} type="button" role="tab" aria-selected={kind === 'added'} onClick={() => setKind('added')}>最近加入</button><button className={kind === 'viewed' ? 'active' : ''} type="button" role="tab" aria-selected={kind === 'viewed'} onClick={() => setKind('viewed')}>最近查看</button></div>
    {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : items.length ? <MediaGrid assets={items} /> : <EmptyState title={kind === 'added' ? '暂无最近加入' : '暂无最近查看'} description={kind === 'added' ? '新上传或导入的内容会出现在这里。' : '打开资产详情后，会记录为最近查看。'} />}
  </div>
}
