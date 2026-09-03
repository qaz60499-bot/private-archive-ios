import type { LocalUploadJob } from '../../types'

export interface UploadBatchSummary {
  id: string
  createdAt: string
  total: number
  completed: number
  preparing: number
  uploading: number
  waiting: number
  paused: number
  failed: number
  canceled: number
  dedupChecked: number
  deduplicated: number
  progress: number
  jobs: LocalUploadJob[]
}

export function summarizeUploadBatches(jobs: LocalUploadJob[]): UploadBatchSummary[] {
  const groups = new Map<string, LocalUploadJob[]>()
  for (const job of jobs) groups.set(job.batchId, [...(groups.get(job.batchId) ?? []), job])
  return [...groups.entries()].map(([id, items]) => {
    const completed = items.filter((job) => job.status === 'done').length
    const canceled = items.filter((job) => job.controlState === 'canceled').length
    return {
      id,
      createdAt: items.reduce((earliest, job) => job.createdAt < earliest ? job.createdAt : earliest, items[0].createdAt),
      total: items.length,
      completed,
      preparing: items.filter((job) => job.prepareStatus === 'preparing').length,
      uploading: items.filter((job) => ['uploading', 'retrying'].includes(job.status) && job.controlState === 'active').length,
      waiting: items.filter((job) => job.status === 'waiting' && job.prepareStatus !== 'preparing').length,
      paused: items.filter((job) => job.controlState === 'paused').length,
      failed: items.filter((job) => job.status === 'failed' && job.controlState !== 'canceled').length,
      canceled,
      dedupChecked: items.filter((job) => ['original', 'completed'].includes(job.stage)).length,
      deduplicated: items.filter((job) => job.deduplicated).length,
      progress: items.length ? Math.round(((completed + canceled) / items.length) * 100) : 0,
      jobs: [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    }
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
