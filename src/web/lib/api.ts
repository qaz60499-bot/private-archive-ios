import type { Album, Asset, DiscoverModule, IntegrationStatus, TelegramDiscovery } from '../types'

export class ApiError extends Error {
  constructor(public readonly status: number, public readonly code: string, public readonly retryAfterMs?: number) {
    super(code)
  }
}

export const DEFAULT_REQUEST_TIMEOUT_MS = 45_000
export const UPLOAD_REQUEST_TIMEOUT_MS = 180_000

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
    const response = await fetch(path, {
      ...init,
      signal: controller.signal,
      credentials: 'same-origin',
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
  if (!response.ok) throw new ApiError(response.status, body.error ?? 'REQUEST_FAILED', retryAfterMs(response))
  return body
}

export const api = {
  listAssets: (params: URLSearchParams = new URLSearchParams()) => request<{ items: Asset[]; nextCursor: string | null }>(`/api/assets?${params}`),
  timelineMonths: () => request<{ items: Array<{ month: string; asset_count: number }> }>('/api/timeline/months'),
  getAsset: (id: string) => request<{ asset: Asset }>(`/api/assets/${id}`),
  patchAsset: (id: string, patch: { favorite?: boolean; categoryOverride?: string | null }) => request<{ asset: Asset }>(`/api/assets/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  deleteAsset: (id: string) => request<{ ok: true; telegramDeleted: boolean }>(`/api/assets/${id}`, { method: 'DELETE' }),
  bulkTrashAssets: (ids: string[]) => request<{ ok: true; deleted: number; telegramDeleted: boolean }>('/api/assets/bulk-trash', { method: 'POST', body: JSON.stringify({ ids }) }),
  reserve: (metadata: Record<string, unknown>, signal?: AbortSignal) => request<{ assetId: string; uploadToken?: string; duplicate: boolean; resumed?: boolean; sizeTier: string }>('/api/assets/reserve', { method: 'POST', body: JSON.stringify(metadata), signal }),
  uploadContent: async (assetId: string, token: string, file: Blob, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/api/assets/${assetId}/content`, {
      method: 'PUT', body: file, signal, headers: { 'X-Upload-Token': token, 'Content-Type': file.type || 'application/octet-stream', 'Content-Length': String(file.size) },
    }, UPLOAD_REQUEST_TIMEOUT_MS)
    const body = await response.json() as { asset?: Asset; error?: string }
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'UPLOAD_FAILED', retryAfterMs(response))
    return body
  },
  uploadPreview: async (assetId: string, token: string, preview: Blob, signal?: AbortSignal) => {
    const response = await authenticatedFetch(`/api/assets/${assetId}/preview`, {
      method: 'POST', body: preview, signal, headers: { 'X-Upload-Token': token, 'Content-Type': preview.type || 'image/jpeg', 'Content-Length': String(preview.size) },
    }, UPLOAD_REQUEST_TIMEOUT_MS)
    const body = await response.json() as { ok?: boolean; error?: string }
    if (!response.ok) throw new ApiError(response.status, body.error ?? 'PREVIEW_UPLOAD_FAILED', retryAfterMs(response))
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
  settings: () => request<IntegrationStatus>('/api/settings/status'),
  retryFailedAnalysis: () => request<{ ok: boolean; queued: number }>('/api/analysis/retry-failed', { method: 'POST', body: '{}' }),
  discoverTelegram: () => request<TelegramDiscovery>('/api/telegram/discover'),
  configureTelegram: (chatId: string, role: 'owner' | 'storage' | 'both') => request<{ ok: true; ownerUserId: string | null; storageChatId: string | null }>('/api/telegram/configure', { method: 'POST', body: JSON.stringify({ chatId, role }) }),
  seedMock: () => request<{ ok: boolean; created: number }>('/api/dev/seed', { method: 'POST', body: '{}' }),
}
