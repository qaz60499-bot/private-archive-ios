import { ApiError, api } from './api'
import type { Asset } from '../types'

export type BridgeConnectionStatus = 'disconnected' | 'auth_required' | 'connected' | 'syncing' | 'error'

export interface TelegramUserGroupBridgeStatus {
  ok: boolean
  service: string
  connectionStatus: BridgeConnectionStatus
  authorized: boolean
  authStep: 'phone' | 'code' | 'password' | null
  storageChatId: string | null
  storageChatTitle: string | null
  lastSyncAt: string | null
  lastError: string | null
  checkpoint: number
  pendingCount: number
  capabilities?: {
    cryptg: boolean
    resumableLargeUploads: boolean
    rangeOriginalDownloads: boolean
    streamingOriginalDownloads: boolean
  }
}

export interface TelegramUserGroupReceipt {
  backend: 'telegram_user_group'
  chatId: string
  messageId: number
  mediaId?: string | null
  sizeBytes: number
  fileName: string
  mimeType: string
  resumedBytes?: number
  telegramUploadMs?: number
}

export interface TelegramUserGroupPendingItem {
  chatId: string
  messageId: number
  mediaId?: string | null
  fileName: string
  mimeType: string
  sizeBytes: number
  mediaType: 'photo' | 'video' | 'file'
  takenAt: string
  width?: number
  height?: number
  durationMs?: number
}

interface BridgeErrorBody {
  error?: string
}

function isDesktopLoopback(): boolean {
  if (typeof location === 'undefined') return false
  if (location.hostname !== '127.0.0.1' && location.hostname !== 'localhost') return false
  const port = Number(location.port)
  return port === 8798 || port >= 8840 && port <= 8850
}

async function bridgeJson<T>(path: string, init?: RequestInit, timeoutMs = 60_000): Promise<T> {
  if (!isDesktopLoopback()) throw new ApiError(503, 'TELEGRAM_STORAGE_BRIDGE_OFFLINE')
  const controller = new AbortController()
  const relayAbort = () => controller.abort(init?.signal?.reason)
  if (init?.signal?.aborted) relayAbort()
  else init?.signal?.addEventListener('abort', relayAbort, { once: true })
  const timer = globalThis.setTimeout(() => controller.abort(new DOMException('Bridge timeout', 'TimeoutError')), timeoutMs)
  try {
    const response = await fetch(`/__telegram_storage${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
      headers: {
        ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
    const body = await response.json().catch(() => ({})) as T & BridgeErrorBody
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'TELEGRAM_STORAGE_BRIDGE_FAILED')
    return body
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (init?.signal?.aborted) throw new ApiError(0, 'UPLOAD_ABORTED')
    if (controller.signal.aborted) throw new ApiError(0, 'TELEGRAM_STORAGE_BRIDGE_TIMEOUT')
    throw new ApiError(503, 'TELEGRAM_STORAGE_BRIDGE_OFFLINE')
  } finally {
    globalThis.clearTimeout(timer)
    init?.signal?.removeEventListener('abort', relayAbort)
  }
}

export const telegramUserGroupBridge = {
  available: isDesktopLoopback(),
  status: () => bridgeJson<TelegramUserGroupBridgeStatus>('/status'),
  sendCode: (phone: string) => bridgeJson<{ ok: true; authStep: 'code' }>('/auth/send-code', { method: 'POST', body: JSON.stringify({ phone }) }),
  confirmCode: (code: string) => bridgeJson<{ ok: true; authStep: 'password' | null; passwordRequired?: boolean; status?: TelegramUserGroupBridgeStatus }>('/auth/confirm', { method: 'POST', body: JSON.stringify({ code }) }),
  confirmPassword: (password: string) => bridgeJson<{ ok: true; authStep: null; status: TelegramUserGroupBridgeStatus }>('/auth/password', { method: 'POST', body: JSON.stringify({ password }) }),
  reauthorize: () => bridgeJson<TelegramUserGroupBridgeStatus>('/auth/reauthorize', { method: 'POST', body: '{}' }),
  sync: () => bridgeJson<{ ok: true; scanned: number; queued: number; checkpoint: number; status: TelegramUserGroupBridgeStatus }>('/sync', { method: 'POST', body: '{}' }, 10 * 60_000),
  pending: (limit = 50) => bridgeJson<{ ok: true; items: TelegramUserGroupPendingItem[]; pendingCount: number }>(`/pending?limit=${Math.max(1, Math.min(100, limit))}`),
  ack: (messageIds: number[]) => bridgeJson<{ ok: true; removed: number }>('/ack', { method: 'POST', body: JSON.stringify({ messageIds }) }),
  deleteAsset: (assetId: string) => bridgeJson<{ ok: true; deleted: boolean }>(`/asset/${encodeURIComponent(assetId)}/delete`, { method: 'POST', body: '{}' }),
  upload: async (assetId: string, uploadToken: string, file: File, sha256: string, signal?: AbortSignal): Promise<TelegramUserGroupReceipt> => {
    if (!isDesktopLoopback()) throw new ApiError(503, 'TELEGRAM_STORAGE_BRIDGE_OFFLINE')
    const params = new URLSearchParams({ fileName: file.name, mimeType: file.type || 'application/octet-stream', sha256 })
    const response = await fetch(`/__telegram_storage/asset/${encodeURIComponent(assetId)}/upload?${params}`, {
      method: 'PUT',
      body: file,
      signal,
      credentials: 'same-origin',
      headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Upload-Token': uploadToken },
    })
    const body = await response.json().catch(() => ({})) as { receipt?: TelegramUserGroupReceipt; error?: string }
    if (!response.ok || !body.receipt) throw new ApiError(response.status, body.error ?? 'TELEGRAM_USER_GROUP_UPLOAD_FAILED')
    return body.receipt
  },
}

export async function publishUserGroupRuntime(status: TelegramUserGroupBridgeStatus): Promise<void> {
  await api.updateUserGroupRuntime({
    connectionStatus: status.connectionStatus,
    storageChatId: status.storageChatId,
    storageChatTitle: status.storageChatTitle,
    lastSyncAt: status.lastSyncAt,
    lastError: status.lastError,
    lastAckMessageId: status.checkpoint,
  })
}

export async function flushUserGroupPendingIntoArchive(): Promise<{ created: number; duplicate: number; pending: number }> {
  let created = 0
  let duplicate = 0
  while (true) {
    const pending = await telegramUserGroupBridge.pending(100)
    if (!pending.items.length) return { created, duplicate, pending: pending.pendingCount }
    const imported = await api.importUserGroupItems(pending.items as unknown as Array<Record<string, unknown>>)
    const successfulIds = imported.results.filter((item) => !item.error).map((item) => item.messageId)
    if (successfulIds.length) await telegramUserGroupBridge.ack(successfulIds)
    created += imported.created
    duplicate += imported.duplicate
    if (imported.failed || successfulIds.length === 0) return { created, duplicate, pending: Math.max(0, pending.pendingCount - successfulIds.length) }
  }
}

export async function syncUserGroupIntoArchive(): Promise<{ scanned: number; queued: number; created: number; duplicate: number; pending: number }> {
  const sync = await telegramUserGroupBridge.sync()
  await publishUserGroupRuntime(sync.status)
  const flushed = await flushUserGroupPendingIntoArchive()
  return { scanned: sync.scanned, queued: sync.queued, ...flushed }
}

export async function purgeAssetThroughStorage(asset: Asset): Promise<{ telegramDeleted: boolean; sharedObjectPreserved: boolean }> {
  if (asset.storageBackend !== 'telegram_user_group') return api.purgeAsset(asset.id)
  const prepared = await api.prepareUserGroupPurge(asset.id)
  if (prepared.action === 'complete') return prepared
  if (!telegramUserGroupBridge.available) {
    await api.failUserGroupPurge(asset.id, 'TELEGRAM_STORAGE_BRIDGE_OFFLINE').catch(() => undefined)
    throw new ApiError(503, 'TELEGRAM_STORAGE_BRIDGE_OFFLINE')
  }
  try {
    await telegramUserGroupBridge.deleteAsset(asset.id)
  } catch (error) {
    const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : 'TELEGRAM_DELETE_FAILED'
    await api.failUserGroupPurge(asset.id, code).catch(() => undefined)
    throw error
  }
  return api.finalizeUserGroupPurge(asset.id)
}
