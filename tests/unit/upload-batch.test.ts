import { describe, expect, it } from 'vitest'
import { summarizeUploadBatches } from '../../src/web/lib/offline/batch'
import type { LocalUploadJob } from '../../src/web/types'

function job(id: string, patch: Partial<LocalUploadJob> = {}): LocalUploadJob {
  return {
    schemaVersion: 2, id, batchId: 'batch-a', fileName: `${id}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1,
    mediaType: 'photo', storageBackend: 'telegram_user_group', status: 'waiting', prepareStatus: 'pending', controlState: 'active', stage: 'registered',
    progress: 0, attempts: 0, createdAt: '2026-08-12T00:00:00.000Z', updatedAt: '2026-08-12T00:00:00.000Z', metadata: {}, ...patch,
  }
}

describe('upload batch summaries', () => {
  it('aggregates 20 jobs using terminal item progress instead of fake byte progress', () => {
    const jobs = Array.from({ length: 20 }, (_, index) => job(String(index), index < 8
      ? { status: 'done', stage: 'completed', progress: 100, deduplicated: index === 0 }
      : index === 8 ? { status: 'failed', error: 'one failed' }
        : index === 9 ? { status: 'paused', controlState: 'paused' }
          : index === 10 ? { status: 'failed', controlState: 'canceled' }
            : index === 11 ? { prepareStatus: 'preparing', stage: 'preparing' }
              : {}))
    expect(summarizeUploadBatches(jobs)[0]).toMatchObject({
      total: 20, completed: 8, failed: 1, paused: 1, canceled: 1, preparing: 1, deduplicated: 1, progress: 45,
    })
  })

  it('keeps 100 jobs in one stable batch', () => {
    const summary = summarizeUploadBatches(Array.from({ length: 100 }, (_, index) => job(String(index))))[0]
    expect(summary.total).toBe(100)
    expect(summary.jobs).toHaveLength(100)
    expect(summary.progress).toBe(0)
  })
})
