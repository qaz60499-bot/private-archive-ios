import { Capacitor } from '@capacitor/core'
import type { LocalUploadJob, MediaType, StorageBackend } from '../types'
import { isNativeApp, nativePlatform } from './native-platform'
import { NativeBackgroundUpload, resumeNativeBackgroundTransfer, type NativeBackgroundUploadJob } from './native-background-upload-plugin'
import {
  getLocalUpload,
  getLocalUploadFile,
  listLocalUploads,
  registerNativeLocalUpload,
  releaseLocalUploadPayload,
  updateLocalUpload,
} from './offline/store'

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
  // The Web-side durable copy is a recovery safety net for interrupted native staging.
  // Keep it until the native URLSession has actually completed; only then release the
  // duplicate bytes. This makes force-quit recovery independent of a transient picker
  // File handle while avoiding permanent double storage.
  if (job.status === 'done') await releaseLocalUploadPayload(job.id)
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

async function stageNativeOriginal(options: {
  id: string
  file: File
  mediaType: MediaType
}): Promise<NativeBackgroundUploadJob> {
  await NativeBackgroundUpload.createJob({
    id: options.id,
    fileName: options.file.name,
    mimeType: options.file.type || 'application/octet-stream',
    sizeBytes: options.file.size,
    mediaType: options.mediaType,
    lastModifiedMs: options.file.lastModified || undefined,
  })
  let lastStagingProgress = 0
  for (let offset = 0; offset < options.file.size; offset += NATIVE_CHUNK_BYTES) {
    const bytes = new Uint8Array(await options.file.slice(offset, Math.min(options.file.size, offset + NATIVE_CHUNK_BYTES)).arrayBuffer())
    await NativeBackgroundUpload.appendChunk({ id: options.id, base64: bytesToBase64(bytes) })
    const localProgress = options.file.size ? Math.min(10, Math.round((offset + bytes.byteLength) / options.file.size * 10)) : 10
    if (localProgress > lastStagingProgress) {
      lastStagingProgress = localProgress
      await updateLocalUpload(options.id, { progress: localProgress, status: 'waiting', prepareStatus: 'ready', error: undefined })
    }
  }
  const result = await NativeBackgroundUpload.finishJob({ id: options.id })
  await mirrorNativeJob(result.job)
  return result.job
}

export async function enqueueIosBackgroundUpload(options: {
  file: File
  batchId: string
  mediaType: MediaType
  storageBackend: StorageBackend
}): Promise<void> {
  if (!canUseIosBackgroundUpload(options.storageBackend)) throw new Error('NATIVE_BACKGROUND_UPLOAD_UNAVAILABLE')
  const id = crypto.randomUUID()
  // Persist the complete original in the Web-side recovery store before starting the
  // JS -> Swift chunk bridge. If the process dies halfway through native staging, this
  // durable fallback is what lets startup rebuild the native .upload file automatically.
  await registerNativeLocalUpload({ id, batchId: options.batchId, file: options.file, mediaType: options.mediaType, storageBackend: options.storageBackend })
  try {
    await stageNativeOriginal({ id, file: options.file, mediaType: options.mediaType })
  } catch (error) {
    // Never translate an automatic staging/reservation error into cancelJob: cancelJob
    // intentionally destroys the native original. Preserve both recovery copies so a
    // retry/relaunch can reconstruct the transfer without asking the user to reselect.
    await updateLocalUpload(id, { status: 'failed', prepareStatus: 'failed', error: error instanceof Error ? error.message : 'iOS 后台上传准备失败。' })
    throw error
  }
}

async function restageFromDurableFallback(job: LocalUploadJob): Promise<boolean> {
  const file = await getLocalUploadFile(job)
  if (!file || file.size !== job.sizeBytes) return false
  await updateLocalUpload(job.id, {
    status: 'retrying',
    prepareStatus: 'ready',
    stage: 'registered',
    progress: Math.min(job.progress, 10),
    error: '检测到完整本机恢复副本，正在重建后台上传缓存。',
  })
  // removeJob is intentionally used instead of cancelJob: this is an automatic repair
  // of an incomplete native staging file, not a user cancellation. The Web-side copy
  // remains intact while the native cache is rebuilt under the same job id.
  await NativeBackgroundUpload.removeJob({ id: job.id }).catch(() => undefined)
  await stageNativeOriginal({ id: job.id, file, mediaType: job.mediaType })
  return true
}

export async function syncIosBackgroundUploads(): Promise<void> {
  if (!isNativeApp() || nativePlatform() !== 'ios') return
  try {
    let result = await NativeBackgroundUpload.listJobs()
    await Promise.all(result.items.map(mirrorNativeJob))

    const localJobs = (await listLocalUploads()).filter((job) =>
      job.nativeBackground && job.status !== 'done' && job.controlState !== 'canceled')
    const localById = new Map(localJobs.map((job) => [job.id, job]))
    let nativeById = new Map(result.items.map((job) => [job.id, job]))

    // jobs.json is an index, not the source bytes. If that index was lost but the native
    // <job-id>.upload file survived, rebuild the record from the Web mirror first because
    // that path is cheaper than copying the fallback payload again.
    const missingNative = localJobs.filter((job) => !nativeById.has(job.id))
    const failedNative = result.items.filter((job) => job.status === 'failed' && job.stage !== 'registered' && localById.has(job.id))
    if (missingNative.length || failedNative.length) {
      await Promise.allSettled([
        ...missingNative.map((job) => resumeNativeBackgroundTransfer(job)),
        ...failedNative.map((native) => resumeNativeBackgroundTransfer(localById.get(native.id)!)),
      ])
      result = await NativeBackgroundUpload.listJobs()
      await Promise.all(result.items.map(mirrorNativeJob))
      nativeById = new Map(result.items.map((job) => [job.id, job]))
    }

    // A force-quit during JS -> native staging leaves a partial .upload file that Swift
    // cannot finish by itself. Rebuild those jobs from the complete IndexedDB/OPFS copy.
    // Do this serially to avoid multiplying base64 bridge memory during cold-start repair.
    const needsRestage = localJobs.filter((job) => {
      const native = nativeById.get(job.id)
      return !native || (native.status === 'failed' && native.stage === 'registered')
    })
    if (needsRestage.length) {
      await beginIosBackgroundUploadStaging()
      try {
        for (const job of needsRestage) {
          try { await restageFromDurableFallback(job) } catch { /* preserve fallback and continue repairing siblings */ }
        }
      } finally {
        await endIosBackgroundUploadStaging()
      }
      result = await NativeBackgroundUpload.listJobs()
      await Promise.all(result.items.map(mirrorNativeJob))
    }
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
