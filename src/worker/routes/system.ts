import { Hono } from 'hono'
import { saveAnalysis } from '../db/analysis-repository'
import { PERSONAL_WORKSPACE_ID, createTelegramAsset, getAsset, getTrashRetentionDays, listAssets, listRecentAssets, listUploadJobs } from '../db/assets-repository'
import { listActivity } from '../db/activity-repository'
import { getUsageSnapshot } from '../db/usage-repository'
import { getDefaultStorageBackend, getTelegramUserGroupRuntime, setDefaultStorageBackend } from '../db/user-group-storage-repository'
import { getTelegramRuntimeConfig } from '../db/settings-repository'
import { toPublicAsset } from '../domain/types'
import type { Env } from '../env'
import { requireAccount, requireOwner, resolveRequestAppUser } from '../lib/security'
import { appUserAssetPermissionPredicate, canAppUserAccessAsset, listAccessibleAlbumIdsForAppUser } from '../db/app-user-access-repository'
import { retryFailedAnalysis } from '../services/analysis/retry'

export const systemRoutes = new Hono<{ Bindings: Env }>()
systemRoutes.use('*', requireAccount)

async function requestUser(context: Parameters<typeof resolveRequestAppUser>[0]) {
  return resolveRequestAppUser(context)
}

systemRoutes.get('/tags', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  if (user.role === 'OWNER') {
    const result = await context.env.DB.prepare(`SELECT tags.id, tags.slug, tags.name, tags.kind,
      COUNT(CASE WHEN assets.workspace_id = ? AND assets.status != 'trashed' THEN asset_tags.asset_id END) AS asset_count
      FROM tags LEFT JOIN asset_tags ON asset_tags.tag_id = tags.id LEFT JOIN assets ON assets.id = asset_tags.asset_id
      GROUP BY tags.id ORDER BY asset_count DESC, tags.name`).bind(PERSONAL_WORKSPACE_ID).all()
    return context.json({ items: result.results })
  }
  const result = await context.env.DB.prepare(`SELECT tags.id, tags.slug, tags.name, tags.kind, COUNT(*) AS asset_count
    FROM tags JOIN asset_tags ON asset_tags.tag_id = tags.id JOIN assets ON assets.id = asset_tags.asset_id
    WHERE assets.workspace_id = ? AND assets.status != 'trashed' AND ${appUserAssetPermissionPredicate('assets')}
    GROUP BY tags.id ORDER BY asset_count DESC, tags.name`)
    .bind(PERSONAL_WORKSPACE_ID, user.id, 'read').all()
  return context.json({ items: result.results })
})

systemRoutes.get('/places', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  if (user.role === 'OWNER') {
    const result = await context.env.DB.prepare(`SELECT places.*,
      COUNT(CASE WHEN assets.workspace_id = ? AND assets.status != 'trashed' THEN assets.id END) AS asset_count,
      MAX(CASE WHEN assets.workspace_id = ? AND assets.status != 'trashed' THEN assets.taken_at END) AS latest_taken_at
      FROM places LEFT JOIN assets ON assets.place_id = places.id GROUP BY places.id ORDER BY latest_taken_at DESC`)
      .bind(PERSONAL_WORKSPACE_ID, PERSONAL_WORKSPACE_ID).all()
    return context.json({ items: result.results })
  }
  const result = await context.env.DB.prepare(`SELECT places.*, COUNT(*) AS asset_count, MAX(assets.taken_at) AS latest_taken_at
    FROM places JOIN assets ON assets.place_id = places.id
    WHERE assets.workspace_id = ? AND assets.status != 'trashed' AND ${appUserAssetPermissionPredicate('assets')}
    GROUP BY places.id ORDER BY latest_taken_at DESC`)
    .bind(PERSONAL_WORKSPACE_ID, user.id, 'read').all()
  return context.json({ items: result.results })
})

systemRoutes.get('/timeline/months', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const accessFilter = user.role === 'MEMBER' ? `AND ${appUserAssetPermissionPredicate('assets')}` : ''
  const values: unknown[] = [PERSONAL_WORKSPACE_ID]
  if (user.role === 'MEMBER') values.push(user.id, 'read')
  const result = await context.env.DB.prepare(`SELECT substr(taken_at, 1, 7) AS month, COUNT(*) AS asset_count
    FROM assets WHERE workspace_id = ? AND status != 'trashed' ${accessFilter} GROUP BY substr(taken_at, 1, 7) ORDER BY month DESC LIMIT 240`)
    .bind(...values).all<{ month: string; asset_count: number }>()
  context.header('Cache-Control', 'private, max-age=300')
  return context.json({ items: result.results })
})

systemRoutes.get('/upload-jobs', requireOwner, async (context) => context.json({ items: await listUploadJobs(context.env.DB) }))

systemRoutes.get('/recent', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const kind = context.req.query('kind') === 'viewed' ? 'viewed' : 'added'
  const rows = await listRecentAssets(context.env.DB, kind, Number(context.req.query('limit') ?? 30), user.role === 'MEMBER' ? user.id : undefined)
  const items = await Promise.all(rows.map(async (row) => toPublicAsset(row, undefined, {
    allowDownload: user.role === 'OWNER' || await canAppUserAccessAsset(context.env.DB, user, row.id, 'download'),
  })))
  return context.json({ kind, items })
})

systemRoutes.get('/activity', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const rows = await listActivity(context.env.DB, Number(context.req.query('limit') ?? 50), user.role === 'MEMBER' ? user.id : undefined)
  return context.json({ items: rows.map((row) => ({
    id: row.id,
    action: row.action,
    assetId: row.asset_id,
    albumId: row.album_id,
    detail: row.detail_json ? (() => { try { return JSON.parse(row.detail_json) } catch { return null } })() : null,
    assetName: row.asset_name,
    assetSource: row.asset_source,
    createdAt: row.created_at,
  })) })
})

systemRoutes.get('/usage', requireOwner, async (context) => context.json({ usage: await getUsageSnapshot(context.env.DB) }))

systemRoutes.get('/archive-summary', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const accessFilter = user.role === 'MEMBER' ? `AND ${appUserAssetPermissionPredicate('assets')}` : ''
  const values: unknown[] = [PERSONAL_WORKSPACE_ID]
  if (user.role === 'MEMBER') values.push(user.id, 'read')
  const [assetSummary, accessibleAlbumIds] = await Promise.all([
    context.env.DB.prepare(`SELECT
      COUNT(*) AS asset_count,
      SUM(CASE WHEN media_type = 'photo' THEN 1 ELSE 0 END) AS photo_count,
      MAX(uploaded_at) AS last_update
      FROM assets WHERE workspace_id = ? AND status != 'trashed' ${accessFilter}`)
      .bind(...values)
      .first<{ asset_count: number; photo_count: number | null; last_update: string | null }>(),
    listAccessibleAlbumIdsForAppUser(context.env.DB, user),
  ])
  const albumCount = accessibleAlbumIds === null
    ? Number((await context.env.DB.prepare(`SELECT COUNT(*) AS album_count FROM albums WHERE workspace_id = ?`).bind(PERSONAL_WORKSPACE_ID).first<{ album_count: number }>())?.album_count ?? 0)
    : accessibleAlbumIds.length
  context.header('Cache-Control', 'private, max-age=30')
  return context.json({
    assetCount: Number(assetSummary?.asset_count ?? 0),
    photoCount: Number(assetSummary?.photo_count ?? 0),
    albumCount,
    lastUpdate: assetSummary?.last_update ?? null,
  })
})

systemRoutes.get('/trash-policy', async (context) => context.json({ retentionDays: await getTrashRetentionDays(context.env.DB) }))

systemRoutes.put('/trash-policy', requireOwner, async (context) => {
  const body = await context.req.json<{ retentionDays?: unknown }>()
  const value = body.retentionDays === 'never' || body.retentionDays === null ? 'never' : String(body.retentionDays)
  if (!['7', '30', '90', 'never'].includes(value)) return context.json({ error: 'INVALID_TRASH_RETENTION' }, 400)
  const now = new Date().toISOString()
  await context.env.DB.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('trash_retention_days', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`).bind(value, now).run()
  if (value === 'never') {
    await context.env.DB.prepare(`UPDATE assets SET purge_at = NULL, updated_at = ? WHERE workspace_id = ? AND status = 'trashed'`)
      .bind(now, PERSONAL_WORKSPACE_ID).run()
  } else {
    await context.env.DB.prepare(`UPDATE assets SET purge_at = strftime('%Y-%m-%dT%H:%M:%fZ', COALESCE(deleted_at, updated_at), '+' || ? || ' days'), updated_at = ?
      WHERE workspace_id = ? AND status = 'trashed'`).bind(value, now, PERSONAL_WORKSPACE_ID).run()
  }
  return context.json({ ok: true, retentionDays: value === 'never' ? null : Number(value) })
})

systemRoutes.post('/analysis/retry-failed', requireOwner, async (context) => context.json({ ok: true, queued: await retryFailedAnalysis(context.env) }))

systemRoutes.get('/search', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const result = await listAssets(context.env.DB, {
    limit: Number(context.req.query('limit') ?? 30),
    query: context.req.query('q'),
    appUserId: user.role === 'MEMBER' ? user.id : undefined,
  })
  const items = await Promise.all(result.rows.map(async (row) => toPublicAsset(row, undefined, {
    allowDownload: user.role === 'OWNER' || await canAppUserAccessAsset(context.env.DB, user, row.id, 'download'),
  })))
  return context.json({ items, nextCursor: result.nextCursor })
})

systemRoutes.get('/storage-preference', async (context) => {
  return context.json({ defaultStorageBackend: await getDefaultStorageBackend(context.env.DB) })
})

systemRoutes.put('/storage-preference', requireOwner, async (context) => {
  const body = await context.req.json<{ defaultStorageBackend?: unknown }>()
  if (!['telegram_user_group', 'telegram_bot'].includes(String(body.defaultStorageBackend))) {
    return context.json({ error: 'INVALID_STORAGE_BACKEND' }, 400)
  }
  const backend = body.defaultStorageBackend as 'telegram_user_group' | 'telegram_bot'
  await setDefaultStorageBackend(context.env.DB, backend)
  return context.json({ ok: true, defaultStorageBackend: backend })
})

systemRoutes.get('/settings/status', async (context) => {
  const user = await requestUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const mockMode = context.env.MOCK_TELEGRAM === 'true'
  const [telegramConfig, usage, trashRetentionDays, defaultStorageBackend, userGroupRuntime] = await Promise.all([
    getTelegramRuntimeConfig(context.env.DB, context.env),
    user.role === 'OWNER' ? getUsageSnapshot(context.env.DB) : Promise.resolve(undefined),
    getTrashRetentionDays(context.env.DB),
    getDefaultStorageBackend(context.env.DB),
    getTelegramUserGroupRuntime(context.env.DB),
  ])
  const visibleUserGroupRuntime = user.role === 'OWNER' ? userGroupRuntime : {
    ...userGroupRuntime,
    storageChatId: null,
    lastError: null,
    lastAckMessageId: null,
  }
  return context.json({
    mockMode,
    telegram: {
      tokenConfigured: Boolean(context.env.TELEGRAM_BOT_TOKEN),
      ownerConfigured: Boolean(telegramConfig.ownerUserId),
      storageChatConfigured: Boolean(telegramConfig.storageChatId),
      webhookSecretConfigured: Boolean(context.env.TELEGRAM_WEBHOOK_SECRET),
    },
    d1: { configured: Boolean(context.env.DB) },
    queue: { configured: Boolean(context.env.ANALYSIS_QUEUE) },
    ai: { configured: Boolean(context.env.AI) },
    access: {
      configured: Boolean(context.env.OWNER_EMAIL && context.env.POLICY_AUD && context.env.TEAM_DOMAIN),
      ownerEmailConfigured: Boolean(context.env.OWNER_EMAIL),
      audienceConfigured: Boolean(context.env.POLICY_AUD),
      teamDomainConfigured: Boolean(context.env.TEAM_DOMAIN),
    },
    workspace: { id: PERSONAL_WORKSPACE_ID, kind: 'personal' },
    storage: { defaultStorageBackend, userGroup: visibleUserGroupRuntime },
    usage,
    trash: { retentionDays: trashRetentionDays },
    limits: { inAppOriginalBytes: 20 * 1024 * 1024, maxUploadBytes: 20 * 1024 * 1024, userGroupAccountLimitApplies: true },
    privacy: { cloudflareAccessExpected: !mockMode, tokenStoredInD1: false, endToEndEncrypted: false },
  })
})

const seeds = [
  ['morning-garden.jpg', 'nature', ['nature', 'outdoor', 'landscape'], 1600, 1067],
  ['friends-at-dusk.jpg', 'people', ['people', 'group', 'outdoor'], 1200, 1500],
  ['quiet-city-night.jpg', 'city', ['city', 'street', 'night'], 1600, 1000],
  ['coastline-notes.jpg', 'travel', ['travel', 'nature', 'landscape'], 1500, 1000],
  ['sunday-coffee.jpg', 'food', ['food', 'indoor'], 1200, 1500],
  ['museum-corridor.jpg', 'architecture', ['architecture', 'indoor', 'art'], 1600, 1067],
  ['train-window.mp4', 'travel', ['travel', 'vehicle', 'outdoor'], 1600, 900],
  ['archive-scan.pdf', 'document', ['document'], 1000, 1300],
] as const

systemRoutes.post('/dev/seed', async (context) => {
  if (context.env.MOCK_TELEGRAM !== 'true') return context.json({ error: 'NOT_AVAILABLE' }, 404)
  const baseTime = Date.now()
  let created = 0
  for (const [index, seed] of seeds.entries()) {
    const [name, category, tags, width, height] = seed
    const tagList: readonly string[] = tags
    const id = `seed-${index + 1}`
    const result = await createTelegramAsset(context.env.DB, {
      id,
      source: 'mock',
      mediaType: name.endsWith('.mp4') ? 'video' : name.endsWith('.pdf') ? 'file' : 'photo',
      mimeType: name.endsWith('.mp4') ? 'video/mp4' : name.endsWith('.pdf') ? 'application/pdf' : 'image/jpeg',
      originalName: name,
      sizeBytes: name.endsWith('.mp4') ? 24 * 1024 * 1024 : name.endsWith('.pdf') ? 760_000 : 2_400_000,
      width,
      height,
      durationMs: name.endsWith('.mp4') ? 18_000 : undefined,
      takenAt: new Date(baseTime - index * 6 * 60 * 60 * 1000).toISOString(),
      chatId: '-1000000000000',
      messageId: 1000 + index,
      fileId: `seed-file-${index}`,
      fileUniqueId: `seed-unique-${index}`,
      previewFileId: `seed-preview-${index}`,
      status: 'ready',
      telegramUrl: `https://t.me/c/0000000000/${1000 + index}`,
    })
    const takenAt = new Date(baseTime - index * 6 * 60 * 60 * 1000).toISOString()
    await context.env.DB.prepare(`UPDATE assets SET status = 'ready', taken_at = ?, updated_at = ?, analysis_status = 'pending' WHERE id = ?`)
      .bind(takenAt, new Date().toISOString(), id).run()
    if (result.created) {
      const asset = await getAsset(context.env.DB, id)
      if (asset) await saveAnalysis(context.env.DB, asset, {
        primaryCategory: category,
        tags: [...tagList],
        personCount: tagList.includes('group') ? 3 : tagList.includes('people') ? 1 : 0,
        scene: tagList.includes('indoor') ? 'indoor' : 'outdoor',
        confidence: 0.9,
      })
      created += 1
    }
  }
  return context.json({ ok: true, created })
})
