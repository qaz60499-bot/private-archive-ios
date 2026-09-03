import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { LocalUploadJob, LocalUploadStage, LocalUploadStatus, MediaType } from '../types'

export interface NativeBackgroundUploadJob {
  id: string
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
  createJob(options: {
    id: string
    batchId?: string
    fileName: string
    mimeType: string
    sizeBytes: number
    mediaType: MediaType
    lastModifiedMs?: number
  }): Promise<void>
  appendChunk(options: { id: string; base64: string }): Promise<void>
  finishJob(options: { id: string }): Promise<{ job: NativeBackgroundUploadJob }>
  beginStagingProtection(): Promise<void>
  endStagingProtection(): Promise<void>
  listJobs(): Promise<{ items: NativeBackgroundUploadJob[] }>
  pauseJob(options: { id: string }): Promise<void>
  resumeJob(options: {
    id: string
    fileName?: string
    mimeType?: string
    sizeBytes?: number
    mediaType?: MediaType
    contentHash?: string
  }): Promise<void>
  cancelJob(options: { id: string }): Promise<void>
  removeJob(options: { id: string }): Promise<void>
  pickPhotos(options: { batchId: string }): Promise<{ batchId: string; count: number }>
  addListener(eventName: 'stateChanged', listener: (event: { job: NativeBackgroundUploadJob }) => void): Promise<PluginListenerHandle>
  addListener(eventName: 'pickerError', listener: (event: { batchId: string; jobId?: string; message: string }) => void): Promise<PluginListenerHandle>
}

export const NativeBackgroundUpload = registerPlugin<NativeBackgroundUploadPlugin>('NativeBackgroundUpload')

export async function pauseNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.pauseJob({ id })
}

export async function resumeNativeBackgroundTransfer(job: LocalUploadJob): Promise<void> {
  await NativeBackgroundUpload.resumeJob({
    id: job.id,
    fileName: job.fileName,
    mimeType: job.mimeType,
    sizeBytes: job.sizeBytes,
    mediaType: job.mediaType,
    contentHash: job.contentHash,
  })
}

export async function cancelNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.cancelJob({ id })
}

export async function removeNativeBackgroundTransfer(id: string): Promise<void> {
  await NativeBackgroundUpload.removeJob({ id })
}
