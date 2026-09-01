import { openDB, type DBSchema } from 'idb'
import type { LocalUploadJob, StorageBackend } from '../../types'
import { normalizeLocalUpload, originalLocalFileLastModified } from './job-model'

export { normalizeLocalUpload } from './job-model'

interface PersistedUploadPayload {
  key: string
  bytes: ArrayBuffer
  mimeType: string
}

interface ArchiveOfflineDb extends DBSchema {
  uploads: {
    key: string
    value: LocalUploadJob
    indexes: { 'by-status': string; 'by-updated': string; 'by-batch': string; 'by-next-attempt': string }
  }
  payloads: {
    key: string
    value: PersistedUploadPayload
  }
}

const dbPromise = openDB<ArchiveOfflineDb>('private-archive-offline', 3, {
  upgrade(database, oldVersion, _newVersion, transaction) {
    const store = oldVersion < 1
      ? database.createObjectStore('uploads', { keyPath: 'id' })
      : transaction.objectStore('uploads')
    if (oldVersion < 1) {
      store.createIndex('by-status', 'status')
      store.createIndex('by-updated', 'updatedAt')
    }
    if (!store.indexNames.contains('by-batch')) store.createIndex('by-batch', 'batchId')
    if (!store.indexNames.contains('by-next-attempt')) store.createIndex('by-next-attempt', 'nextAttemptAt')
    if (!database.objectStoreNames.contains('payloads')) database.createObjectStore('payloads', { keyPath: 'key' })
  },
})

async function persistNormalization(jobs: LocalUploadJob[]): Promise<void> {
  const database = await dbPromise
  const transaction = database.transaction('uploads', 'readwrite')
  await Promise.all(jobs.map((job) => transaction.store.put(job)))
  await transaction.done
}

const OPFS_WRITE_TIMEOUT_MS = 15_000
const INDEXEDDB_PAYLOAD_FALLBACK_MAX_BYTES = 64 * 1024 * 1024
const transientPayloads = new Map<string, File>()
let activePrincipalId: string | null = null
let adoptLegacyUploads = false

type PayloadKind = 'original' | 'preview'

export function setLocalUploadPrincipal(principalId: string | null, options: { adoptLegacy?: boolean } = {}): void {
  activePrincipalId = principalId
  adoptLegacyUploads = Boolean(principalId && options.adoptLegacy)
}

function visibleToActivePrincipal(job: LocalUploadJob): boolean {
  if (!activePrincipalId) return false
  return job.principalId === activePrincipalId || (!job.principalId && adoptLegacyUploads)
}

function payloadKey(id: string, kind: PayloadKind): string {
  return `${id}:${kind}`
}

async function persistPayloadBytes(id: string, kind: PayloadKind, blob: Blob): Promise<void> {
  const bytes = await blob.arrayBuffer()
  await (await dbPromise).put('payloads', { key: payloadKey(id, kind), bytes, mimeType: blob.type || 'application/octet-stream' })
}

async function readPayload(id: string, kind: PayloadKind): Promise<PersistedUploadPayload | undefined> {
  return (await dbPromise).get('payloads', payloadKey(id, kind))
}

async function removePayloads(id: string): Promise<void> {
  const database = await dbPromise
  const transaction = database.transaction('payloads', 'readwrite')
  await Promise.all([
    transaction.store.delete(payloadKey(id, 'original')),
    transaction.store.delete(payloadKey(id, 'preview')),
  ])
  await transaction.done
}

function shouldUseOpfs(): boolean {
  const ua = navigator.userAgent ?? ''
  const touchPoints = navigator.maxTouchPoints ?? 0
  const appleMobile = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && touchPoints > 1)
  return !appleMobile && typeof navigator.storage?.getDirectory === 'function'
}

async function writeToOpfs(id: string, file: File): Promise<string | undefined> {
  if (!shouldUseOpfs()) return undefined
  const path = `${id}.upload`
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('private-archive-uploads', { create: true })
    const handle = await directory.getFileHandle(path, { create: true })
    const writable = await handle.createWritable()
    await Promise.race([
      (async () => {
        await writable.write(file)
        await writable.close()
      })(),
      new Promise<never>((_, reject) => {
        timeout = globalThis.setTimeout(() => {
          void writable.abort().catch(() => undefined)
          reject(new DOMException('OPFS_WRITE_TIMEOUT', 'TimeoutError'))
        }, OPFS_WRITE_TIMEOUT_MS)
      }),
    ])
    return path
  } catch {
    await removeFromOpfs(path)
    return undefined
  } finally {
    if (timeout) globalThis.clearTimeout(timeout)
  }
}

async function readFromOpfs(path: string): Promise<File | null> {
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('private-archive-uploads')
    return await (await directory.getFileHandle(path)).getFile()
  } catch {
    return null
  }
}

async function removeFromOpfs(path?: string): Promise<void> {
  if (!path) return
  try {
    const root = await navigator.storage.getDirectory()
    const directory = await root.getDirectoryHandle('private-archive-uploads')
    await directory.removeEntry(path)
  } catch {
    // The fallback blob or a completed job can still be removed safely.
  }
}

export async function enqueueLocalUpload(options: {
  file: File
  batchId: string
  mediaType: LocalUploadJob['mediaType']
  storageBackend?: StorageBackend
  persistPayload?: boolean
}): Promise<LocalUploadJob> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  const persistPayload = options.persistPayload !== false
  if (!activePrincipalId) throw new Error('当前账号尚未完成验证，无法创建上传任务。')
  const opfsPath = persistPayload ? await writeToOpfs(id, options.file) : undefined
  if (persistPayload && !opfsPath && options.file.size > INDEXEDDB_PAYLOAD_FALLBACK_MAX_BYTES) {
    throw new Error('当前浏览器缺少适合大文件的持久化存储能力。请使用支持 OPFS 的桌面客户端上传该文件。')
  }
  if (!persistPayload) transientPayloads.set(id, options.file)
  const job: LocalUploadJob = {
    id,
    schemaVersion: 2,
    batchId: options.batchId,
    principalId: activePrincipalId,
    fileName: options.file.name,
    mimeType: options.file.type || 'application/octet-stream',
    sizeBytes: options.file.size,
    mediaType: options.mediaType,
    storageBackend: options.storageBackend ?? 'telegram_user_group',
    status: navigator.onLine ? 'waiting' : 'paused',
    prepareStatus: 'pending',
    controlState: 'active',
    stage: 'registered',
    progress: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
    transientPayload: !persistPayload || undefined,
    opfsPath,
    metadata: {
      originalName: options.file.name,
      mimeType: options.file.type || 'application/octet-stream',
      sizeBytes: options.file.size,
      mediaType: options.mediaType,
      storageBackend: options.storageBackend ?? 'telegram_user_group',
      importOrigin: 'web',
      fileCreatedAt: options.file.lastModified ? new Date(options.file.lastModified).toISOString() : undefined,
    },
  }
  try {
    if (persistPayload && !opfsPath) await persistPayloadBytes(id, 'original', options.file)
    await (await dbPromise).put('uploads', job)
  } catch (error) {
    transientPayloads.delete(id)
    await Promise.all([removeFromOpfs(opfsPath), removePayloads(id)])
    if (error instanceof DOMException && ['QuotaExceededError', 'UnknownError'].includes(error.name)) {
      throw new Error('本机可用存储空间不足，无法安全保存原件。请释放空间后重试。', { cause: error })
    }
    throw error
  }
  return job
}

export async function listLocalUploads(): Promise<LocalUploadJob[]> {
  if (!activePrincipalId) return []
  const raw = await (await dbPromise).getAllFromIndex('uploads', 'by-updated')
  const jobs = raw.map((job) => normalizeLocalUpload(job))
  const visible = jobs.filter(visibleToActivePrincipal).map((job) => job.principalId ? job : { ...job, principalId: activePrincipalId as string })
  if (visible.some((job) => {
    const original = raw.find((item) => item.id === job.id)
    return !original || job.schemaVersion !== original.schemaVersion || job.status !== original.status || job.principalId !== original.principalId
  })) await persistNormalization(visible)
  return visible.reverse()
}

export async function getLocalUpload(id: string): Promise<LocalUploadJob | undefined> {
  if (!activePrincipalId) return undefined
  const job = await (await dbPromise).get('uploads', id)
  if (!job) return undefined
  const normalized = normalizeLocalUpload(job)
  if (!visibleToActivePrincipal(normalized)) return undefined
  if (!normalized.principalId && adoptLegacyUploads) {
    const adopted = { ...normalized, principalId: activePrincipalId }
    await (await dbPromise).put('uploads', adopted)
    return adopted
  }
  return normalized
}

export async function getLocalUploadFile(job: LocalUploadJob): Promise<File | null> {
  if (!visibleToActivePrincipal(job)) return null
  const transientFile = transientPayloads.get(job.id)
  if (transientFile) return transientFile
  const opfsFile = job.opfsPath ? await readFromOpfs(job.opfsPath) : null
  const lastModified = originalLocalFileLastModified(job)
  if (opfsFile) return new File([opfsFile], job.fileName, { type: job.mimeType, lastModified })
  const persisted = await readPayload(job.id, 'original')
  if (persisted) return new File([persisted.bytes], job.fileName, { type: job.mimeType || persisted.mimeType, lastModified })
  if (job.fileBlob) return new File([job.fileBlob], job.fileName, { type: job.mimeType, lastModified })
  return null
}

export async function storeLocalUploadPreview(id: string, preview?: Blob): Promise<boolean> {
  if (!preview) return false
  try {
    await persistPayloadBytes(id, 'preview', preview)
    return true
  } catch {
    const database = await dbPromise
    await database.delete('payloads', payloadKey(id, 'preview'))
    return false
  }
}

export async function getLocalUploadPreview(job: LocalUploadJob): Promise<Blob | null> {
  if (!visibleToActivePrincipal(job)) return null
  const persisted = await readPayload(job.id, 'preview')
  if (persisted) return new Blob([persisted.bytes], { type: persisted.mimeType })
  return job.previewBlob ?? null
}

export async function updateLocalUpload(id: string, patch: Partial<LocalUploadJob>): Promise<LocalUploadJob | undefined> {
  if (!activePrincipalId) return undefined
  const database = await dbPromise
  const current = await database.get('uploads', id)
  if (!current) return undefined
  const normalizedCurrent = normalizeLocalUpload(current)
  if (!visibleToActivePrincipal(normalizedCurrent)) return undefined
  const next = normalizeLocalUpload({ ...current, ...patch, id, principalId: normalizedCurrent.principalId ?? activePrincipalId, updatedAt: new Date().toISOString() })
  await database.put('uploads', next)
  return next
}

export async function releaseLocalUploadPayload(id: string): Promise<void> {
  if (!activePrincipalId) return
  const database = await dbPromise
  const job = await database.get('uploads', id)
  if (!job || !visibleToActivePrincipal(normalizeLocalUpload(job))) return
  transientPayloads.delete(id)
  await Promise.all([removeFromOpfs(job.opfsPath), removePayloads(id)])
  await database.put('uploads', {
    ...job,
    opfsPath: undefined,
    fileBlob: undefined,
    previewBlob: undefined,
    previewStored: undefined,
    transientPayload: undefined,
    updatedAt: new Date().toISOString(),
  })
}

export async function getLocalUploadsByBatch(batchId: string): Promise<LocalUploadJob[]> {
  if (!activePrincipalId) return []
  const jobs = await (await dbPromise).getAllFromIndex('uploads', 'by-batch', batchId)
  return jobs.map((job) => normalizeLocalUpload(job)).filter(visibleToActivePrincipal)
}

export async function removeLocalUpload(id: string): Promise<void> {
  if (!activePrincipalId) return
  const database = await dbPromise
  const job = await database.get('uploads', id)
  if (!job || !visibleToActivePrincipal(normalizeLocalUpload(job))) return
  transientPayloads.delete(id)
  await Promise.all([removeFromOpfs(job?.opfsPath), removePayloads(id)])
  await database.delete('uploads', id)
}
