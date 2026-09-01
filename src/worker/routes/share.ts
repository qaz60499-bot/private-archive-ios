import { Hono, type Context } from 'hono'
import { getAsset, getTagsForAsset, listAssets, PERSONAL_WORKSPACE_ID } from '../db/assets-repository'
import { canPrincipalAccessAsset, deleteShareSession, exchangeShareToken, listAccessibleAlbumIds } from '../db/share-access-repository'
import { resolveTelegramSourceConfig } from '../db/telegram-sources-repository'
import { toPublicAsset } from '../domain/types'
import type { AssetRow, PublicAsset } from '../domain/types'
import type { Env } from '../env'
import { isMockMode } from '../env'
import { SHARE_SESSION_COOKIE, clearShareSessionCookie, isShareHostAllowed, readCookie, resolveShareRequestPrincipal, shareSessionCookie } from '../lib/share-security'
import { applySafeMediaHeaders, isSafeInlineMediaType } from '../lib/media-response'
import { readBoundedJsonObject } from '../lib/request-json'
import { createStorageAdapterFromConfig } from '../services/storage/factory'

export const shareRoutes = new Hono<{ Bindings: Env }>()

shareRoutes.use('*', async (context, next) => {
  if (!isShareHostAllowed(context.env, context.req.url)) return context.json({ error: 'SHARE_HOST_REQUIRED' }, 404)
  await next()
})

function secureCookie(requestUrl: string): boolean {
  return new URL(requestUrl).protocol === 'https:'
}

async function principalFor(context: { env: Env; req: { raw: Request } }) {
  return resolveShareRequestPrincipal(context.env, context.req.raw)
}

async function storageFor(env: Env, sourceId: string) {
  if (isMockMode(env)) return createStorageAdapterFromConfig(env, { token: 'mock', storageChatId: '-1000000000000' })
  const config = await resolveTelegramSourceConfig(env.DB, env, sourceId)
  return createStorageAdapterFromConfig(env, config)
}

function sharedAsset(asset: PublicAsset, canDownload: boolean): PublicAsset {
  const originalAvailableInApp = canDownload && asset.originalAvailableInApp
  return {
    ...asset,
    // A share grant authorizes viewing the shared media, not the owner's private
    // archive metadata. In particular, GPS/EXIF, logical paths and internal source
    // identifiers must not leak merely because the UI does not render them.
    sourceId: 'shared',
    importOrigin: 'shared',
    metadata: null,
    metadataSupported: false,
    logicalPath: '/',
    lastViewedAt: null,
    latitude: null,
    longitude: null,
    placeId: null,
    favorite: false,
    primaryCategory: null,
    aiCategory: null,
    categoryOverride: null,
    personCount: null,
    scene: null,
    tags: undefined,
    uploadSupported: false,
    downloadSupported: originalAvailableInApp,
    previewUrl: `/api/share/assets/${asset.id}/preview`,
    mediaUrl: originalAvailableInApp ? `/api/share/assets/${asset.id}/media` : null,
    originalAvailableInApp,
  }
}

async function publicSharedAsset(db: D1Database, row: AssetRow, principalId: string): Promise<PublicAsset> {
  const [tags, canDownload] = await Promise.all([
    getTagsForAsset(db, row.id),
    canPrincipalAccessAsset(db, principalId, row.id, 'download'),
  ])
  return sharedAsset(toPublicAsset(row, tags, { allowDownload: canDownload }), canDownload)
}

const MAX_SHARE_EXCHANGE_JSON_BYTES = 4 * 1024

shareRoutes.post('/exchange', async (context) => {
  let body: Record<string, unknown>
  try {
    body = await readBoundedJsonObject(context.req.raw, MAX_SHARE_EXCHANGE_JSON_BYTES)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'REQUEST_BODY_INVALID'
    return context.json({ error: code === 'REQUEST_BODY_TOO_LARGE' ? code : 'REQUEST_BODY_INVALID' }, code === 'REQUEST_BODY_TOO_LARGE' ? 413 : 400)
  }
  if (typeof body.token !== 'string' || body.token.length < 32 || body.token.length > 200) return context.json({ error: 'SHARE_TOKEN_INVALID' }, 400)
  const result = await exchangeShareToken(context.env.DB, body.token)
  if (!result) return context.json({ error: 'SHARE_TOKEN_INVALID_OR_EXPIRED' }, 401)
  context.header('Set-Cookie', shareSessionCookie(result.sessionToken, result.principal.expiresAt, secureCookie(context.req.url)))
  context.header('Cache-Control', 'no-store')
  return context.json({ principal: result.principal })
})

shareRoutes.get('/session', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  context.header('Cache-Control', 'no-store')
  return context.json({ principal })
})

shareRoutes.post('/logout', async (context) => {
  const token = readCookie(context.req.raw, SHARE_SESSION_COOKIE)
  if (token) await deleteShareSession(context.env.DB, token)
  context.header('Set-Cookie', clearShareSessionCookie(secureCookie(context.req.url)))
  context.header('Cache-Control', 'no-store')
  return context.json({ ok: true })
})

shareRoutes.get('/assets', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const result = await listAssets(context.env.DB, {
    limit: Number(context.req.query('limit') ?? 30),
    cursor: context.req.query('cursor'),
    mediaType: context.req.query('mediaType'),
    query: context.req.query('q'),
    albumId: context.req.query('albumId'),
    sourceId: context.req.query('sourceId'),
    principalId: principal.id,
  })
  const items = await Promise.all(result.rows.map((row) => publicSharedAsset(context.env.DB, row, principal.id)))
  context.header('Cache-Control', 'private, no-store')
  return context.json({ items, nextCursor: result.nextCursor })
})

shareRoutes.get('/assets/:id', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const id = context.req.param('id')
  if (!(await canPrincipalAccessAsset(context.env.DB, principal.id, id, 'read'))) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status === 'trashed') return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  return context.json({ asset: await publicSharedAsset(context.env.DB, asset, principal.id) })
})

function mockMedia(asset: AssetRow): Response {
  const title = asset.original_name.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').slice(0, 40)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 800"><rect width="1200" height="800" fill="#ded6c7"/><path d="M0 580L310 280l260 300 180-210 450 430H0Z" fill="#77796e"/><text x="60" y="720" font-family="system-ui" font-size="34" fill="#2f302d">${title}</text></svg>`
  return new Response(svg, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'private, no-store' } })
}

shareRoutes.get('/assets/:id/preview', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const id = context.req.param('id')
  if (!(await canPrincipalAccessAsset(context.env.DB, principal.id, id, 'read'))) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status === 'trashed') return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (isMockMode(context.env)) return mockMedia(asset)
  const canDownload = await canPrincipalAccessAsset(context.env.DB, principal.id, id, 'download')
  const fileId = asset.preview_file_id ?? (canDownload && asset.media_type === 'photo' && asset.size_bytes <= 20 * 1024 * 1024 && isSafeInlineMediaType(asset.mime_type) ? asset.storage_file_id : null)
  if (!fileId) return context.json({ error: 'PREVIEW_NOT_AVAILABLE' }, 404)
  const response = await (await storageFor(context.env, asset.source_id)).fetchFile(fileId)
  const headers = applySafeMediaHeaders(new Headers(response.headers), {
    fileName: `preview-${asset.original_name}`,
    mimeType: response.headers.get('Content-Type') ?? asset.mime_type,
  })
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(response.body, { status: response.status, headers })
})

async function originalResponse(context: Context<{ Bindings: Env }>, download: boolean): Promise<Response> {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const id = context.req.param('id') ?? ''
  if (!(await canPrincipalAccessAsset(context.env.DB, principal.id, id, 'download'))) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  const asset = await getAsset(context.env.DB, id)
  if (!asset || asset.status === 'trashed' || !asset.storage_file_id) return context.json({ error: 'MEDIA_NOT_AVAILABLE' }, 404)
  if (asset.size_bytes > 20 * 1024 * 1024) return context.json({ error: 'ORIGINAL_AVAILABLE_IN_TELEGRAM_ONLY' }, 409)
  if (isMockMode(context.env)) return mockMedia(asset)
  const range = context.req.header('Range')
  const response = await (await storageFor(context.env, asset.source_id)).fetchFile(asset.storage_file_id, range ? { headers: { Range: range } } : undefined)
  const headers = applySafeMediaHeaders(new Headers(response.headers), {
    fileName: asset.original_name,
    mimeType: response.headers.get('Content-Type') ?? asset.mime_type,
    download,
  })
  headers.set('Cache-Control', 'private, no-store')
  headers.set('X-Robots-Tag', 'noindex, nofollow')
  return new Response(response.body, { status: response.status, headers })
}

shareRoutes.get('/assets/:id/media', async (context) => originalResponse(context, false))
shareRoutes.get('/assets/:id/download', async (context) => originalResponse(context, true))

shareRoutes.get('/timeline/months', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const result = await context.env.DB.prepare(`SELECT substr(assets.taken_at, 1, 7) AS month, COUNT(*) AS asset_count
    FROM assets WHERE assets.workspace_id = ? AND assets.status != 'trashed' AND assets.archived = 0
      AND EXISTS (
        SELECT 1 FROM access_grants grants WHERE grants.workspace_id = assets.workspace_id AND grants.principal_id = ? AND grants.permission = 'read'
          AND (
            (grants.scope_type = 'source' AND grants.scope_id = assets.source_id)
            OR (grants.scope_type = 'asset' AND grants.scope_id = assets.id)
            OR (grants.scope_type = 'album' AND EXISTS (
              SELECT 1 FROM album_assets WHERE album_assets.album_id = grants.scope_id AND album_assets.asset_id = assets.id
            ))
          )
      )
    GROUP BY substr(assets.taken_at, 1, 7) ORDER BY month DESC LIMIT 240`)
    .bind(PERSONAL_WORKSPACE_ID, principal.id).all<{ month: string; asset_count: number }>()
  return context.json({ items: result.results })
})

shareRoutes.get('/albums', async (context) => {
  const principal = await principalFor(context)
  if (!principal) return context.json({ error: 'SHARE_SESSION_REQUIRED' }, 401)
  const albumIds = await listAccessibleAlbumIds(context.env.DB, principal.id)
  if (!albumIds.length) return context.json({ items: [] })
  const placeholders = albumIds.map(() => '?').join(', ')
  const rows = await context.env.DB.prepare(`SELECT albums.id, albums.name, albums.cover_asset_id, albums.created_at, albums.updated_at,
      COUNT(assets.id) AS asset_count, MIN(assets.taken_at) AS first_taken_at, MAX(assets.taken_at) AS latest_taken_at
    FROM albums
    LEFT JOIN album_assets ON album_assets.album_id = albums.id
    LEFT JOIN assets ON assets.id = album_assets.asset_id AND assets.status != 'trashed'
      AND EXISTS (
        SELECT 1 FROM access_grants grants WHERE grants.principal_id = ? AND grants.permission = 'read' AND (
          (grants.scope_type = 'album' AND grants.scope_id = albums.id)
          OR (grants.scope_type = 'asset' AND grants.scope_id = assets.id)
          OR (grants.scope_type = 'source' AND grants.scope_id = assets.source_id)
        )
      )
    WHERE albums.workspace_id = ? AND albums.id IN (${placeholders})
    GROUP BY albums.id ORDER BY albums.updated_at DESC`)
    .bind(principal.id, PERSONAL_WORKSPACE_ID, ...albumIds).all()
  return context.json({ items: rows.results })
})
