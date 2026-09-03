import { Hono } from 'hono'
import {
  bulkDiscardUnstoredAssets, bulkPatchAssetFlags, bulkRestoreAssets, bulkSoftDeleteAssets, claimStorageObjectForPurge, claimUploadStarted, clearPreviewStored,
  createDeduplicatedLogicalAsset, createPendingAsset, createUploadJobForAsset, deleteLogicalAsset, getActiveAssetByContentHash,
  getAsset, getLatestUploadJobState, getTagsForAsset, listAssets, markAssetViewed, markPreviewStored, markPurgeFailure, repairAssetFromActiveStorageObject,
  markQueued, markReadyWithoutAnalysis, markStorageObjectDeleted, markStorageObjectDeleteFailed, markStored, markUploadFailed, patchAsset, restoreAsset,
  setManualTags, setManualTagsForAssets, softDeleteAsset, verifyUploadToken,
} from '../db/assets-repository'
import { logActivity } from '../db/activity-repository'
import { listAlbumNamesForAssets } from '../db/albums-repository'
import { refreshUsageSnapshot } from '../db/usage-repository'
import { LEGACY_TELEGRAM_SOURCE_ID, resolveTelegramSourceConfig } from '../db/telegram-sources-repository'
import { getDiscoverModule } from '../db/discover-modules-repository'
import { getTelegramUserGroupRuntime } from '../db/user-group-storage-repository'
import { MAX_UPLOAD_BYTES, USER_GROUP_CLIENT_SAFETY_MAX_BYTES, UPLOAD_TOKEN_TTL_MS, getSizeTier, hasUnsafeControlCharacters, selectTakenAt, validateReserveInput } from '../domain/policy'
import { activeUploadRetryAfterSeconds, botUploadLeaseMs } from '../domain/upload-retry'
import { sanitizeLogicalPath } from '../domain/asset-metadata'
import { toPublicAsset } from '../domain/types'
import type { Env } from '../env'
import { isMockMode } from '../env'
import { createUploadToken } from '../lib/crypto'
import { applySafeMediaHeaders, isSafeInlineMediaType, resolveOriginalMediaMimeType } from '../lib/media-response'
import { requireAccount, resolveRequestAppUser } from '../lib/security'
import { readBoundedJsonObject } from '../lib/request-json'
import { canAppUserAccessAsset, canAppUserAccessAssets, canAppUserAccessSource } from '../db/app-user-access-repository'
import { createStorageAdapterFromConfig } from '../services/storage/factory'
import { fetchPreviewCached } from '../services/storage/preview-cache'
import { createStorageManifest } from '../services/storage/manifest'
import { EDGE_MEDIA_TTL, edgeMediaCacheKey, matchEdgeMedia, openEdgeMediaCache, storeEdgeMedia, type EdgeMediaSource } from '../services/storage/edge-media-cache'
import { TelegramApiError } from '../services/telegram/telegram-client'

export const assetsRoutes = new Hono<{ Bindings: Env }>()
assetsRoutes.use('*', requireAccount)

async function requestUser(context: Parameters<typeof resolveRequestAppUser>[0]) {
  return resolveRequestAppUser(context)
}

async function assetPermissionDenied(context: Parameters<typeof resolveRequestAppUser>[0], assetId: string, permission: 'read' | 'download' | 'edit' | 'delete'): Promise<boolean> {
  const user = await requestUser(context)
  return !user || !(await canAppUserAccessAsset(context.env.DB, user, assetId, permission))
}

async function bulkPermissionDenied(context: Parameters<typeof resolveRequestAppUser>[0], ids: string[], permission: 'edit' | 'delete'): Promise<boolean> {
  const user = await requestUser(context)
  return !user || !(await canAppUserAccessAssets(context.env.DB, user, ids, permission))
}

async function canDownloadForRequest(context: Parameters<typeof resolveRequestAppUser>[0], assetId: string): Promise<boolean> {
  const user = await requestUser(context)
  return Boolean(user && await canAppUserAccessAsset(context.env.DB, user, assetId, 'download'))
}

async function storageFor(env: Env, sourceId = LEGACY_TELEGRAM_SOURCE_ID, requireEnabled = false, backend: 'telegram_user_group' | 'telegram_bot' = 'telegram_bot') {
  if (isMockMode(env)) return createStorageAdapterFromConfig(env, { token: 'mock', storageChatId: '-1000000000000' }, backend)
  if (backend === 'telegram_user_group') throw new Error('LOCAL_TELEGRAM_BRIDGE_REQUIRED')
  const config = await resolveTelegramSourceConfig(env.DB, env, sourceId)
  if (requireEnabled && !config.enabled) throw new Error('TELEGRAM_SOURCE_DISABLED')
  return createStorageAdapterFromConfig(env, config)
}

function scheduleUsageRefresh(context: { env: Env; executionCtx: { waitUntil(promise: Promise<unknown>): void } }): void {
  context.executionCtx.waitUntil(refreshUsageSnapshot(context.env.DB).then(() => undefined).catch(() => undefined))
}

function errorStatus(error: unknown): 400 | 413 | 500 {
  if (error instanceof Error && ['FILE_TOO_LARGE', 'REQUEST_BODY_TOO_LARGE'].includes(error.message)) return 413
  if (error instanceof Error && (error.message.startsWith('INVALID_') || error.message === 'REQUEST_BODY_INVALID')) return 400
  return 500
}

function optionalNonNegativeInteger(value: string | undefined): number | undefined {
  if (value === undefined) return undefined
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined
}

function mockPreview(assetId: string, title: string, category: string | null, width: number | null, height: number | null): Response {
  const palettes = [
    ['#74806c', '#d9cdbb', '#39443a'], ['#94715f', '#d7b697', '#413b35'], ['#5d7180', '#c6d0d2', '#2c3941'],
    ['#8c805c', '#d8cfac', '#49452f'], ['#76677b', '#c9bdca', '#38313a'], ['#4f756d', '#b7d0c8', '#2b403b'],
  ]
  const hash = [...assetId].reduce((value, char) => value + char.charCodeAt(0), 0)
  const palette = palettes[hash % palettes.length]
  const safeTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;').slice(0, 36)
  const safeCategory = (category ?? 'archive').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  const viewWidth = width && height && width < height ? 900 : 1280
  const viewHeight = width && height && width < height ? 1200 : 860
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewWidth} ${viewHeight}" role="img" aria-label="${safeTitle}">
    <rect width="100%" height="100%" fill="${palette[1]}"/>
    <path d="M0 ${viewHeight * 0.66} C ${viewWidth * 0.24} ${viewHeight * 0.48}, ${viewWidth * 0.52} ${viewHeight * 0.8}, ${viewWidth} ${viewHeight * 0.5} V ${viewHeight} H0Z" fill="${palette[0]}"/>
    <circle cx="${viewWidth * 0.72}" cy="${viewHeight * 0.28}" r="${viewHeight * 0.115}" fill="#f0e7d4" opacity=".78"/>
    <path d="M${viewWidth * 0.08} ${viewHeight * 0.68} L${viewWidth * 0.34} ${viewHeight * 0.29} L${viewWidth * 0.59} ${viewHeight * 0.68}Z" fill="${palette[2]}" opacity=".84"/>
    <text x="${viewWidth * 0.055}" y="${viewHeight * 0.91}" fill="#f7f3e9" font-family="system-ui,sans-serif" font-size="${viewHeight * 0.035}" font-weight="600">${safeTitle}</text>
    <text x="${viewWidth * 0.055}" y="${viewHeight * 0.955}" fill="#f7f3e9" opacity=".78" font-family="system-ui,sans-serif" font-size="${viewHeight * 0.018}" letter-spacing="4">${safeCategory.toUpperCase()}</text>
  </svg>`
  return new Response(svg, {
    headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex' },
  })
}

async function enqueueIfReady(env: Env, assetId: string): Promise<void> {
  const asset = await getAsset(env.DB, assetId)
  if (!asset || !asset.storage_file_id) return
  if (asset.storage_backend === 'telegram_user_group') {
    await markReadyWithoutAnalysis(env.DB, assetId)
    return
  }
  if (!asset.preview_file_id) {
    if (asset.media_type === 'file' || asset.media_type === 'photo') await markReadyWithoutAnalysis(env.DB, assetId)
    return
  }
  await env.ANALYSIS_QUEUE.send({ assetId, previewFileId: asset.preview_file_id, jobType: 'analyze' })
  await markQueued(env.DB, assetId)
}

const MAX_RESERVE_JSON_BYTES = 128 * 1024
const IOS_STALE_RESERVATION_RECLAIM_MS = 15_000

assetsRoutes.post('/reserve', async (context) => {
  try {
    const input = validateReserveInput(await readBoundedJsonObject(context.req.raw, MAX_RESERVE_JSON_BYTES))
    const sourceId = input.sourceId ?? LEGACY_TELEGRAM_SOURCE_ID
    const user = await requestUser(context)
    if (!user || !(await canAppUserAccessSource(context.env.DB, user, sourceId, 'upload'))) {
      return context.json({ error: 'APP_UPLOAD_NOT_ALLOWED' }, 403)
    }
    if (input.storageBackend === 'telegram_user_group' && user.role !== 'OWNER') {
      return context.json({ error: 'APP_USER_GROUP_STORAGE_OWNER_REQUIRED' }, 403)
    }
    const canUseClientContentHash = user.role === 'OWNER' || await canAppUserAccessSource(context.env.DB, user, sourceId, 'read')
    const reservationInput = canUseClientContentHash ? input : { ...input, contentHash: undefined }
    if (!isMockMode(context.env) && input.storageBackend === 'telegram_bot') {
      const source = await resolveTelegramSourceConfig(context.env.DB, context.env, sourceId)
      if (!source.enabled) return context.json({ error: 'TELEGRAM_SOURCE_DISABLED' }, 409)
    }
    const uploadedAt = new Date().toISOString()
    const takenAt = selectTakenAt({ exifTakenAt: input.takenAt, fileCreatedAt: input.fileCreatedAt, uploadedAt })
    const tokenExpiresAt = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS).toISOString()
    const sizeTier = getSizeTier(input.sizeBytes, input.storageBackend)
    const maxUploadBytes = input.storageBackend === 'telegram_user_group' ? USER_GROUP_CLIENT_SAFETY_MAX_BYTES : MAX_UPLOAD_BYTES
    const reserveExisting = async (existing: NonNullable<Awaited<ReturnType<typeof getActiveAssetByContentHash>>>) => {
      if (!existing.storage_file_id && input.importOrigin === 'ios-background') {
        const repaired = await repairAssetFromActiveStorageObject(context.env.DB, existing.id)
        if (repaired) {
          await enqueueIfReady(context.env, existing.id)
          scheduleUsageRefresh(context)
          return context.json({
            assetId: existing.id, duplicate: true, duplicateOfAssetId: existing.id, reusedStorage: true, recoveredOrphanedStorage: true,
            storageBackend: input.storageBackend, sizeTier, maxUploadBytes,
          }, 200)
        }
      }
      if (existing.storage_file_id) {
        if (!existing.storage_object_id) throw new Error('DEDUP_STORAGE_OBJECT_MISSING')
        if (existing.size_bytes !== input.sizeBytes) return context.json({ error: 'CONTENT_HASH_SIZE_MISMATCH' }, 409)
        const logicalId = crypto.randomUUID()
        await createDeduplicatedLogicalAsset(context.env.DB, { id: logicalId, existing, input: reservationInput, takenAt, uploadedAt })
        await logActivity(context.env.DB, { action: 'UPLOAD', assetId: logicalId, detail: { reusedStorage: true, duplicateOfAssetId: existing.id } })
        scheduleUsageRefresh(context)
        return context.json({
          assetId: logicalId, duplicate: true, duplicateOfAssetId: existing.id, reusedStorage: true,
          storageBackend: input.storageBackend, sizeTier, maxUploadBytes,
        }, 201)
      }
      if (existing.source === 'web') {
        const latestJob = await getLatestUploadJobState(context.env.DB, existing.id)
        const activeJob = latestJob && ['waiting', 'uploading'].includes(latestJob.status) && Date.parse(latestJob.expires_at) > Date.now()
        const staleIosReservation = Boolean(
          activeJob
          && latestJob?.status === 'waiting'
          && input.importOrigin === 'ios-background'
          && existing.import_origin === 'ios-background'
          && Date.now() - Date.parse(latestJob.updated_at) >= IOS_STALE_RESERVATION_RECLAIM_MS,
        )
        if (activeJob && !staleIosReservation) {
          context.header('Retry-After', '1')
          return context.json({
            error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: existing.id, duplicate: false, resumed: true,
            storageBackend: input.storageBackend, sizeTier, maxUploadBytes,
          }, 409)
        }
        const token = createUploadToken()
        const rotated = await createUploadJobForAsset(context.env.DB, {
          assetId: existing.id,
          jobId: crypto.randomUUID(),
          token,
          tokenExpiresAt,
          expectedUpdatedAt: latestJob?.updated_at,
        })
        if (!rotated) {
          context.header('Retry-After', '1')
          return context.json({
            error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: existing.id, duplicate: false, resumed: true,
            storageBackend: input.storageBackend, sizeTier, maxUploadBytes,
          }, 409)
        }
        return context.json({ assetId: existing.id, uploadToken: token, duplicate: false, resumed: true, storageBackend: input.storageBackend, sizeTier, maxUploadBytes }, 200)
      }
      context.header('Retry-After', '1')
      return context.json({ error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: existing.id, duplicate: false, storageBackend: input.storageBackend, sizeTier, maxUploadBytes }, 409)
    }

    const canReuseExisting = async (existing: NonNullable<Awaited<ReturnType<typeof getActiveAssetByContentHash>>>) =>
      user.role === 'OWNER' || await canAppUserAccessAsset(context.env.DB, user, existing.id, 'read')

    const existing = reservationInput.contentHash ? await getActiveAssetByContentHash(context.env.DB, reservationInput.contentHash, sourceId, input.storageBackend) : null
    if (existing && await canReuseExisting(existing)) return reserveExisting(existing)

    const id = crypto.randomUUID()
    const token = createUploadToken()
    try {
      await createPendingAsset(context.env.DB, {
        id, jobId: crypto.randomUUID(), token, input: reservationInput, takenAt, uploadedAt, tokenExpiresAt,
      })
    } catch (error) {
      if (reservationInput.contentHash) {
        const raced = await getActiveAssetByContentHash(context.env.DB, reservationInput.contentHash, sourceId, input.storageBackend)
        if (raced && await canReuseExisting(raced)) return reserveExisting(raced)
        if (raced) {
          context.header('Retry-After', '1')
          return context.json({ error: 'UPLOAD_HASH_CONFLICT', duplicate: false, storageBackend: input.storageBackend, sizeTier, maxUploadBytes }, 409)
        }
      }
      throw error
    }
    return context.json({ assetId: id, uploadToken: token, duplicate: false, resumed: false, storageBackend: input.storageBackend, sizeTier, maxUploadBytes }, 201)
  } catch (error) {
    const status = errorStatus(error)
    const code = error instanceof Error ? error.message : 'RESERVATION_FAILED'
    return context.json({ error: status === 500 ? 'RESERVATION_FAILED' : code }, status)
  }
})

assetsRoutes.put('/:id/content', async (context) => {
  const assetId = context.req.param('id')
  const uploadToken = context.req.header('X-Upload-Token')
  if (!uploadToken || !(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
    return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
  }
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const user = await requestUser(context)
  if (!user || !(await canAppUserAccessSource(context.env.DB, user, asset.source_id, 'upload'))) {
    return context.json({ error: 'APP_UPLOAD_NOT_ALLOWED' }, 403)
  }
  if (asset.storage_file_id) {
    return context.json({ asset: toPublicAsset(asset, undefined, { allowDownload: await canAppUserAccessAsset(context.env.DB, user, assetId, 'download') }), alreadyStored: true, previewAvailable: Boolean(asset.preview_file_id) }, 200)
  }
  if (asset.storage_backend === 'telegram_user_group') {
    return context.json({ error: 'LOCAL_TELEGRAM_BRIDGE_REQUIRED', storageBackend: asset.storage_backend }, 409)
  }
  const contentLengthHeader = context.req.header('Content-Length')
  if (!contentLengthHeader) return context.json({ error: 'CONTENT_LENGTH_REQUIRED' }, 411)
  const contentLength = Number(contentLengthHeader)
  if (!Number.isSafeInteger(contentLength) || contentLength !== asset.size_bytes || contentLength > MAX_UPLOAD_BYTES) {
    return context.json({ error: 'CONTENT_LENGTH_MISMATCH' }, 400)
  }
  if (!context.req.raw.body) return context.json({ error: 'EMPTY_UPLOAD_BODY' }, 400)
  if (asset.import_origin === 'ios-background' && await repairAssetFromActiveStorageObject(context.env.DB, assetId)) {
    await enqueueIfReady(context.env, assetId)
    scheduleUsageRefresh(context)
    const repaired = await getAsset(context.env.DB, assetId)
    return context.json({
      asset: repaired ? toPublicAsset(repaired, undefined, { allowDownload: await canAppUserAccessAsset(context.env.DB, user, assetId, 'download') }) : null,
      alreadyStored: true,
      recoveredOrphanedStorage: true,
      previewAvailable: Boolean(repaired?.preview_file_id),
    }, 200)
  }
  // iOS can tear down a background transfer after the request has already claimed the
  // upload row (for example after a force-quit). Without a stale lease takeover the next
  // launch retries forever with UPLOAD_ALREADY_IN_PROGRESS. Keep the lease size-aware so
  // genuinely slow larger uploads get more time before another attempt can reclaim it.
  const staleAfterMs = botUploadLeaseMs(asset.size_bytes)
  const uploadAttempt = await claimUploadStarted(context.env.DB, assetId, uploadToken, staleAfterMs)
  if (!uploadAttempt) {
    if (!(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
      return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
    }
    const latestJob = await getLatestUploadJobState(context.env.DB, assetId)
    context.header('Retry-After', String(activeUploadRetryAfterSeconds(latestJob?.updated_at, staleAfterMs)))
    return context.json({ error: 'UPLOAD_ALREADY_IN_PROGRESS' }, 409)
  }
  try {
    const storage = await storageFor(context.env, asset.source_id, true, 'telegram_bot')
    if (asset.media_type === 'photo' && asset.preview_message_id) {
      await storage.deleteMessage(asset.preview_message_id)
      await clearPreviewStored(context.env.DB, assetId)
    }
    const stored = {
      ...await storage.storeOriginal({
        body: context.req.raw.body,
        fileName: asset.original_name,
        mimeType: asset.mime_type,
        mediaType: asset.media_type,
        sizeBytes: asset.size_bytes,
        manifest: createStorageManifest(asset),
      }),
      // Preserve the reservation origin so successful native iOS uploads remain
      // diagnosable as ios-background instead of being rewritten to generic "web".
      importOrigin: asset.import_origin,
    }
    const storedResult = await markStored(context.env.DB, assetId, stored, uploadAttempt)
    if (storedResult.discardStoredMessage) {
      try { await storage.deleteMessage(stored.messageId) } catch { /* best-effort duplicate/conflict cleanup */ }
    }
    if (!storedResult.attached) {
      if (storedResult.staleAttempt) {
        context.header('Retry-After', '5')
        return context.json({ error: 'STALE_UPLOAD_ATTEMPT', recoverable: true }, 409)
      }
      await markUploadFailed(context.env.DB, assetId, 'STORAGE_OBJECT_DELETE_IN_PROGRESS', uploadAttempt)
      context.header('Retry-After', '20')
      return context.json({ error: 'STORAGE_OBJECT_DELETE_IN_PROGRESS', recoverable: true }, 409)
    }
    await enqueueIfReady(context.env, assetId)
    await logActivity(context.env.DB, { action: 'UPLOAD', assetId, detail: { reusedStorage: false } })
    scheduleUsageRefresh(context)
    const current = await getAsset(context.env.DB, assetId)
    return context.json({
      asset: current ? toPublicAsset(current, undefined, { allowDownload: await canAppUserAccessAsset(context.env.DB, user, assetId, 'download') }) : null,
      previewAvailable: Boolean(current?.preview_file_id),
    }, 201)
  } catch (error) {
    await markUploadFailed(context.env.DB, assetId, error instanceof Error ? error.message : 'UPLOAD_FAILED', uploadAttempt)
    if (error instanceof TelegramApiError && error.status === 429) {
      const retryAfter = Math.max(1, error.retryAfterSeconds ?? 30)
      context.header('Retry-After', String(retryAfter))
      return context.json({ error: 'TELEGRAM_RATE_LIMITED', retryAfter }, 429)
    }
    if (error instanceof TelegramApiError && error.status === 504) return context.json({ error: 'TELEGRAM_TIMEOUT' }, 504)
    return context.json({ error: 'STORAGE_UPLOAD_FAILED' }, 502)
  }
})

assetsRoutes.post('/:id/user-group-commit', async (context) => {
  const assetId = context.req.param('id')
  const uploadToken = context.req.header('X-Upload-Token')
  if (!uploadToken || !(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
    return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
  }
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group') return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  const user = await requestUser(context)
  if (!user || !(await canAppUserAccessSource(context.env.DB, user, asset.source_id, 'upload'))) {
    return context.json({ error: 'APP_UPLOAD_NOT_ALLOWED' }, 403)
  }
  if (user.role !== 'OWNER') return context.json({ error: 'APP_USER_GROUP_STORAGE_OWNER_REQUIRED' }, 403)
  if (asset.storage_file_id) {
    return context.json({
      asset: toPublicAsset(asset, undefined, { allowDownload: await canAppUserAccessAsset(context.env.DB, user, assetId, 'download') }),
      alreadyStored: true,
    }, 200)
  }
  const body = await context.req.json<{
    chatId?: unknown
    messageId?: unknown
    mediaId?: unknown
    sizeBytes?: unknown
  }>()
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
  const messageId = typeof body.messageId === 'number' ? body.messageId : Number.NaN
  const mediaId = body.mediaId === null || body.mediaId === undefined ? null : typeof body.mediaId === 'string' ? body.mediaId.trim() : ''
  if (!/^-?\d{1,24}$/.test(chatId) || !Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 2_147_483_647) {
    return context.json({ error: 'INVALID_TELEGRAM_RECEIPT' }, 400)
  }
  if (mediaId === '' || mediaId && mediaId.length > 160) return context.json({ error: 'INVALID_TELEGRAM_MEDIA_ID' }, 400)
  if (!Number.isSafeInteger(body.sizeBytes) || body.sizeBytes !== asset.size_bytes) return context.json({ error: 'CONTENT_LENGTH_MISMATCH' }, 409)
  const runtime = await getTelegramUserGroupRuntime(context.env.DB)
  if (!runtime.storageChatId || runtime.storageChatTitle !== 'ai') {
    return context.json({ error: 'TELEGRAM_STORAGE_CHAT_NOT_RESOLVED' }, 409)
  }
  if (chatId !== runtime.storageChatId) return context.json({ error: 'TELEGRAM_STORAGE_CHAT_MISMATCH' }, 403)

  const uploadAttempt = await claimUploadStarted(context.env.DB, assetId, uploadToken)
  if (!uploadAttempt) {
    if (!(await verifyUploadToken(context.env.DB, assetId, uploadToken))) return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
    const current = await getAsset(context.env.DB, assetId)
    if (current?.storage_file_id) return context.json({ asset: toPublicAsset(current), alreadyStored: true }, 200)
    context.header('Retry-After', '1')
    return context.json({ error: 'UPLOAD_ALREADY_IN_PROGRESS' }, 409)
  }

  try {
    const storedResult = await markStored(context.env.DB, assetId, {
      backend: 'telegram_user_group',
      chatId,
      messageId,
      fileId: `mtproto-message:${messageId}`,
      fileUniqueId: `mtproto-message:${chatId}:${messageId}`,
      mediaId: mediaId || undefined,
      importOrigin: 'web',
      telegramUrl: null,
    }, uploadAttempt)
    if (!storedResult.attached) {
      if (storedResult.staleAttempt) return context.json({ error: 'STALE_UPLOAD_ATTEMPT', recoverable: true }, 409)
      await markUploadFailed(context.env.DB, assetId, 'STORAGE_OBJECT_DELETE_IN_PROGRESS', uploadAttempt)
      return context.json({ error: 'STORAGE_OBJECT_DELETE_IN_PROGRESS', recoverable: true }, 409)
    }
    await enqueueIfReady(context.env, assetId)
    await logActivity(context.env.DB, { action: 'UPLOAD', assetId, detail: { storageBackend: 'telegram_user_group' } })
    scheduleUsageRefresh(context)
    const current = await getAsset(context.env.DB, assetId)
    return context.json({
      asset: current ? toPublicAsset(current, undefined, { allowDownload: await canAppUserAccessAsset(context.env.DB, user, assetId, 'download') }) : null,
      alreadyStored: false,
    }, 201)
  } catch (error) {
    await markUploadFailed(context.env.DB, assetId, error instanceof Error ? error.message : 'USER_GROUP_COMMIT_FAILED', uploadAttempt)
    return context.json({ error: 'USER_GROUP_COMMIT_FAILED', recoverable: true }, 502)
  }
})

assetsRoutes.post('/:id/preview', async (context) => {
  const assetId = context.req.param('id')
  const uploadToken = context.req.header('X-Upload-Token')
  if (!uploadToken || !(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
    return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
  }
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const user = await requestUser(context)
  if (!user || !(await canAppUserAccessSource(context.env.DB, user, asset.source_id, 'upload'))) {
    return context.json({ error: 'APP_UPLOAD_NOT_ALLOWED' }, 403)
  }
  if (asset.preview_file_id) return context.json({ ok: true, alreadyStored: true }, 200)
  // Photos must map to one Telegram message. Never persist a separate photo preview
  // message: the original document thumbnail is reused when Telegram provides one,
  // otherwise the photo remains usable without AI preview rather than duplicating it.
  if (asset.media_type === 'photo') return context.json({ ok: true, skipped: true }, 200)
  const length = Number(context.req.header('Content-Length') ?? 0)
  if (!Number.isFinite(length) || length <= 0 || length > 2 * 1024 * 1024) return context.json({ error: 'PREVIEW_SIZE_INVALID' }, 413)
  if (!context.req.raw.body) return context.json({ error: 'EMPTY_PREVIEW_BODY' }, 400)
  const mimeType = context.req.header('Content-Type') ?? 'image/jpeg'
  if (!['image/jpeg', 'image/webp', 'image/png'].includes(mimeType)) return context.json({ error: 'PREVIEW_TYPE_INVALID' }, 415)
  try {
    const storage = await storageFor(context.env, asset.source_id, true)
    const stored = await storage.storePreview({ body: context.req.raw.body, fileName: `${assetId}-preview.jpg`, mimeType })
    await markPreviewStored(context.env.DB, assetId, stored)
    await enqueueIfReady(context.env, assetId)
    return context.json({ ok: true }, 201)
  } catch (error) {
    if (error instanceof TelegramApiError && error.status === 429) {
      const retryAfter = Math.max(1, error.retryAfterSeconds ?? 30)
      context.header('Retry-After', String(retryAfter))
      return context.json({ error: 'TELEGRAM_RATE_LIMITED', retryAfter }, 429)
    }
    if (error instanceof TelegramApiError && error.status === 504) return context.json({ error: 'TELEGRAM_TIMEOUT' }, 504)
    return context.json({ error: 'PREVIEW_STORAGE_FAILED' }, 502)
  }
})

assetsRoutes.get('/', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const favoriteParam = context.req.query('favorite')
  const archivedParam = context.req.query('archived')
  const result = await listAssets(context.env.DB, {
    limit: Number(context.req.query('limit') ?? 30),
    cursor: context.req.query('cursor'),
    mediaType: context.req.query('mediaType'),
    favorite: favoriteParam === undefined ? undefined : favoriteParam === 'true',
    archived: archivedParam === undefined ? undefined : archivedParam === 'true',
    category: context.req.query('category'),
    fileCategory: context.req.query('fileCategory'),
    extension: context.req.query('extension'),
    mimeType: context.req.query('mimeType'),
    tag: context.req.query('tag'),
    query: context.req.query('q'),
    status: context.req.query('status'),
    albumId: context.req.query('albumId'),
    logicalPath: context.req.query('logicalPath'),
    takenAfter: context.req.query('takenAfter'),
    takenBefore: context.req.query('takenBefore'),
    minSizeBytes: optionalNonNegativeInteger(context.req.query('minSizeBytes')),
    maxSizeBytes: optionalNonNegativeInteger(context.req.query('maxSizeBytes')),
    appUserId: user.role === 'MEMBER' ? user.id : undefined,
  })
  const publicRows = await Promise.all(result.rows.map(async (row) => toPublicAsset(
    row,
    undefined,
    { allowDownload: user.role === 'OWNER' || await canAppUserAccessAsset(context.env.DB, user, row.id, 'download') },
  )))
  if (context.req.query('status') === 'trashed') {
    const albumNames = await listAlbumNamesForAssets(context.env.DB, result.rows.map((row) => row.id))
    return context.json({
      items: publicRows.map((row) => ({ ...row, albumNames: albumNames.get(row.id) ?? [] })),
      nextCursor: result.nextCursor,
    })
  }
  return context.json({ items: publicRows, nextCursor: result.nextCursor })
})

assetsRoutes.get('/:id/bridge-locator', async (context) => {
  const assetId = context.req.param('id')
  const variant = context.req.query('variant') === 'original' ? 'original' : 'preview'
  if (await assetPermissionDenied(context, assetId, variant === 'original' ? 'download' : 'read')) {
    return context.json({ error: variant === 'original' ? 'APP_DOWNLOAD_NOT_ALLOWED' : 'ASSET_NOT_FOUND' }, variant === 'original' ? 403 : 404)
  }
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group') return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  if (!asset.storage_chat_id || !asset.storage_message_id) return context.json({ error: 'MEDIA_NOT_AVAILABLE' }, 404)
  if (variant === 'preview' && !['photo', 'video'].includes(asset.media_type)) return context.json({ error: 'PREVIEW_NOT_AVAILABLE' }, 404)
  return context.json({ ok: true, chatId: asset.storage_chat_id, messageId: asset.storage_message_id, variant })
})

assetsRoutes.get('/:id/bridge-upload-authorize', async (context) => {
  const assetId = context.req.param('id')
  const uploadToken = context.req.header('X-Upload-Token')
  if (!uploadToken || !(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
    return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
  }
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group') return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  const user = await requestUser(context)
  if (!user || !(await canAppUserAccessSource(context.env.DB, user, asset.source_id, 'upload'))) {
    return context.json({ error: 'APP_UPLOAD_NOT_ALLOWED' }, 403)
  }
  if (user.role !== 'OWNER') return context.json({ error: 'APP_USER_GROUP_STORAGE_OWNER_REQUIRED' }, 403)
  if (asset.storage_file_id) return context.json({ error: 'ASSET_ALREADY_STORED' }, 409)
  return context.json({ ok: true, sizeBytes: asset.size_bytes, originalName: asset.original_name, mimeType: asset.mime_type })
})

assetsRoutes.get('/:id/bridge-delete-locator', async (context) => {
  const assetId = context.req.param('id')
  if (await assetPermissionDenied(context, assetId, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset || asset.status !== 'trashed') return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group' || !asset.storage_object_id) return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  const state = await context.env.DB.prepare(`SELECT delete_state FROM storage_objects WHERE id = ? AND workspace_id = ?`)
    .bind(asset.storage_object_id, 'personal').first<{ delete_state: string }>()
  if (state?.delete_state !== 'deleting') return context.json({ error: 'PURGE_NOT_PREPARED' }, 409)
  if (!asset.storage_chat_id || !asset.storage_message_id) return context.json({ error: 'TELEGRAM_MESSAGE_ID_MISSING' }, 409)
  return context.json({ ok: true, chatId: asset.storage_chat_id, messageId: asset.storage_message_id })
})

assetsRoutes.get('/:id/preview', async (context) => {
  const assetId = context.req.param('id')
  if (await assetPermissionDenied(context, assetId, 'read')) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend === 'telegram_user_group') {
    if (!asset.storage_message_id) return context.json({ error: 'PREVIEW_NOT_AVAILABLE' }, 404)
    return context.json({ error: 'LOCAL_TELEGRAM_BRIDGE_REQUIRED', recoverable: true }, 409)
  }

  const browserCacheControl = 'private, max-age=604800, immutable'
  const edgeCache = await openEdgeMediaCache()
  const cacheKey = edgeMediaCacheKey(context.req.raw, 'preview', asset.id)
  const edgeHit = await matchEdgeMedia(edgeCache, cacheKey, browserCacheControl)
  if (edgeHit) return edgeHit

  if (context.env.MOCK_TELEGRAM === 'true') {
    return storeEdgeMedia(edgeCache, cacheKey, mockPreview(asset.id, asset.original_name, asset.primary_category, asset.width, asset.height), {
      browserCacheControl,
      edgeTtlSeconds: EDGE_MEDIA_TTL.preview,
      source: 'mock',
      waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    })
  }

  const canDownload = await canDownloadForRequest(context, assetId)
  const fileId = asset.preview_file_id ?? (canDownload && asset.media_type === 'photo' && asset.size_bytes <= 20 * 1024 * 1024 && isSafeInlineMediaType(asset.mime_type) ? asset.storage_file_id : null)
  if (!fileId) return context.json({ error: 'PREVIEW_NOT_AVAILABLE' }, 404)

  const response = await fetchPreviewCached(
    () => storageFor(context.env, asset.source_id),
    fileId,
    context.env.PREVIEW_CACHE,
    (promise) => context.executionCtx.waitUntil(promise),
  )
  const source: EdgeMediaSource = response.headers.get('X-Private-Archive-Preview-Cache') === 'kv' ? 'kv' : 'telegram'
  const previewHeaders = applySafeMediaHeaders(new Headers(response.headers), {
    fileName: `preview-${asset.original_name}`,
    mimeType: response.headers.get('Content-Type') ?? asset.mime_type,
  })
  const safePreview = new Response(response.body, { status: response.status, headers: previewHeaders })
  return storeEdgeMedia(edgeCache, cacheKey, safePreview, {
    browserCacheControl,
    edgeTtlSeconds: EDGE_MEDIA_TTL.preview,
    source,
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
  })
})

assetsRoutes.get('/:id/media', async (context) => {
  const assetId = context.req.param('id')
  if (await assetPermissionDenied(context, assetId, 'download')) return context.json({ error: 'APP_DOWNLOAD_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend === 'telegram_user_group') {
    if (!asset.storage_message_id) return context.json({ error: 'MEDIA_NOT_AVAILABLE' }, 404)
    return context.json({ error: 'LOCAL_TELEGRAM_BRIDGE_REQUIRED', recoverable: true }, 409)
  }
  if (asset.size_bytes > 20 * 1024 * 1024) return context.json({ error: 'ORIGINAL_AVAILABLE_IN_TELEGRAM_ONLY' }, 409)
  if (!asset.storage_file_id) return context.json({ error: 'MEDIA_NOT_AVAILABLE' }, 404)

  const range = context.req.header('Range')
  const edgeEligible = asset.media_type === 'photo' && isSafeInlineMediaType(asset.mime_type) && !range
  const browserCacheControl = edgeEligible ? 'private, max-age=3600' : 'private, no-store'
  const edgeCache = edgeEligible ? await openEdgeMediaCache() : null
  const cacheKey = edgeEligible ? edgeMediaCacheKey(context.req.raw, 'photo', asset.id) : null
  if (cacheKey && edgeCache) {
    const edgeHit = await matchEdgeMedia(edgeCache, cacheKey, browserCacheControl)
    if (edgeHit) return edgeHit
  }

  if (context.env.MOCK_TELEGRAM === 'true') {
    const response = mockPreview(asset.id, asset.original_name, asset.primary_category, asset.width, asset.height)
    if (!cacheKey || !edgeCache) {
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', browserCacheControl)
      headers.set('X-Private-Archive-Edge-Cache', 'BYPASS')
      headers.set('X-Private-Archive-Upstream', 'mock')
      headers.set('Server-Timing', 'edge-cache;desc="BYPASS", upstream;desc="mock"')
      return new Response(response.body, { status: response.status, headers })
    }
    return storeEdgeMedia(edgeCache, cacheKey, response, {
      browserCacheControl,
      edgeTtlSeconds: EDGE_MEDIA_TTL.photo,
      source: 'mock',
      waitUntil: (promise) => context.executionCtx.waitUntil(promise),
    })
  }

  const response = await (await storageFor(context.env, asset.source_id)).fetchFile(asset.storage_file_id, range ? { headers: { Range: range } } : undefined)
  const responseMimeType = resolveOriginalMediaMimeType({
    fileName: asset.original_name,
    upstreamMimeType: response.headers.get('Content-Type'),
    storedMimeType: asset.mime_type,
  })
  const headers = applySafeMediaHeaders(new Headers({
    'Cache-Control': browserCacheControl,
    'X-Private-Archive-Upstream': 'telegram',
  }), {
    fileName: asset.original_name,
    mimeType: responseMimeType,
  })
  for (const name of ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (asset.media_type === 'video' && !headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes')
  if (!cacheKey || !edgeCache) {
    headers.set('X-Private-Archive-Edge-Cache', 'BYPASS')
    headers.set('Server-Timing', 'edge-cache;desc="BYPASS", upstream;desc="telegram"')
    return new Response(response.body, { status: response.status, headers })
  }
  const mediaResponse = new Response(response.body, { status: response.status, headers })
  return storeEdgeMedia(edgeCache, cacheKey, mediaResponse, {
    browserCacheControl,
    edgeTtlSeconds: EDGE_MEDIA_TTL.photo,
    source: 'telegram',
    waitUntil: (promise) => context.executionCtx.waitUntil(promise),
  })
})

assetsRoutes.post('/bulk-trash', async (context) => {
  const body = await context.req.json<{ ids?: unknown }>()
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 90 || body.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 120)) {
    return context.json({ error: 'INVALID_ASSET_IDS' }, 400)
  }
  if (await bulkPermissionDenied(context, body.ids as string[], 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const deleted = await bulkSoftDeleteAssets(context.env.DB, body.ids as string[])
  if (deleted) {
    await logActivity(context.env.DB, { action: 'DELETE', detail: { count: deleted, bulk: true } })
    scheduleUsageRefresh(context)
  }
  return context.json({ ok: true, deleted, telegramDeleted: false })
})

assetsRoutes.post('/bulk-discard-unstored', async (context) => {
  const body = await context.req.json<{ ids?: unknown }>()
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 90 || body.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 120)) {
    return context.json({ error: 'INVALID_ASSET_IDS' }, 400)
  }
  if (await bulkPermissionDenied(context, body.ids as string[], 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const discarded = await bulkDiscardUnstoredAssets(context.env.DB, body.ids as string[])
  if (discarded) await logActivity(context.env.DB, { action: 'DELETE', detail: { count: discarded, bulk: true, reason: 'discard-unstored-upload' } })
  return context.json({ ok: true, discarded })
})

assetsRoutes.post('/bulk-restore', async (context) => {
  const body = await context.req.json<{ ids?: unknown }>()
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 90 || body.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 120)) {
    return context.json({ error: 'INVALID_ASSET_IDS' }, 400)
  }
  if (await bulkPermissionDenied(context, body.ids as string[], 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const restored = await bulkRestoreAssets(context.env.DB, body.ids as string[])
  if (restored) {
    await logActivity(context.env.DB, { action: 'RESTORE', detail: { count: restored, bulk: true } })
    scheduleUsageRefresh(context)
  }
  return context.json({ ok: true, restored })
})

assetsRoutes.post('/bulk-patch', async (context) => {
  const body = await context.req.json<{ ids?: unknown; favorite?: unknown; archived?: unknown; tags?: unknown }>()
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 50 || body.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 120)) {
    return context.json({ error: 'INVALID_ASSET_IDS' }, 400)
  }
  if (body.favorite !== undefined && typeof body.favorite !== 'boolean') return context.json({ error: 'INVALID_FAVORITE' }, 400)
  if (body.archived !== undefined && typeof body.archived !== 'boolean') return context.json({ error: 'INVALID_ARCHIVE' }, 400)
  if (body.tags !== undefined && (!Array.isArray(body.tags) || body.tags.length > 10 || body.tags.some((tag) => typeof tag !== 'string'))) {
    return context.json({ error: 'INVALID_TAGS' }, 400)
  }
  if (body.favorite === undefined && body.archived === undefined && body.tags === undefined) return context.json({ error: 'INVALID_PATCH' }, 400)
  const ids = body.ids as string[]
  if (await bulkPermissionDenied(context, ids, 'edit')) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const updated = await bulkPatchAssetFlags(context.env.DB, ids, {
    favorite: body.favorite as boolean | undefined,
    archived: body.archived as boolean | undefined,
  })
  const tagged = body.tags === undefined ? 0 : await setManualTagsForAssets(context.env.DB, ids, body.tags as string[])
  if (body.favorite !== undefined) await logActivity(context.env.DB, { action: 'FAVORITE', detail: { bulk: true, count: updated, value: body.favorite } })
  if (body.archived !== undefined) await logActivity(context.env.DB, { action: 'ARCHIVE', detail: { bulk: true, count: updated, value: body.archived } })
  if (body.tags !== undefined) await logActivity(context.env.DB, { action: 'TAG', detail: { bulk: true, count: tagged } })
  return context.json({ ok: true, updated, tagged })
})

assetsRoutes.get('/:id', async (context) => {
  const assetId = context.req.param('id')
  if (await assetPermissionDenied(context, assetId, 'read')) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, assetId)
  if (!asset) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.status !== 'trashed') context.executionCtx.waitUntil(markAssetViewed(context.env.DB, asset.id))
  return context.json({ asset: toPublicAsset(asset, await getTagsForAsset(context.env.DB, asset.id), { allowDownload: await canDownloadForRequest(context, asset.id) }) })
})

assetsRoutes.put('/:id/tags', async (context) => {
  const body = await context.req.json<{ tags?: unknown }>()
  if (!Array.isArray(body.tags) || body.tags.length > 20 || body.tags.some((tag) => typeof tag !== 'string' || tag.length > 80)) {
    return context.json({ error: 'INVALID_TAGS' }, 400)
  }
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'edit')) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  if (!(await setManualTags(context.env.DB, id, body.tags as string[]))) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  await logActivity(context.env.DB, { action: 'TAG', assetId: id, detail: { count: body.tags.length } })
  const asset = await getAsset(context.env.DB, id)
  return context.json({ asset: asset ? toPublicAsset(asset, await getTagsForAsset(context.env.DB, id), { allowDownload: await canDownloadForRequest(context, id) }) : null })
})

assetsRoutes.patch('/:id', async (context) => {
  const body = await context.req.json<{
    favorite?: unknown
    archived?: unknown
    categoryOverride?: unknown
    logicalPath?: unknown
    originalName?: unknown
  }>()
  const patch: {
    favorite?: boolean
    archived?: boolean
    categoryOverride?: string | null
    logicalPath?: string
    originalName?: string
  } = {}
  if (typeof body.favorite === 'boolean') patch.favorite = body.favorite
  else if (body.favorite !== undefined) return context.json({ error: 'INVALID_FAVORITE' }, 400)
  if (typeof body.archived === 'boolean') patch.archived = body.archived
  else if (body.archived !== undefined) return context.json({ error: 'INVALID_ARCHIVE' }, 400)
  if (body.categoryOverride === null) {
    patch.categoryOverride = null
  } else if (typeof body.categoryOverride === 'string') {
    const module = await getDiscoverModule(context.env.DB, body.categoryOverride)
    if (!module || module.kind !== 'category') return context.json({ error: 'DISCOVER_MODULE_NOT_FOUND' }, 400)
    patch.categoryOverride = module.slug
  } else if (body.categoryOverride !== undefined) {
    return context.json({ error: 'INVALID_CATEGORY_OVERRIDE' }, 400)
  }
  if (body.logicalPath !== undefined) {
    if (typeof body.logicalPath !== 'string' || body.logicalPath.length > 512) return context.json({ error: 'INVALID_LOGICAL_PATH' }, 400)
    patch.logicalPath = sanitizeLogicalPath(body.logicalPath)
  }
  if (body.originalName !== undefined) {
    if (typeof body.originalName !== 'string' || !body.originalName.trim() || body.originalName.length > 255 || hasUnsafeControlCharacters(body.originalName)) {
      return context.json({ error: 'INVALID_FILE_NAME' }, 400)
    }
    patch.originalName = body.originalName.trim()
  }
  if (Object.keys(patch).length === 0) return context.json({ error: 'INVALID_PATCH' }, 400)
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'edit')) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const updated = await patchAsset(context.env.DB, id, patch)
  if (!updated) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (patch.favorite !== undefined) await logActivity(context.env.DB, { action: 'FAVORITE', assetId: id, detail: { value: patch.favorite } })
  if (patch.archived !== undefined) await logActivity(context.env.DB, { action: 'ARCHIVE', assetId: id, detail: { value: patch.archived } })
  if (patch.logicalPath !== undefined) await logActivity(context.env.DB, { action: 'MOVE', assetId: id, detail: { path: patch.logicalPath } })
  if (patch.originalName !== undefined) await logActivity(context.env.DB, { action: 'RENAME', assetId: id })
  const asset = await getAsset(context.env.DB, id)
  return context.json({ asset: asset ? toPublicAsset(asset, await getTagsForAsset(context.env.DB, asset.id), { allowDownload: await canDownloadForRequest(context, id) }) : null })
})

assetsRoutes.post('/:id/restore', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const restored = await restoreAsset(context.env.DB, id)
  if (!restored) return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  await logActivity(context.env.DB, { action: 'RESTORE', assetId: id })
  scheduleUsageRefresh(context)
  const asset = await getAsset(context.env.DB, id)
  return context.json({ ok: true, asset: asset ? toPublicAsset(asset, undefined, { allowDownload: await canDownloadForRequest(context, id) }) : null })
})

assetsRoutes.post('/:id/user-group-purge-prepare', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status !== 'trashed') return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group') return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  if (!asset.storage_object_id) return context.json({ error: 'STORAGE_OBJECT_NOT_FOUND' }, 409)

  const claim = await claimStorageObjectForPurge(context.env.DB, asset.storage_object_id, id)
  if (claim === 'shared') {
    await deleteLogicalAsset(context.env.DB, id)
    await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: false, sharedObject: true, storageBackend: asset.storage_backend } })
    scheduleUsageRefresh(context)
    return context.json({ ok: true, action: 'complete' as const, telegramDeleted: false, sharedObjectPreserved: true })
  }
  if (claim === 'deleted') {
    await deleteLogicalAsset(context.env.DB, id)
    await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: true, resumed: true, storageBackend: asset.storage_backend } })
    scheduleUsageRefresh(context)
    return context.json({ ok: true, action: 'complete' as const, telegramDeleted: true, sharedObjectPreserved: false })
  }
  if (claim === 'busy') {
    context.header('Retry-After', '1')
    return context.json({ error: 'PURGE_ALREADY_IN_PROGRESS', recoverable: true }, 409)
  }
  if (claim === 'missing') return context.json({ error: 'STORAGE_OBJECT_NOT_FOUND', recoverable: true }, 409)
  if (!asset.storage_chat_id || !asset.storage_message_id) {
    await markStorageObjectDeleteFailed(context.env.DB, asset.storage_object_id, 'TELEGRAM_MESSAGE_ID_MISSING')
    await markPurgeFailure(context.env.DB, id, 'TELEGRAM_MESSAGE_ID_MISSING')
    return context.json({ error: 'TELEGRAM_MESSAGE_ID_MISSING', recoverable: true }, 409)
  }
  return context.json({
    ok: true,
    action: 'delete_telegram' as const,
    sharedObjectPreserved: false,
  })
})

assetsRoutes.post('/:id/user-group-purge-finalize', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status !== 'trashed') return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group' || !asset.storage_object_id) return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  const finalized = await markStorageObjectDeleted(context.env.DB, asset.storage_object_id)
  if (!finalized) return context.json({ error: 'PURGE_NOT_PREPARED', recoverable: true }, 409)
  await deleteLogicalAsset(context.env.DB, id)
  await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: true, sharedObject: false, storageBackend: asset.storage_backend } })
  scheduleUsageRefresh(context)
  return context.json({ ok: true, telegramDeleted: true, sharedObjectPreserved: false })
})

assetsRoutes.post('/:id/user-group-purge-failed', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status !== 'trashed') return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend !== 'telegram_user_group' || !asset.storage_object_id) return context.json({ error: 'STORAGE_BACKEND_MISMATCH' }, 409)
  const body: { error?: unknown } = await context.req.json<{ error?: unknown }>().catch(() => ({}))
  const message = typeof body.error === 'string' && body.error.trim() ? body.error.trim().slice(0, 320) : 'TELEGRAM_DELETE_FAILED'
  await markStorageObjectDeleteFailed(context.env.DB, asset.storage_object_id, message)
  await markPurgeFailure(context.env.DB, id, message)
  return context.json({ ok: true, recoverable: true })
})

assetsRoutes.delete('/:id/purge', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status !== 'trashed') return context.json({ error: 'TRASHED_ASSET_NOT_FOUND' }, 404)
  if (asset.storage_backend === 'telegram_user_group') {
    return context.json({ error: 'LOCAL_TELEGRAM_BRIDGE_REQUIRED', recoverable: true }, 409)
  }

  const storageObjectId = asset.storage_object_id
  if (storageObjectId) {
    const claim = await claimStorageObjectForPurge(context.env.DB, storageObjectId, id)
    if (claim === 'shared') {
      await deleteLogicalAsset(context.env.DB, id)
      await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: false, sharedObject: true } })
      scheduleUsageRefresh(context)
      return context.json({ ok: true, telegramDeleted: false, sharedObjectPreserved: true })
    }
    if (claim === 'deleted') {
      await deleteLogicalAsset(context.env.DB, id)
      await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: true, resumed: true } })
      scheduleUsageRefresh(context)
      return context.json({ ok: true, telegramDeleted: true, sharedObjectPreserved: false })
    }
    if (claim === 'busy') {
      context.header('Retry-After', '1')
      return context.json({ error: 'PURGE_ALREADY_IN_PROGRESS', recoverable: true }, 409)
    }
    if (claim === 'missing') return context.json({ error: 'STORAGE_OBJECT_NOT_FOUND', recoverable: true }, 409)
  }

  try {
    if (asset.storage_message_id) {
      const storage = await storageFor(context.env, asset.source_id)
      const messages = [asset.preview_message_id, asset.storage_message_id]
        .filter((messageId): messageId is number => Number.isSafeInteger(messageId))
        .filter((messageId, index, all) => all.indexOf(messageId) === index)
      for (const messageId of messages) await storage.deleteMessage(messageId)
    }
    if (storageObjectId && !(await markStorageObjectDeleted(context.env.DB, storageObjectId))) {
      await markPurgeFailure(context.env.DB, id, 'PURGE_STATE_INVALID')
      return context.json({ error: 'PURGE_STATE_INVALID', recoverable: true }, 409)
    }
    await deleteLogicalAsset(context.env.DB, id)
    await logActivity(context.env.DB, { action: 'PURGE', assetId: id, detail: { telegramDeleted: Boolean(asset.storage_message_id), sharedObject: false } })
    scheduleUsageRefresh(context)
    return context.json({ ok: true, telegramDeleted: Boolean(asset.storage_message_id), sharedObjectPreserved: false })
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TELEGRAM_DELETE_FAILED'
    if (storageObjectId) await markStorageObjectDeleteFailed(context.env.DB, storageObjectId, message)
    await markPurgeFailure(context.env.DB, id, message)
    if (error instanceof TelegramApiError && error.status === 429) {
      const retryAfter = Math.max(1, error.retryAfterSeconds ?? 30)
      context.header('Retry-After', String(retryAfter))
      return context.json({ error: 'TELEGRAM_RATE_LIMITED', retryAfter, recoverable: true }, 429)
    }
    if (error instanceof TelegramApiError && error.status === 504) return context.json({ error: 'TELEGRAM_TIMEOUT', recoverable: true }, 504)
    return context.json({ error: 'TELEGRAM_DELETE_FAILED', recoverable: true }, 502)
  }
})

assetsRoutes.delete('/:id', async (context) => {
  const id = context.req.param('id')
  if (await assetPermissionDenied(context, id, 'delete')) return context.json({ error: 'APP_DELETE_NOT_ALLOWED' }, 403)
  const updated = await softDeleteAsset(context.env.DB, id)
  if (!updated) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  await logActivity(context.env.DB, { action: 'DELETE', assetId: id })
  scheduleUsageRefresh(context)
  return context.json({ ok: true, telegramDeleted: false })
})
