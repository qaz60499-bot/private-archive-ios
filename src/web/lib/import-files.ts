import { enqueueLocalUpload } from './offline/store'
import { wakeUploadScheduler } from './offline/processor'
import {
  beginIosBackgroundUploadStaging,
  canUseIosBackgroundUpload,
  endIosBackgroundUploadStaging,
  enqueueIosBackgroundUpload,
} from './native-background-upload'
import type { MediaType, StorageBackend } from '../types'

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024
export const MOBILE_IMPORT_WINDOW = 8
export const DESKTOP_IMPORT_WINDOW = 24
export const IOS_NATIVE_STAGING_CONCURRENCY = 3

export interface ImportFilesProgress {
  batchId: string
  total: number
  processed: number
  queued: number
  window: number
  windows: number
  phase: 'registering' | 'complete'
}

export interface ImportFilesOptions {
  mobile?: boolean
  batchId?: string
  storageBackend?: StorageBackend
  onProgress?: (progress: ImportFilesProgress) => void
}

export interface ImportFilesResult {
  batchId: string
  queued: number
  processed: number
  total: number
  errors: string[]
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => globalThis.setTimeout(resolve, 0))
    else globalThis.setTimeout(resolve, 0)
  })
}

async function requestPersistentStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.()
  } catch {
    // Best effort only. Per-file quota errors remain visible to the user.
  }
}

export async function importFiles(files: FileList | File[], online: boolean, options: ImportFilesOptions = {}): Promise<ImportFilesResult> {
  const selectedFiles = Array.from(files)
  const batchId = options.batchId ?? crypto.randomUUID()
  const errors: string[] = []
  const total = selectedFiles.length
  const mobile = options.mobile ?? (typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches)
  const storageBackend = options.storageBackend ?? 'telegram_user_group'
  const windowSize = mobile ? MOBILE_IMPORT_WINDOW : DESKTOP_IMPORT_WINDOW
  const windows = Math.max(1, Math.ceil(total / windowSize))
  let queued = 0
  let processed = 0
  const report = (phase: ImportFilesProgress['phase'], window: number) => options.onProgress?.({ batchId, total, processed, queued, window, windows, phase })

  // Always persist the original to durable storage (OPFS, else an IndexedDB blob).
  // Mobile browsers evict in-memory File handles aggressively when the page is
  // backgrounded during the system photo picker, so a transient payload was the root
  // cause of "mobile upload basically unusable" — the queued job survived but its bytes
  // did not. The store releases each payload as soon as its upload completes, and surfaces
  // quota errors per-file, so durable persistence is the safe default on every device.
  const persistPayload = true
  const iosBackgroundUpload = canUseIosBackgroundUpload(storageBackend)
  report('registering', 1)
  if (persistPayload) void requestPersistentStorage()

  const processFile = async (index: number, windowNumber: number): Promise<void> => {
    const file = selectedFiles[index]
    processed += 1
    report('registering', windowNumber)
    if (storageBackend === 'telegram_bot' && file.size > MAX_UPLOAD_BYTES) {
      errors.push(`${file.name} 超过 Bot 存储安全处理范围，请切换到“Telegram 私人群组”。不会自动回退到 Bot。`)
      return
    }
    try {
      const mediaType: MediaType = file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'file'
      if (iosBackgroundUpload) {
        await enqueueIosBackgroundUpload({ file, batchId, mediaType, storageBackend })
      } else {
        await enqueueLocalUpload({ file, batchId, mediaType, persistPayload, storageBackend })
      }
      queued += 1
      report('registering', windowNumber)
      if (online && navigator.onLine && !iosBackgroundUpload) void wakeUploadScheduler('import-window')
    } catch (error) {
      errors.push(`${file.name}：${error instanceof Error ? error.message : '无法加入上传队列'}`)
    }
  }

  if (iosBackgroundUpload) await beginIosBackgroundUploadStaging()
  try {
    for (let start = 0; start < total; start += windowSize) {
      const windowNumber = Math.floor(start / windowSize) + 1
      const end = Math.min(start + windowSize, total)
      if (iosBackgroundUpload) {
        for (let groupStart = start; groupStart < end; groupStart += IOS_NATIVE_STAGING_CONCURRENCY) {
          const groupEnd = Math.min(end, groupStart + IOS_NATIVE_STAGING_CONCURRENCY)
          await Promise.all(Array.from({ length: groupEnd - groupStart }, (_, offset) => processFile(groupStart + offset, windowNumber)))
          if (groupEnd < end) await yieldToBrowser()
        }
      } else {
        for (let index = start; index < end; index += 1) await processFile(index, windowNumber)
      }

      if (online && navigator.onLine && !iosBackgroundUpload) void wakeUploadScheduler('import-window-ready')
      if (end < total) await yieldToBrowser()
    }
  } finally {
    if (iosBackgroundUpload) await endIosBackgroundUploadStaging()
  }

  const lastWindow = Math.min(windows, Math.floor(Math.max(0, processed - 1) / windowSize) + 1)
  report('complete', lastWindow)
  return { batchId, queued, processed, total, errors }
}
