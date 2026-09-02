import { Capacitor } from '@capacitor/core'
import type { MediaType, StorageBackend } from '../types'
import { isNativeApp, nativePlatform } from './native-platform'
import { NativeBackgroundUpload, type NativeBackgroundUploadJob } from './native-background-upload-plugin'
import { getLocalUpload, registerNativeLocalUpload, updateLocalUpload } from './offline/store'

const NATIVE_CHUNK_BYTES = 2 * 1024 * 1024
let listenerReady = false

export function canUseIosBackgroundUpload(storageBackend: StorageBackend): boolean {
  return storageBackend === 'telegram_bot'
    && isNativeApp()
    && nativePlatform() === 'ios'
    && Capacitor.isPluginAvailable('NativeBackgroundUpload')
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let offset = 0; offset < bytes.length; offset += step) {
    binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + step)))
  }
  return btoa(binary)
}

async function mirrorNativeJob(job: NativeBackgroundUploadJob): Promise<void> {
  const local = await getLocalUpload(job.id)
  if (!local?.nativeBackground) return
  await updateLocalUpload(job.id, {
    status: job.status,
    stage: job.stage,
    progress: Math.max(0, Math.min(100, Math.round(job.progress))),
    attempts: job.attempts,
    error: job.error,
    remoteAssetId: job.remoteAssetId,
    deduplicated: job.deduplicated,
    prepareStatus: job.status === 'failed' ? 'failed' : 'ready',
    uploadToken: undefined,
    nextAttemptAt: undefined,
  })
  globalThis.dispatchEvent(new Event('private-archive:native-upload-state'))
}

export async function beginIosBackgroundUploadStaging(): Promise<void> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return
  try { await NativeBackgroundUpload.beginStagingProtection() } catch { /* old native shell: continue without the grace period */ }
}

export async function endIosBackgroundUploadStaging(): Promise<void> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return
  try { await NativeBackgroundUpload.endStagingProtection() } catch { /* old native shell */ }
}

export async function enqueueIosBackgroundUpload(options: {
  file: File
  batchId: string
  mediaType: MediaType
  storageBackend: StorageBackend
}): Promise<void> {
  if (!canUseIosBackgroundUpload(options.storageBackend)) throw new Error('NATIVE_BACKGROUND_UPLOAD_UNAVAILABLE')
  const id = crypto.randomUUID()
  await registerNativeLocalUpload({ id, batchId: options.batchId, file: options.file, mediaType: options.mediaType, storageBackend: options.storageBackend })
  try {
    await NativeBackgroundUpload.createJob({
      id,
      fileName: options.file.name,
      mimeType: options.file.type || 'application/octet-stream',
      sizeBytes: options.file.size,
      mediaType: options.mediaType,
      lastModifiedMs: options.file.lastModified || undefined,
    })
    let lastStagingProgress = 0
    for (let offset = 0; offset < options.file.size; offset += NATIVE_CHUNK_BYTES) {
      const bytes = new Uint8Array(await options.file.slice(offset, Math.min(options.file.size, offset + NATIVE_CHUNK_BYTES)).arrayBuffer())
      await NativeBackgroundUpload.appendChunk({ id, base64: bytesToBase64(bytes) })
      const localProgress = options.file.size ? Math.min(10, Math.round((offset + bytes.byteLength) / options.file.size * 10)) : 10
      if (localProgress > lastStagingProgress) {
        lastStagingProgress = localProgress
        await updateLocalUpload(id, { progress: localProgress })
      }
    }
    const result = await NativeBackgroundUpload.finishJob({ id })
    await mirrorNativeJob(result.job)
  } catch (error) {
    try { await NativeBackgroundUpload.cancelJob({ id }) } catch { /* keep the local failure visible */ }
    await updateLocalUpload(id, { status: 'failed', prepareStatus: 'failed', error: error instanceof Error ? error.message : 'iOS 后台上传准备失败。' })
    throw error
  }
}

export async function syncIosBackgroundUploads(): Promise<void> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return
  try {
    const result = await NativeBackgroundUpload.listJobs()
    await Promise.all(result.items.map(mirrorNativeJob))
  } catch {
    // Older builds without the plugin keep using the foreground scheduler.
  }
}

export async function initializeIosBackgroundUploadSync(): Promise<void> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return
  await syncIosBackgroundUploads()
  if (listenerReady) return
  listenerReady = true
  try {
    await NativeBackgroundUpload.addListener('stateChanged', ({ job }) => { void mirrorNativeJob(job) })
  } catch {
    listenerReady = false
  }
}
