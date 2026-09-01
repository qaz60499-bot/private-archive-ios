import { useCallback, useEffect, useState } from 'react'
import { Activity, Archive, FolderPlus, Heart, ImagePlus, LogIn, Move, RotateCcw, Tag, Trash2 } from 'lucide-react'
import { EmptyState, ErrorState, PageIntro, SkeletonGrid } from '../components/States'
import { api } from '../lib/api'
import { assetSourceLabel } from '../lib/asset-display'
import type { ActivityItem } from '../types'

const labels: Record<string, string> = {
  UPLOAD: '上传', IMPORT: '导入', RENAME: '重命名', MOVE: '移动', DELETE: '移入回收站', RESTORE: '恢复', PURGE: '永久删除',
  FAVORITE: '收藏状态', ARCHIVE: '归档状态', TAG: '标签', ALBUM_ADD: '加入相册', ALBUM_REMOVE: '移出相册', SHARE: '分享', LOGIN: '登录',
}

function ActionIcon({ action }: { action: string }) {
  const Icon = action === 'UPLOAD' ? ImagePlus : action === 'IMPORT' ? FolderPlus : action === 'DELETE' || action === 'PURGE' ? Trash2 : action === 'RESTORE' ? RotateCcw : action === 'FAVORITE' ? Heart : action === 'ARCHIVE' ? Archive : action === 'TAG' ? Tag : action === 'MOVE' || action.startsWith('ALBUM_') ? Move : action === 'LOGIN' ? LogIn : Activity
  return <Icon />
}

function detailText(item: ActivityItem): string {
  const source = item.assetSource ? ` · ${assetSourceLabel(item.assetSource)}` : ''
  if (item.assetName) return `${item.assetName}${source}`
  if (!item.detail) return item.albumId ? '相册操作' : '档案操作'
  const detail = item.detail
  if (typeof detail.name === 'string') return detail.name
  if (typeof detail.count === 'number') return `${detail.count} 项`
  if (typeof detail.value === 'boolean') return detail.value ? '已开启' : '已关闭'
  return '已记录'
}

export function ActivityPage() {
  const [items, setItems] = useState<ActivityItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setItems((await api.activity(100)).items)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '活动记录加载失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0)
    return () => window.clearTimeout(timer)
  }, [load])

  return <div className="page activity-page">
    <PageIntro eyebrow="ARCHIVE HISTORY" title="档案记录" description="这里按时间留下导入、收藏、归档、恢复与整理动作，便于回看一项内容经历了什么。" count={items.length} />
    {loading ? <SkeletonGrid /> : error ? <ErrorState message={error} onRetry={() => void load()} /> : items.length ? <ol className="activity-list">{items.map((item) => <li key={item.id}><span className="activity-icon"><ActionIcon action={item.action} /></span><div><strong>{labels[item.action] ?? item.action}</strong><small>{detailText(item)}</small></div><time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString('zh-CN')}</time></li>)}</ol> : <EmptyState title="暂无活动" description="上传、收藏、归档、回收站和相册操作会出现在这里。" />}
  </div>
}
