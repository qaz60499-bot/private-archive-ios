import type { Asset } from '../types'

const SOURCE_LABELS: Record<string, string> = {
  telegram: 'Telegram',
  web: '网页导入',
  desktop: 'Windows 导入',
  local: '本地导入',
  mock: '测试数据',
}

export function assetSourceLabel(source: Asset['source'] | string): string {
  return SOURCE_LABELS[source] ?? source
}

export function formatArchiveDate(value: string | null | undefined, fallback = '未记录'): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

export function formatArchiveDay(value: string | null | undefined, fallback = '—'): string {
  if (!value) return fallback
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return fallback
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB'
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
}

export function assetKindLabel(asset: Pick<Asset, 'mediaType' | 'fileCategory' | 'extension'>): string {
  if (asset.mediaType === 'photo') return '照片'
  if (asset.mediaType === 'video') return '视频'
  if (asset.extension) return asset.extension.toUpperCase()
  return asset.fileCategory === 'other' ? '文件' : asset.fileCategory
}
