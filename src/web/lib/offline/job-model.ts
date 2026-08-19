import type { LocalUploadJob } from '../../types'

export function originalLocalFileLastModified(job: Pick<LocalUploadJob, 'createdAt' | 'metadata'>): number {
  const stored = job.metadata.fileCreatedAt
  const original = typeof stored === 'string' ? Date.parse(stored) : Number.NaN
  const fallback = Date.parse(job.createdAt)
  return Number.isFinite(original) ? original : Number.isFinite(fallback) ? fallback : Date.now()
}

export function normalizeLocalUpload(job: Partial<LocalUploadJob> & Pick<LocalUploadJob, 'id' | 'fileName' | 'mimeType' | 'sizeBytes' | 'mediaType' | 'createdAt' | 'updatedAt' | 'metadata'>): LocalUploadJob {
  const recoveredStatus = job.status === 'uploading' ? 'retrying' : job.status ?? 'waiting'
  const controlState = job.controlState ?? 'active'
  const prepareStatus = job.prepareStatus ?? (Object.keys(job.metadata).length > 0 ? 'ready' : 'pending')
  return {
    ...job,
    schemaVersion: 2,
    batchId: job.batchId ?? `legacy-${job.id}`,
    status: recoveredStatus,
    prepareStatus,
    controlState,
    stage: job.stage ?? (recoveredStatus === 'done' ? 'completed' : prepareStatus === 'ready' ? 'reserving' : 'registered'),
    progress: job.progress ?? 0,
    attempts: job.attempts ?? 0,
    metadata: job.metadata,
  }
}
