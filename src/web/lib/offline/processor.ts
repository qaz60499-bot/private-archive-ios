import { ApiError, api } from '../api'
import { sha256File } from '../file-hash'
import { prepareMedia } from '../preview/media-metadata'
import { telegramUserGroupBridge } from '../telegram-user-group'
import {
  getLocalUpload, getLocalUploadFile, getLocalUploadPreview, listLocalUploads, releaseLocalUploadPayload, removeLocalUpload, storeLocalUploadPreview, updateLocalUpload,
} from './store'
import type { LocalUploadJob } from '../../types'
import { calculateRetryDelay, friendlyUploadError, getUploadSchedulerLimits as policyLimits } from './scheduler-policy'
import { cancelNativeBackgroundTransfer, pauseNativeBackgroundTransfer, resumeNativeBackgroundTransfer } from '../native-background-upload-plugin'

export { calculateRetryDelay, friendlyUploadError } from './scheduler-policy'

const activePrepare = new Map<string, AbortController>()
const activeUpload = new Map<string, AbortController>()
const activeUploadContentHashes = new Map<string, string>()
const subscribers = new Set<() => void>()
let schedulerPromise: Promise<void> | null = null
let scheduledTimer: ReturnType<typeof globalThis.setTimeout> | undefined
let throttledUntil = 0

export function getUploadSchedulerLimits(mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches) {
  const connection = (navigator as Navigator & { connection?: { effectiveType?: string; saveData?: boolean; downlink?: number } }).connection
  const weakConnection = Boolean(connection?.saveData || ['slow-2g', '2g'].includes(connection?.effectiveType ?? '') || connection?.downlink !== undefined && connection.downlink < 1.5)
  const constrained = weakConnection || Date.now() < throttledUntil
  return policyLimits(mobile, constrained)
}

export function subscribeUploadScheduler(listener: () => void): () => void {
  subscribers.add(listener)
  return () => subscribers.delete(listener)
}

function notify(): void {
  subscribers.forEach((listener) => listener())
}

function isTransient(error: unknown): boolean {
  return error instanceof ApiError && ['NETWORK_OFFLINE', 'ACCESS_OR_NETWORK_FAILED', 'REQUEST_TIMEOUT', 'DUPLICATE_UPLOAD_IN_PROGRESS', 'UPLOAD_ALREADY_IN_PROGRESS'].includes(error.code)
    || error instanceof ApiError && [429, 502, 503, 504].includes(error.status)
}

async function prepareLocalUpload(job: LocalUploadJob): Promise<void> {
  if (activePrepare.has(job.id)) return
  const controller = new AbortController()
  activePrepare.set(job.id, controller)
  try {
    const file = await getLocalUploadFile(job)
    if (!file) throw new Error(job.transientPayload ? '手机快速上传的原件已因页面刷新或关闭而释放，请重新选择该文件。' : '本地文件副本不可用，请移除后重新选择原文件。')
    await updateLocalUpload(job.id, { prepareStatus: 'preparing', stage: 'preparing', progress: 5, error: undefined })
    notify()
    const [prepared, contentHash] = await Promise.all([prepareMedia(file), sha256File(file)])
    if (controller.signal.aborted) return
    const previewStored = await storeLocalUploadPreview(job.id, prepared.preview)
    await updateLocalUpload(job.id, {
      prepareStatus: 'ready', stage: 'reserving', progress: 15, previewBlob: undefined, previewStored: previewStored || undefined,
      contentHash, metadata: { ...prepared.metadata, contentHash, storageBackend: job.storageBackend, importOrigin: 'web' }, error: undefined,
    })
  } catch (error) {
    if (!controller.signal.aborted) await updateLocalUpload(job.id, { prepareStatus: 'failed', status: 'failed', error: friendlyUploadError(error) })
  } finally {
    activePrepare.delete(job.id)
    notify()
    void wakeUploadScheduler('prepare-finished')
  }
}

async function processLocalUploadById(id: string, expectedContentHash?: string): Promise<boolean> {
  if (activeUpload.has(id)) return false
  const controller = new AbortController()
  activeUpload.set(id, controller)
  if (expectedContentHash) activeUploadContentHashes.set(id, expectedContentHash)
  let job: LocalUploadJob | undefined
  try {
    job = await getLocalUpload(id)
  } catch (error) {
    activeUpload.delete(id)
    activeUploadContentHashes.delete(id)
    throw error
  }
  if (!job || job.controlState !== 'active' || job.prepareStatus !== 'ready') {
    activeUpload.delete(id)
    activeUploadContentHashes.delete(id)
    return false
  }
  const contentHash = expectedContentHash ?? job.contentHash
  if (contentHash) {
    const sameHashAlreadyActive = [...activeUploadContentHashes].some(([activeId, hash]) => activeId !== id && hash === contentHash)
    if (sameHashAlreadyActive) {
      activeUpload.delete(id)
      activeUploadContentHashes.delete(id)
      return false
    }
    activeUploadContentHashes.set(id, contentHash)
  }
  let assetId = job.remoteAssetId
  let uploadToken = job.uploadToken
  try {
    if (!navigator.onLine) throw new ApiError(0, 'NETWORK_OFFLINE')
    const file = await getLocalUploadFile(job)
    if (!file) throw new Error(job.transientPayload ? '手机快速上传的原件已因页面刷新或关闭而释放，请重新选择该文件。' : '本地文件副本不可用，请移除后重新选择原文件。')
    await updateLocalUpload(id, {
      status: job.attempts ? 'retrying' : 'uploading', stage: 'reserving', progress: Math.max(job.progress, 18),
      attempts: job.attempts + 1, lastAttemptAt: new Date().toISOString(), nextAttemptAt: undefined, retryAfterMs: undefined, error: undefined,
    })
    notify()

    const reserve = async (force = false): Promise<'ready' | 'duplicate'> => {
      if (!force && assetId && uploadToken) return 'ready'
      const reservation = await api.reserve(job.metadata, controller.signal)
      if (reservation.duplicate) {
        await updateLocalUpload(id, {
          status: 'done', stage: 'completed', progress: 100, deduplicated: true,
          duplicateOfAssetId: reservation.duplicateOfAssetId ?? reservation.assetId,
          remoteAssetId: reservation.assetId, uploadToken: undefined, error: undefined,
        })
        await releaseLocalUploadPayload(id)
        return 'duplicate'
      }
      if (!reservation.uploadToken) throw new Error('上传服务没有返回凭证。')
      assetId = reservation.assetId
      uploadToken = reservation.uploadToken
      await updateLocalUpload(id, { remoteAssetId: assetId, uploadToken, progress: 28 })
      return 'ready'
    }

    if (await reserve() === 'duplicate') return true

    const withFreshToken = async (operation: () => Promise<unknown>): Promise<boolean> => {
      try {
        await operation()
      } catch (error) {
        if (error instanceof ApiError && error.code === 'UPLOAD_TOKEN_INVALID_OR_EXPIRED') {
          if (await reserve(true) === 'duplicate') return false
          await operation()
          return true
        }
        throw error
      }
      return true
    }

    await updateLocalUpload(id, { stage: 'original', progress: 48 })
    if (job.storageBackend === 'telegram_user_group') {
      if (!contentHash) throw new Error('上传前未生成内容指纹。')
      const receiptAssetId = assetId as string
      const receipt = await telegramUserGroupBridge.upload(receiptAssetId, uploadToken as string, file, contentHash, controller.signal)
      await updateLocalUpload(id, { progress: 82 })
      try {
        await api.commitUserGroupUpload(receiptAssetId, uploadToken as string, receipt)
      } catch (error) {
        if (!(error instanceof ApiError && error.code === 'UPLOAD_TOKEN_INVALID_OR_EXPIRED')) throw error
        if (await reserve(true) === 'duplicate') return true
        if (assetId !== receiptAssetId) throw new Error('Telegram 已上传，但远端预约发生变化；已停止自动重试以避免错绑文件。', { cause: error })
        await api.commitUserGroupUpload(receiptAssetId, uploadToken as string, receipt)
      }
      await updateLocalUpload(id, { progress: 92, previewUploaded: ['photo', 'video'].includes(job.mediaType) || undefined })
    } else {
      // Legacy/optional Bot storage keeps the existing Worker streaming path. It is
      // never used as an automatic fallback from User Group storage.
      let contentResult: Awaited<ReturnType<typeof api.uploadContent>> | undefined
      if (!await withFreshToken(async () => {
        contentResult = await api.uploadContent(assetId as string, uploadToken as string, file, controller.signal)
      })) return true

      if (contentResult?.previewAvailable) {
        await updateLocalUpload(id, { previewUploaded: true, progress: 82 })
      } else if (job.mediaType !== 'photo') {
        const preview = !job.previewUploaded ? await getLocalUploadPreview(job) : null
        if (preview) {
          await updateLocalUpload(id, { stage: 'preview', progress: 78 })
          if (!await withFreshToken(() => api.uploadPreview(assetId as string, uploadToken as string, preview, controller.signal))) return true
          await updateLocalUpload(id, { previewUploaded: true, progress: 88 })
        }
      }
    }

    await updateLocalUpload(id, { status: 'done', stage: 'completed', progress: 100, error: undefined, uploadToken: undefined, nextAttemptAt: undefined })
    await releaseLocalUploadPayload(id)
    return true
  } catch (error) {
    const latest = await getLocalUpload(id)
    if (latest?.controlState === 'paused' || latest?.controlState === 'canceled') return false
    const transient = isTransient(error)
    const retryAfter = error instanceof ApiError ? error.retryAfterMs : undefined
    const delay = transient ? calculateRetryDelay((latest?.attempts ?? job.attempts) + 1, retryAfter) : undefined
    if (error instanceof ApiError && (error.status === 429 || error.status === 0 || error.code === 'REQUEST_TIMEOUT')) {
      throttledUntil = Math.max(throttledUntil, Date.now() + (delay ?? 30_000))
    }
    await updateLocalUpload(id, {
      status: transient ? navigator.onLine ? 'retrying' : 'paused' : 'failed',
      controlState: 'active', error: friendlyUploadError(error), remoteAssetId: assetId, uploadToken,
      retryAfterMs: retryAfter, nextAttemptAt: delay ? new Date(Date.now() + delay).toISOString() : undefined,
    })
    return false
  } finally {
    activeUpload.delete(id)
    activeUploadContentHashes.delete(id)
    notify()
    void wakeUploadScheduler('upload-finished')
  }
}

export async function processLocalUpload(job: LocalUploadJob): Promise<boolean> {
  return processLocalUploadById(job.id, job.contentHash)
}

function due(job: LocalUploadJob): boolean {
  return !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= Date.now()
}

async function runSchedulerPass(): Promise<void> {
  if (!navigator.onLine) return
  const jobs = await listLocalUploads()
  const limits = getUploadSchedulerLimits()
  const eligible = jobs.filter((job) => !job.nativeBackground && job.controlState === 'active' && !['done', 'failed'].includes(job.status) && due(job))
  const prepareSlots = Math.max(0, limits.prepare - activePrepare.size)
  const preparing = eligible.filter((job) => job.prepareStatus === 'pending' && !activePrepare.has(job.id)).slice(0, prepareSlots)
  preparing.forEach((job) => void prepareLocalUpload(job))

  const uploadSlots = Math.max(0, limits.upload - activeUpload.size)
  const jobsById = new Map(jobs.map((job) => [job.id, job]))
  const activeVideos = [...activeUpload.keys()].filter((id) => jobsById.get(id)?.mediaType === 'video').length
  const activeContentHashes = new Set(activeUploadContentHashes.values())
  let videoSlots = Math.max(0, limits.video - activeVideos)
  const ready: LocalUploadJob[] = []
  for (const job of eligible.filter((item) => item.prepareStatus === 'ready' && !activeUpload.has(item.id))) {
    if (ready.length >= uploadSlots) break
    if (job.contentHash && activeContentHashes.has(job.contentHash)) continue
    if (job.mediaType === 'video') {
      if (!videoSlots) continue
      videoSlots -= 1
    }
    ready.push(job)
    if (job.contentHash) activeContentHashes.add(job.contentHash)
  }
  ready.forEach((job) => void processLocalUploadById(job.id, job.contentHash))

  const next = jobs
    .filter((job) => job.controlState === 'active' && job.nextAttemptAt && job.status !== 'done')
    .map((job) => Date.parse(job.nextAttemptAt as string))
    .filter((time) => time > Date.now())
    .sort((a, b) => a - b)[0]
  if (next) {
    if (scheduledTimer) globalThis.clearTimeout(scheduledTimer)
    scheduledTimer = globalThis.setTimeout(() => void wakeUploadScheduler('retry-due'), Math.max(1, next - Date.now()))
  }
}

export function wakeUploadScheduler(_reason = 'manual'): Promise<void> {
  void _reason
  if (!schedulerPromise) schedulerPromise = runSchedulerPass().finally(() => { schedulerPromise = null })
  return schedulerPromise
}

export function resumePendingUploads(): Promise<void> {
  return wakeUploadScheduler('legacy-resume')
}

export async function pauseLocalUpload(id: string): Promise<void> {
  const job = await getLocalUpload(id)
  if (job?.nativeBackground) await pauseNativeBackgroundTransfer(id)
  await updateLocalUpload(id, {
    controlState: 'paused', status: 'paused', error: '已暂停，原件仍安全保存在本机。',
    prepareStatus: job?.prepareStatus === 'preparing' ? 'pending' : job?.prepareStatus,
    stage: job?.prepareStatus === 'preparing' ? 'registered' : job?.stage,
  })
  activePrepare.get(id)?.abort()
  activeUpload.get(id)?.abort()
  notify()
}

export async function resumeLocalUpload(id: string): Promise<void> {
  const job = await getLocalUpload(id)
  if (job?.nativeBackground) {
    try {
      await resumeNativeBackgroundTransfer(id)
    } catch (error) {
      await updateLocalUpload(id, {
        controlState: 'active', status: 'failed', nextAttemptAt: undefined,
        error: error instanceof Error ? error.message : '后台上传无法恢复，请重新选择原文件。',
      })
      notify()
      return
    }
  }
  await updateLocalUpload(id, {
    controlState: 'active', status: 'retrying', nextAttemptAt: undefined, error: undefined,
    prepareStatus: job?.prepareStatus === 'failed' ? 'pending' : job?.prepareStatus,
  })
  notify()
  if (!job?.nativeBackground) await wakeUploadScheduler('resume-job')
}

export async function cancelLocalUpload(id: string): Promise<void> {
  const job = await getLocalUpload(id)
  if (job?.nativeBackground) await cancelNativeBackgroundTransfer(id)
  await updateLocalUpload(id, { controlState: 'canceled', status: 'failed', error: '已取消，本机临时原件已释放。', nextAttemptAt: undefined })
  activePrepare.get(id)?.abort()
  activeUpload.get(id)?.abort()
  await releaseLocalUploadPayload(id)
  notify()
}

export async function pauseUploadBatch(batchId: string): Promise<void> {
  const jobs = (await listLocalUploads()).filter((job) => job.batchId === batchId && job.status !== 'done' && job.controlState !== 'canceled')
  await Promise.all(jobs.map((job) => pauseLocalUpload(job.id)))
}

export async function resumeUploadBatch(batchId: string): Promise<void> {
  const jobs = (await listLocalUploads()).filter((job) => job.batchId === batchId && job.status !== 'done' && job.controlState !== 'canceled')
  await Promise.allSettled(jobs.map((job) => resumeLocalUpload(job.id)))
}

export async function retryFailedUploadBatch(batchId: string): Promise<void> {
  const jobs = (await listLocalUploads()).filter((job) => job.batchId === batchId && job.status === 'failed' && job.controlState !== 'canceled')
  await Promise.allSettled(jobs.map((job) => resumeLocalUpload(job.id)))
}

export async function cancelUploadBatch(batchId: string): Promise<void> {
  const jobs = (await listLocalUploads()).filter((job) => job.batchId === batchId && job.status !== 'done' && job.controlState !== 'canceled')
  await Promise.all(jobs.map((job) => cancelLocalUpload(job.id)))
}

export async function deleteUploadBatch(batchId: string): Promise<void> {
  const jobs = (await listLocalUploads()).filter((job) => job.batchId === batchId)
  if (!jobs.length) return
  const unfinished = jobs.filter((job) => job.status !== 'done' && job.controlState !== 'canceled')
  await Promise.allSettled(unfinished.map((job) => cancelLocalUpload(job.id)))

  // A canceled upload may already have created a server reservation. Clean up only
  // reservations that are still unstored; the server endpoint refuses to touch any
  // asset that won a race and actually reached Telegram.
  const orphanReservationIds = [...new Set(jobs
    .filter((job) => job.status !== 'done' && job.remoteAssetId)
    .map((job) => job.remoteAssetId as string))]
  if (orphanReservationIds.length && navigator.onLine) {
    await api.discardUnstoredAssets(orphanReservationIds).catch(() => undefined)
  }

  await Promise.all(jobs.map((job) => removeLocalUpload(job.id)))
  notify()
}

