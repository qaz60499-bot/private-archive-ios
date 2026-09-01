import type { ActivityItem, Album, AppAccessGrant, AppAccessPreset, AppAccount, ArchiveSummary, Asset, AuthStatus, DiscoverModule, IntegrationStatus, ShareLink, StorageBackend, TelegramDiscovery, TelegramSource, UsageSnapshot } from '../types'
import { apiRequestUrl, isNativeApp, nativeApiResourceUrl, nativePlatform } from './native-platform'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfterMs?: number) {
    super(code)
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
export const UPLOAD_REQUEST_TIMEOUT_MS = 180_000

function emitAppAuthRequired(code: string): void {
  if (code !== 'APP_AUTH_REQUIRED') return
  globalThis.dispatchEvent(new Event('private-archive:auth-required'))
}

function retryAfterMs(response: Response): number | undefined {
  const value = response.headers.get('Retry-After')
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000)
  const date = Date.parse(value)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined
}

async function authenticatedFetch(path: string, init?: RequestInit, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(init?.signal?.reason)
  if (init?.signal?.aborted) abortFromCaller()
  else init?.signal?.addEventListener('abort', abortFromCaller, { once: true })
  const timer = globalThis.setTimeout(() => controller.abort(new DOMException('Request timed out', 'TimeoutError')), timeoutMs)
  try {
    const headers = new Headers(init?.headers)
    // Cloudflare Access recommends this header for SPA/AJAX calls so an expired
    // Access session returns an actionable 401 instead of silently blocking the
    // sub-request behind an authentication redirect.
    headers.set('X-Requested-With', 'XMLHttpRequest')
    const native = isNativeApp()
    if (native) headers.set('X-Private-Archive-Native', nativePlatform() ?? 'native')
    const response = await fetch(apiRequestUrl(path), {
      ...init,
      headers,
      signal: controller.signal,
      credentials: native ? 'include' : 'same-origin',
      redirect: 'manual',
    })
    if (response.type === 'opaqueredirect' || response.status === 0) {
      throw new ApiError(401, 'ACCESS_SIGN_IN_REQUIRED')
    }
    return response
  } catch (error) {
    if (error instanceof ApiError) throw error
    if (init?.signal?.aborted) throw new ApiError(0, 'UPLOAD_ABORTED')
    if (controller.signal.aborted) throw new ApiError(0, 'REQUEST_TIMEOUT')
    if (typeof navigator !== 'undefined' && !navigator.onLine) throw new ApiError(0, 'NETWORK_OFFLINE')
    throw new ApiError(0, 'ACCESS_OR_NETWORK_FAILED')
  } finally {
    globalThis.clearTimeout(timer)
    init?.signal?.removeEventListener('abort', abortFromCaller)
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await authenticatedFetch(path, {
    ...init,
    headers: { ...(init?.body && typeof init.body === 'string' ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
  })
  const body = await response.json().catch(() => ({})) as T & { error?: string }
  if (!response.ok) {
    const code = body.error ?? (response.status === 401 ? 'ACCESS_SIGN_IN_REQUIRED' : 'REQUEST_FAILED')
    emitAppAuthRequired(code)
    throw new ApiError(response.status, code, retryAfterMs(response))
  }
  return body
}

function localBridgeSurface(): boolean {
  if (typeof location === 'undefined') return false
  return location.protocol === 'http:' && ['127.0.0.1', 'localhost', '::1'].includes(location.hostname)
}

function normalizeAssetForSurface(asset: Asset): Asset {
  const normalized = {
    ...asset,
    previewUrl: nativeApiResourceUrl(asset.previewUrl) ?? asset.previewUrl,
    mediaUrl: nativeApiResourceUrl(asset.mediaUrl),
  }
  if (asset.storageBackend !== 'telegram_user_group' || localBridgeSurface()) return normalized
  return {
    ...normalized,
    previewSupported: false,
    downloadSupported: false,
    originalAvailableInApp: false,
    mediaUrl: null,
  }
}

export const api = {
  authStatus: () => request<AuthStatus>('/api/auth/status'),
  bootstrapAccount: (username: string, displayName: string, password: string) => request<{ user: AppAccount }>('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify({ username, displayName, password }) }),
  loginAccount: (username: string, password: string) => request<{ user: AppAccount }>('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  logoutAccount: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST', body: '{}' }),
  currentAccount: () => request<{ user: AppAccount }>('/api/auth/me'),
  listAccounts: () => request<{ items: AppAccount[] }>('/api/auth/users'),
  createAccount: (username: string, displayName: string, password: string, accessPreset: 'FULL' | 'VIEWER' | 'UPLOAD_ONLY' = 'VIEWER') => request<{ user: AppAccount }>('/api/auth/users', { method: 'POST', body: JSON.stringify({ username, displayName, password, accessPreset }) }),
  updateAccount: (id: string, patch: { displayName?: string; password?: string; status?: 'ACTIVE' | 'DISABLED' }) => request<{ user: AppAccount | null }>(`/api/auth/users/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  updateAccountAccess: (id: string, input: { accessPreset: Exclude<AppAccessPreset, 'SCOPED' | 'CUSTOM'> } | { grants: AppAccessGrant[] }) => request<{ user: AppAccount | null }>(`/api/auth/users/${id}/access`, { method: 'PUT', body: JSON.stringify(input) }),
  listAssets: async (params: URLSearchParams = new URLSearchParams()) => {
    const result = await request<{ items: Asset[]; nextCursor: string | null }>(`/api/assets?${params}`)
    return { ...result, items: result.items.map(normalizeAssetForSurface) }
  },
  timelineMonths: () => request<{ items: Array<{ month: string; asset_count: number }> }>('/api/timeline/months'),
  getAsset: async (id: string) => {
    const result = await request<{ asset: Asset }>(`/api/assets/${id}`)
    return { asset: normalizeAssetForSurface(result.asset) }
  },
  patchAsset: async (id: string, patch: { favorite?: boolean; archived?: boolean; categoryOverride?: string | null; logicalPath?: string; originalName?: string }) => {
    const result = await request<{ asset: Asset }>(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) })
    return { asset: normalizeAssetForSurface(result.asset) }
  },
  setAssetTags: async (id: string, tags: string[]) => {
    const result = await request<{ asset: Asset | null }>(`/api/assets/${id}/tags`, { method: 'PUT', body: JSON.stringify({ tags }) })
    return { asset: result.asset ? normalizeAssetForSurface(result.asset) : null }
  },
  deleteAsset: (id: string) => request<{ ok: true; telegramDeleted: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),
  bulkTrashAssets: (ids: string[]) => request<{ ok: true; deleted: number; telegramDeleted: boolean }>('/api/assets/bulk-trash', { method: 'POST', body: JSON.stringify({ ids }) }),
  discardUnstoredAssets: (ids: string[]) => request<{ ok: true; discarded: number }>('/api/assets/bulk-discard-unstored', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkRestoreAssets: (ids: string[]) => request<{ ok: true; restored: number }>('/api/assets/bulk-restore', { method: 'POST', body: JSON.stringify({ ids }) }),
  bulkPatchAssets: (ids: string[], patch: { favorite?: boolean; archived?: boolean; tags?: string[] }) => request<{ ok: true; updated: number; tagged: number }>('/api/assets/bulk-patch', { method: 'POST', body: JSON.stringify({ ids, ...patch }) }),
  restoreAsset: async (id: string) => {
    const result = await request<{ ok: true; asset: Asset | null }>(`/api/assets/${id}/restore`, { method: 'POST', body: '{}' })
    return { ...result, asset: result.asset ? normalizeAssetForSurface(result.asset) : null }
  },
  purgeAsset: (id: string) => request<{ ok: true; telegramDeleted: boolean; sharedObjectPreserved: boolean }>(`/api/assets/${id}/purge`, { method: 'DELETE' }),
  prepareUserGroupPurge: (id: string) => request<{ ok: true; action: 'complete'; telegramDeleted: boolean; sharedObjectPreserved: boolean } | { ok: true; action: 'delete_telegram'; sharedObjectPreserved: false }>(`/api/assets/${id}/user-group-purge-prepare`, { method: 'POST', body: '{}' }),
  finalizeUserGroupPurge: (id: string) => request<{ ok: true; telegramDeleted: true; sharedObjectPreserved: false }>(`/api/assets/${id}/user-group-purge-finalize`, { method: 'POST', body: '{}' }),
  failUserGroupPurge: (id: string, error: string) => request<{ ok: true; recoverable: true }>(`/api/assets/${id}/user-group-purge-failed`, { method: 'POST', body: JSON.stringify({ error }) }),
  reserve: (metadata: Record<string, unknown>, signal?: AbortSignal) => request<{ assetId: string; uploadToken?: string; duplicate: boolean; duplicateOfAssetId?: string; reusedStorage?: boolean; resumed?: boolean; sizeTier: string }>('/api/assets/reserve', { method: 'POST', body: JSON.stringify(metadata), signal }),
  uploadContent: async (assetId: string, token: string, file: Blob, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/api/assets/${assetId}/content`, {
      method: 'PUT', body: file, signal, headers: { 'X-Upload-Token': token, 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': String(file.size) },
    }, UPLOAD_REQUEST_TIMEOUT_MS)
    const body = await response.json().catch(() => ({})) as { asset?: Asset; alreadyStored?: boolean; previewAvailable?: boolean; error?: string }
    if (!response.ok) {
      const code = body.error ?? (response.status === 401 ? 'ACCESS_SIGN_IN_REQUIRED' : 'UPLOAD_FAILED')
      emitAppAuthRequired(code)
      throw new ApiError(response.status, code, retryAfterMs(response))
    }
    return body
  },
  uploadPreview: async (assetId: string, token: string, preview: Blob, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/api/assets/${assetId}/preview`, {
      method: 'POST', body: preview, signal, headers: { 'X-Upload-Token': token, 'Content-Type': preview.type || 'image/jpeg', 'Content-Length': String(preview.size) },
    }, UPLOAD_REQUEST_TIMEOUT_MS)
    const body = await response.json().catch(() => ({})) as { ok?: boolean; error?: string }
    if (!response.ok) {
      const code = body.error ?? (response.status === 401 ? 'ACCESS_SIGN_IN_REQUIRED' : 'PREVIEW_UPLOAD_FAILED')
      emitAppAuthRequired(code)
      throw new ApiError(response.status, code, retryAfterMs(response))
    }
    return body
  },
  listDiscoverModules: () => request<{ items: DiscoverModule[] }>('/api/discover-modules'),
  createDiscoverModule: (name: string, description = '') => request<{ module: DiscoverModule }>('/api/discover-modules', { method: 'POST', body: JSON.stringify({ name, description }) }),
  deleteDiscoverModule: (slug: string) => request<{ ok: true }>(`/api/discover-modules/${slug}`, { method: 'DELETE' }),
  listAlbums: () => request<{ items: Album[] }>('/api/albums'),
  getAlbum: (albumId: string) => request<{ album: Album }>(`/api/albums/${albumId}`),
  createAlbum: (name: string) => request<{ album: Album }>('/api/albums', { method: 'POST', body: JSON.stringify({ name }) }),
  deleteAlbum: (albumId: string) => request<{ ok: true }>(`/api/albums/${albumId}`, { method: 'DELETE' }),
  addToAlbum: (albumId: string, assetId: string) => request<{ ok: true }>(`/api/albums/${albumId}`, { method: 'PATCH', body: JSON.stringify({ assetId }) }),
  setAlbumCover: (albumId: string, coverAssetId: string) => request<{ ok: true }>(`/api/albums/${albumId}`, { method: 'PATCH', body: JSON.stringify({ coverAssetId }) }),
  removeFromAlbum: (albumId: string, assetId: string) => request<{ ok: true }>(`/api/albums/${albumId}/assets/${assetId}`, { method: 'DELETE' }),
  recent: async (kind: 'added' | 'viewed' = 'added', limit = 30) => {
    const result = await request<{ kind: string; items: Asset[] }>(`/api/recent?kind=${kind}&limit=${limit}`)
    return { ...result, items: result.items.map(normalizeAssetForSurface) }
  },
  activity: (limit = 50) => request<{ items: ActivityItem[] }>(`/api/activity?limit=${limit}`),
  usage: () => request<{ usage: UsageSnapshot }>('/api/usage'),
  archiveSummary: () => request<ArchiveSummary>('/api/archive-summary'),
  trashPolicy: () => request<{ retentionDays: number | null }>('/api/trash-policy'),
  setTrashPolicy: (retentionDays: 7 | 30 | 90 | 'never') => request<{ ok: true; retentionDays: number | null }>('/api/trash-policy', { method: 'PUT', body: JSON.stringify({ retentionDays }) }),
  recoveryIntegrity: () => request<{ ok: true; checks: Record<string, number>; recovery: Record<string, unknown> }>('/api/recovery/integrity'),
  rebuildSearch: (dryRun = true) => request<{ ok: true; dryRun: boolean; missingSearchRows?: number; missingBefore?: number; missingAfter?: number }>('/api/recovery/search-rebuild', { method: 'POST', body: JSON.stringify({ dryRun }) }),
  settings: () => request<IntegrationStatus>('/api/settings/status'),
  storagePreference: () => request<{ defaultStorageBackend: StorageBackend }>('/api/storage-preference'),
  setStoragePreference: (defaultStorageBackend: StorageBackend) => request<{ ok: true; defaultStorageBackend: StorageBackend }>('/api/storage-preference', { method: 'PUT', body: JSON.stringify({ defaultStorageBackend }) }),
  commitUserGroupUpload: async (assetId: string, token: string, receipt: { chatId: string; messageId: number; mediaId?: string | null; sizeBytes: number }) => {
    const result = await request<{ asset: Asset | null; alreadyStored: boolean }>(`/api/assets/${assetId}/user-group-commit`, { method: 'POST', headers: { 'X-Upload-Token': token }, body: JSON.stringify(receipt) })
    return { ...result, asset: result.asset ? normalizeAssetForSurface(result.asset) : null }
  },
  updateUserGroupRuntime: (runtime: { connectionStatus: 'disconnected' | 'auth_required' | 'connected' | 'syncing' | 'error'; storageChatId?: string | null; storageChatTitle?: string | null; lastSyncAt?: string | null; lastError?: string | null; lastAckMessageId?: number | null }) => request<{ ok: true; runtime: NonNullable<IntegrationStatus['storage']>['userGroup'] }>('/api/telegram/user-group/runtime', { method: 'POST', body: JSON.stringify(runtime) }),
  importUserGroupItems: (items: Array<Record<string, unknown>>) => request<{ ok: boolean; created: number; duplicate: number; failed: number; results: Array<{ messageId: number; created: boolean; assetId?: string; error?: string }> }>('/api/telegram/user-group/import', { method: 'POST', body: JSON.stringify({ items }) }),
  retryFailedAnalysis: () => request<{ ok: boolean; queued: number }>('/api/analysis/retry-failed', { method: 'POST', body: '{}' }),
  discoverTelegram: () => request<TelegramDiscovery>('/api/telegram/discover'),
  configureTelegram: (chatId: string, role: 'owner' | 'storage' | 'both') => request<{ ok: true; ownerUserId: string | null; storageChatId: string | null }>('/api/telegram/configure', { method: 'POST', body: JSON.stringify({ chatId, role }) }),
  listTelegramSources: () => request<{ items: TelegramSource[] }>('/api/telegram/sources'),
  createTelegramSource: (displayName: string, botToken: string) => request<{ item: TelegramSource; webhookConfigured: boolean }>('/api/telegram/sources', { method: 'POST', body: JSON.stringify({ displayName, botToken }) }),
  discoverTelegramSource: (id: string) => request<{ source: { id: string; displayName: string; botUsername: string | null; connectionStatus: string }; chats: TelegramDiscovery['chats'] }>(`/api/telegram/sources/${id}/discover`),
  bindTelegramSource: (id: string, chatId: string) => request<{ ok: true; item: TelegramSource }>(`/api/telegram/sources/${id}/bind`, { method: 'POST', body: JSON.stringify({ chatId }) }),
  setTelegramSourceEnabled: (id: string, enabled: boolean) => request<{ ok: true; enabled: boolean }>(`/api/telegram/sources/${id}/enabled`, { method: 'POST', body: JSON.stringify({ enabled }) }),
  disconnectTelegramSource: (id: string) => request<{ ok: true; telegramFilesDeleted: false }>(`/api/telegram/sources/${id}/disconnect`, { method: 'POST', body: '{}' }),
  listShares: () => request<{ items: ShareLink[] }>('/api/access/shares'),
  createShare: (input: { name: string; scopeType: 'source' | 'album' | 'asset'; scopeId: string; allowDownload: boolean; expiresInDays: 1 | 7 | 30 | null }) => request<{ item: ShareLink; url: string | null }>('/api/access/shares', { method: 'POST', body: JSON.stringify(input) }),
  revokeShare: (id: string) => request<{ ok: true }>(`/api/access/shares/${id}/revoke`, { method: 'POST', body: '{}' }),
  rotateShare: (id: string) => request<{ ok: true; url: string | null }>(`/api/access/shares/${id}/rotate`, { method: 'POST', body: '{}' }),
  seedMock: () => request<{ ok: boolean; created: number }>('/api/dev/seed', { method: 'POST', body: '{}' }),
}
