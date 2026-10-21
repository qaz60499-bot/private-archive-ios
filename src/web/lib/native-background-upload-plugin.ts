import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { LocalUploadJob, LocalUploadStage, LocalUploadStatus, MediaType } from '../types'
import { getLocalUploadPrincipal } from './offline/store'

export interface NativeBackgroundUploadJob {
  id: string
  principalId?: string
  batchId?: string
  fileName: string
  mimeType: string
  sizeBytes: number
  mediaType: MediaType
  status: LocalUploadStatus
  stage: LocalUploadStage
  progress: number
  attempts: number
  error?: string
  remoteAssetId?: string
  deduplicated?: boolean
  createdAt: string
  updatedAt: string
}

interface NativeBackgroundUploadPlugin {
  setPrincipal(options: { principalId: string | null }): Promise<void>
  adoptLegacyJobs(options: { principalId: string; ids: string[] }): Promise<void>
  createJob(options: {
    id: string
    principalId: string
    batchId?: string
    fileName: string
    mimeType: string
    sizeBytes: number
    mediaType: MediaType
    lastModifiedMs?: number
  }): Promise<void>
  appendChunk(options: { id: string; principalId: string; base64: string }): Promise<void>
  finishJob(options: { id: string; principalId: string }): Promise<{ job: NativeBackgroundUploadJob }>
  beginStagingProtection(): Promise<void>
  endStagingProtection(): Promise<void>
  listJobs(options: { principalId: string }): Promise<{ items: NativeBackgroundUploadJob[]; quarantinedCount?: number }>
  pauseJob(options: { id: string; principalId: string }): Promise<void>
  resumeJob(options: {
    id: string
    principalId: string
    fileName?: string
    mimeType?: string
    sizeBytes?: number
    mediaType?: MediaType
    contentHash?: string
  }): Promise<void>
  cancelJob(options: { id: string; principalId: string }): Promise<void>
  removeJob(options: { id: string; principalId: string }): Promise<void>
  pickPhotos(options: { batchId: string; principalId: string }): Promise<{ batchId: string; count: number }>
  addListener(eventName: 'stateChanged', listener: (event: { job: NativeBackgroundUploadJob }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'pickerError', listener: (event: { batchId: string; principalId?: string; jobId?: string; message: string }) => void): Promise<PluginListenerHandle>
}

export const NativeBackgroundUpload = registerPlugin<NativeBackgroundUploadPlugin>('NativeBackgroundUpload')

export function requireUploadPrincipal(): string {
  const principalId = getLocalUploadPrincipal()
  if (!principalId) throw new Error('UPLOAD_ACCOUNT_REQUIRED')
  return principalId
}

export async function pauseNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.pauseJob({ id, principalId: requireUploadPrincipal() })
}

export async function resumeNativeBackgroundTransfer(job: LocalUploadJob): Promise<void> {
  const principalId = requireUploadPrincipal()
  if (job.principalId !== principalId) throw new Error('UPLOAD_ACCOUNT_CHANGED')
  await NativeBackgroundUpload.resumeJob({
    id: job.id,
    principalId,
    fileName: job.fileName,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    mediaType: job.mediaType,
    contentHash: job.contentHash,
  })
}

export async function cancelNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.cancelJob({ id, principalId: requireUploadPrincipal() })
}

export async function removeNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.removeJob({ id, principalId: requireUploadPrincipal() })
}
