import { Hono } from 'hono'
import {
  bulkSoftDeleteAssets, createPendingAsset, createUploadJobForAsset, getActiveAssetByContentHash, getAsset, getLatestUploadJobState, getTagsForAsset, listAssets,
  claimUploadStarted, markPreviewStored, markQueued, markReadyWithoutAnalysis, markStored, markUploadFailed, patchAsset, softDeleteAsset, verifyUploadToken,
} from '../db/assets-repository'
import { getTelegramRuntimeConfig } from '../db/settings-repository'
import { getDiscoverModule } from '../db/discover-modules-repository'
import { MAX_UPLOAD_BYTES, UPLOAD_TOKEN_TTL_MS, getSizeTier, selectTakenAt, validateReserveInput } from '../domain/policy'
import { toPublicAsset } from '../domain/types'
import type { Env } from '../env'
import { isMockMode } from '../env'
import { createUploadToken } from '../lib/crypto'
import { requireOwner } from '../lib/security'
import { createStorageAdapter } from '../services/storage/factory'
import { fetchPreviewCached } from '../services/storage/preview-cache'
import { TelegramApiError } from '../services/telegram/telegram-client'

export const assetsRoutes = new Hono<{ Bindings: Env }>()
assetsRoutes.use('*', requireOwner)

async function storageFor(env: Env) {
  const config = await getTelegramRuntimeConfig(env.DB, env)
  return createStorageAdapter(env, config.storageChatId)
}

function errorStatus(error: unknown): 400 | 413 | 500 {
  if (error instanceof Error && error.message === 'FILE_TOO_LARGE') return 413
  if (error instanceof Error && error.message.startsWith('INVALID_')) return 400
  return 500
}

function mockPreview(assetId: string, title: string, category: string | null, width: number | null, height: number | null): Response {
  const palettes = [
    ['#74806c', '#d9cdbb', '#39443a'], ['#94715f', '#d7b697', '#413b35'], ['#5d7180', '#c6d0d2', '#2c3941'],
    ['#8c805c', '#d8cfac', '#49452f'], ['#76677b', '#c9bdca', '#38313a'], ['#4f756d', '#b7d0c8', '#2b403b'],
  ]
  const hash = [...assetId].reduce((value, char) => value + char.charCodeAt(0), 0)
  const palette = palettes[hash % palettes.length]
  const safeTitle = title.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 36)
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
  if (asset.media_type === 'file' && !asset.preview_file_id) {
    await markReadyWithoutAnalysis(env.DB, assetId)
    return
  }
  if (!asset.preview_file_id) return
  await env.ANALYSIS_QUEUE.send({ assetId, previewFileId: asset.preview_file_id, jobType: 'analyze' })
  await markQueued(env.DB, assetId)
}

assetsRoutes.post('/reserve', async (context) => {
  try {
    const input = validateReserveInput(await context.req.json())
    if (!isMockMode(context.env)) {
      const telegram = await getTelegramRuntimeConfig(context.env.DB, context.env)
      if (!context.env.TELEGRAM_BOT_TOKEN) return context.json({ error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' }, 503)
      if (!telegram.storageChatId) return context.json({ error: 'TELEGRAM_STORAGE_CHAT_ID_NOT_CONFIGURED' }, 503)
    }
    const uploadedAt = new Date().toISOString()
    const takenAt = selectTakenAt({ exifTakenAt: input.takenAt, fileCreatedAt: input.fileCreatedAt, uploadedAt })
    const tokenExpiresAt = new Date(Date.now() + UPLOAD_TOKEN_TTL_MS).toISOString()
    const sizeTier = getSizeTier(input.sizeBytes)
    const reserveExisting = async (existing: NonNullable<Awaited<ReturnType<typeof getActiveAssetByContentHash>>>) => {
      if (existing.storage_file_id) {
        return context.json({ assetId: existing.id, duplicate: true, sizeTier, maxUploadBytes: MAX_UPLOAD_BYTES }, 200)
      }
      if (existing.source === 'web') {
        const latestJob = await getLatestUploadJobState(context.env.DB, existing.id)
        const activeJob = latestJob && ['waiting', 'uploading'].includes(latestJob.status) && Date.parse(latestJob.expires_at) > Date.now()
        if (activeJob) {
          context.header('Retry-After', '1')
          return context.json({
            error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: existing.id, duplicate: false, resumed: true,
            sizeTier, maxUploadBytes: MAX_UPLOAD_BYTES,
          }, 409)
        }
        const token = createUploadToken()
        await createUploadJobForAsset(context.env.DB, { assetId: existing.id, jobId: crypto.randomUUID(), token, tokenExpiresAt })
        return context.json({ assetId: existing.id, uploadToken: token, duplicate: false, resumed: true, sizeTier, maxUploadBytes: MAX_UPLOAD_BYTES }, 200)
      }
      context.header('Retry-After', '1')
      return context.json({ error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: existing.id, duplicate: false, sizeTier, maxUploadBytes: MAX_UPLOAD_BYTES }, 409)
    }

    const existing = input.contentHash ? await getActiveAssetByContentHash(context.env.DB, input.contentHash) : null
    if (existing) return reserveExisting(existing)

    const id = crypto.randomUUID()
    const token = createUploadToken()
    try {
      await createPendingAsset(context.env.DB, {
        id, jobId: crypto.randomUUID(), token, input, takenAt, uploadedAt, tokenExpiresAt,
      })
    } catch (error) {
      if (input.contentHash) {
        const raced = await getActiveAssetByContentHash(context.env.DB, input.contentHash)
        if (raced) return reserveExisting(raced)
      }
      throw error
    }
    return context.json({ assetId: id, uploadToken: token, duplicate: false, resumed: false, sizeTier, maxUploadBytes: MAX_UPLOAD_BYTES }, 201)
  } catch (error) {
    const status = errorStatus(error)
    return context.json({ error: error instanceof Error ? error.message : 'RESERVATION_FAILED' }, status)
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
  if (asset.storage_file_id) return context.json({ asset: toPublicAsset(asset), alreadyStored: true }, 200)
  const contentLength = Number(context.req.header('Content-Length') ?? asset.size_bytes)
  if (!Number.isFinite(contentLength) || contentLength !== asset.size_bytes || contentLength > MAX_UPLOAD_BYTES) {
    return context.json({ error: 'CONTENT_LENGTH_MISMATCH' }, 400)
  }
  if (!context.req.raw.body) return context.json({ error: 'EMPTY_UPLOAD_BODY' }, 400)
  const claimed = await claimUploadStarted(context.env.DB, assetId, uploadToken)
  if (!claimed) {
    if (!(await verifyUploadToken(context.env.DB, assetId, uploadToken))) {
      return context.json({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' }, 401)
    }
    context.header('Retry-After', '1')
    return context.json({ error: 'UPLOAD_ALREADY_IN_PROGRESS' }, 409)
  }
  try {
    const storage = await storageFor(context.env)
    const stored = await storage.storeOriginal({
      body: context.req.raw.body,
      fileName: asset.original_name,
      mimeType: asset.mime_type,
      mediaType: asset.media_type,
      sizeBytes: asset.size_bytes,
    })
    await markStored(context.env.DB, assetId, stored)
    await enqueueIfReady(context.env, assetId)
    const current = await getAsset(context.env.DB, assetId)
    return context.json({ asset: current ? toPublicAsset(current) : null }, 201)
  } catch (error) {
    await markUploadFailed(context.env.DB, assetId, error instanceof Error ? error.message : 'UPLOAD_FAILED')
    if (error instanceof TelegramApiError && error.status === 429) {
      const retryAfter = Math.max(1, error.retryAfterSeconds ?? 30)
      context.header('Retry-After', String(retryAfter))
      return context.json({ error: 'TELEGRAM_RATE_LIMITED', retryAfter }, 429)
    }
    if (error instanceof TelegramApiError && error.status === 504) return context.json({ error: 'TELEGRAM_TIMEOUT' }, 504)
    return context.json({ error: 'STORAGE_UPLOAD_FAILED' }, 502)
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
  if (asset.preview_file_id) return context.json({ ok: true, alreadyStored: true }, 200)
  const length = Number(context.req.header('Content-Length') ?? 0)
  if (!Number.isFinite(length) || length <= 0 || length > 2 * 1024 * 1024) return context.json({ error: 'PREVIEW_SIZE_INVALID' }, 413)
  if (!context.req.raw.body) return context.json({ error: 'EMPTY_PREVIEW_BODY' }, 400)
  const mimeType = context.req.header('Content-Type') ?? 'image/jpeg'
  if (!['image/jpeg', 'image/webp', 'image/png'].includes(mimeType)) return context.json({ error: 'PREVIEW_TYPE_INVALID' }, 415)
  try {
    const storage = await storageFor(context.env)
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
  const favoriteParam = context.req.query('favorite')
  const result = await listAssets(context.env.DB, {
    limit: Number(context.req.query('limit') ?? 30),
    cursor: context.req.query('cursor'),
    mediaType: context.req.query('mediaType'),
    favorite: favoriteParam === undefined ? undefined : favoriteParam === 'true',
    category: context.req.query('category'),
    query: context.req.query('q'),
    status: context.req.query('status'),
    albumId: context.req.query('albumId'),
    takenAfter: context.req.query('takenAfter'),
    takenBefore: context.req.query('takenBefore'),
  })
  return context.json({ items: result.rows.map((row) => toPublicAsset(row)), nextCursor: result.nextCursor })
})

assetsRoutes.get('/:id/preview', async (context) => {
  const asset = await getAsset(context.env.DB, context.req.param('id'))
  if (!asset || asset.status === 'trashed') return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (context.env.MOCK_TELEGRAM === 'true') return mockPreview(asset.id, asset.original_name, asset.primary_category, asset.width, asset.height)
  const fileId = asset.preview_file_id ?? (asset.media_type === 'photo' && asset.size_bytes <= 20 * 1024 * 1024 ? asset.storage_file_id : null)
  if (!fileId) return context.json({ error: 'PREVIEW_NOT_AVAILABLE' }, 404)

  return fetchPreviewCached(
    () => storageFor(context.env),
    fileId,
    context.env.PREVIEW_CACHE,
    (promise) => context.executionCtx.waitUntil(promise),
  )
})

assetsRoutes.get('/:id/media', async (context) => {
  const asset = await getAsset(context.env.DB, context.req.param('id'))
  if (!asset || asset.status === 'trashed') return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (asset.size_bytes > 20 * 1024 * 1024) return context.json({ error: 'ORIGINAL_AVAILABLE_IN_TELEGRAM_ONLY', telegramUrl: asset.telegram_url }, 409)
  if (context.env.MOCK_TELEGRAM === 'true') return mockPreview(asset.id, asset.original_name, asset.primary_category, asset.width, asset.height)
  if (!asset.storage_file_id) return context.json({ error: 'MEDIA_NOT_AVAILABLE' }, 404)
  const range = context.req.header('Range')
  const response = await (await storageFor(context.env)).fetchFile(asset.storage_file_id, range ? { headers: { Range: range } } : undefined)
  const headers = new Headers({
    'Content-Type': response.headers.get('Content-Type') ?? asset.mime_type,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(asset.original_name)}`,
    'Cache-Control': asset.media_type === 'photo' ? 'private, max-age=3600' : 'private, no-store',
  })
  for (const name of ['Content-Range', 'Content-Length', 'Accept-Ranges', 'ETag', 'Last-Modified']) {
    const value = response.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (asset.media_type === 'video' && !headers.has('Accept-Ranges')) headers.set('Accept-Ranges', 'bytes')
  return new Response(response.body, { status: response.status, headers })
})

assetsRoutes.post('/bulk-trash', async (context) => {
  const body = await context.req.json<{ ids?: unknown }>()
  if (!Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100 || body.ids.some((id) => typeof id !== 'string' || id.length < 1 || id.length > 120)) {
    return context.json({ error: 'INVALID_ASSET_IDS' }, 400)
  }
  const deleted = await bulkSoftDeleteAssets(context.env.DB, body.ids as string[])
  return context.json({ ok: true, deleted, telegramDeleted: false })
})

assetsRoutes.get('/:id', async (context) => {
  const asset = await getAsset(context.env.DB, context.req.param('id'))
  if (!asset || asset.status === 'trashed') return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  return context.json({ asset: toPublicAsset(asset, await getTagsForAsset(context.env.DB, asset.id)) })
})

assetsRoutes.patch('/:id', async (context) => {
  const body = await context.req.json<{ favorite?: unknown; categoryOverride?: unknown }>()
  const patch: { favorite?: boolean; categoryOverride?: string | null } = {}
  if (typeof body.favorite === 'boolean') patch.favorite = body.favorite
  if (body.categoryOverride === null) {
    patch.categoryOverride = null
  } else if (typeof body.categoryOverride === 'string') {
    const module = await getDiscoverModule(context.env.DB, body.categoryOverride)
    if (!module || module.kind !== 'category') return context.json({ error: 'DISCOVER_MODULE_NOT_FOUND' }, 400)
    patch.categoryOverride = module.slug
  } else if (body.categoryOverride !== undefined) {
    return context.json({ error: 'INVALID_CATEGORY_OVERRIDE' }, 400)
  }
  if (patch.favorite === undefined && patch.categoryOverride === undefined) return context.json({ error: 'INVALID_PATCH' }, 400)
  const updated = await patchAsset(context.env.DB, context.req.param('id'), patch)
  if (!updated) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, context.req.param('id'))
  return context.json({ asset: asset ? toPublicAsset(asset, asset ? await getTagsForAsset(context.env.DB, asset.id) : undefined) : null })
})

assetsRoutes.delete('/:id', async (context) => {
  const updated = await softDeleteAsset(context.env.DB, context.req.param('id'))
  return updated ? context.json({ ok: true, telegramDeleted: false }) : context.json({ error: 'ASSET_NOT_FOUND' }, 404)
})
