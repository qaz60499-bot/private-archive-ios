import { enqueueLocalUpload } from './offline/store'
import { wakeUploadScheduler } from './offline/processor'
import type { MediaType } from '../types'

export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024
export const MOBILE_IMPORT_WINDOW = 8
export const DESKTOP_IMPORT_WINDOW = 24

export interface ImportFilesProgress {
  total: number
  processed: number
  queued: number
  window: number
  windows: number
  phase: 'registering' | 'complete'
}

export interface ImportFilesOptions {
  mobile?: boolean
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
  const batchId = crypto.randomUUID()
  const errors: string[] = []
  const total = selectedFiles.length
  const mobile = options.mobile ?? (typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches)
  const windowSize = mobile ? MOBILE_IMPORT_WINDOW : DESKTOP_IMPORT_WINDOW
  const windows = Math.max(1, Math.ceil(total / windowSize))
  let queued = 0
  let processed = 0
  const report = (phase: ImportFilesProgress['phase'], window: number) => options.onProgress?.({ total, processed, queued, window, windows, phase })

  const persistPayload = !mobile || !online || !navigator.onLine
  report('registering', 1)
  if (persistPayload) void requestPersistentStorage()
  for (let start = 0; start < total; start += windowSize) {
    const windowNumber = Math.floor(start / windowSize) + 1
    const end = Math.min(start + windowSize, total)
    for (let index = start; index < end; index += 1) {
      const file = selectedFiles[index]
      processed += 1
      report('registering', windowNumber)
      if (file.size > MAX_UPLOAD_BYTES) {
        errors.push(`${file.name} 超过 48 MB，当前 Cloud Bot API 版本不支持。`)
      } else {
        try {
          const mediaType: MediaType = file.type.startsWith('image/') ? 'photo' : file.type.startsWith('video/') ? 'video' : 'file'
          await enqueueLocalUpload({ file, batchId, mediaType, persistPayload })
          queued += 1
          report('registering', windowNumber)
          if (online && navigator.onLine) void wakeUploadScheduler('import-window')
        } catch (error) {
          errors.push(`${file.name}：${error instanceof Error ? error.message : '无法加入上传队列'}`)
        }
      }
    }

    if (online && navigator.onLine) void wakeUploadScheduler('import-window-ready')
    if (end < total) await yieldToBrowser()
  }

  const lastWindow = Math.min(windows, Math.floor(Math.max(0, processed - 1) / windowSize) + 1)
  report('complete', lastWindow)
  return { batchId, queued, processed, total, errors }
}
