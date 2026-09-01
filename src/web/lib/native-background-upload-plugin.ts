import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { LocalUploadStage, LocalUploadStatus, MediaType } from '../types'

export interface NativeBackgroundUploadJob {
  id: string
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
    fileName: string
    mimeType: string
    sizeBytes: number
    mediaType: MediaType
    lastModifiedMs?: number
  }): Promise<void>
  appendChunk(options: { id: string; base64: string }): Promise<void>
  finishJob(options: { id: string }): Promise<{ job: NativeBackgroundUploadJob }>
  listJobs(): Promise<{ items: NativeBackgroundUploadJob[] }>
  pauseJob(options: { id: string }): Promise<void>
  resumeJob(options: { id: string }): Promise<void>
  cancelJob(options: { id: string }): Promise<void>
  removeJob(options: { id: string }): Promise<void>
  addListener(eventName: 'stateChanged', listener: (event: { job: NativeBackgroundUploadJob }) => void): Promise<PluginListenerHandle>
}

export const NativeBackgroundUpload = registerPlugin<NativeBackgroundUploadPlugin>('NativeBackgroundUpload')

export async function pauseNativeBackgroundTransfer(id: string): Promise<void> {
  try { await NativeBackgroundUpload.pauseJob({ id }) } catch { /* web/unsupported fallback */ }
}

export async function resumeNativeBackgroundTransfer(id: string): Promise<void> {
  try { await NativeBackgroundUpload.resumeJob({ id }) } catch { /* web/unsupported fallback */ }
}

export async function cancelNativeBackgroundTransfer(id: string): Promise<void> {
  try { await NativeBackgroundUpload.cancelJob({ id }) } catch { /* web/unsupported fallback */ }
}
