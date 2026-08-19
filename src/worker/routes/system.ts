import { Hono } from 'hono'
import { saveAnalysis } from '../db/analysis-repository'
import { createTelegramAsset, getAsset, listAssets, listUploadJobs } from '../db/assets-repository'
import { getTelegramRuntimeConfig } from '../db/settings-repository'
import { toPublicAsset } from '../domain/types'
import type { Env } from '../env'
import { requireOwner } from '../lib/security'
import { retryFailedAnalysis } from '../services/analysis/retry'

export const systemRoutes = new Hono<{ Bindings: Env }>()
systemRoutes.use('*', requireOwner)

systemRoutes.get('/tags', async (context) => {
  const result = await context.env.DB.prepare(`SELECT tags.id, tags.slug, tags.name, tags.kind, COUNT(asset_tags.asset_id) AS asset_count
    FROM tags LEFT JOIN asset_tags ON asset_tags.tag_id = tags.id GROUP BY tags.id ORDER BY asset_count DESC, tags.name`).all()
  return context.json({ items: result.results })
})

systemRoutes.get('/places', async (context) => {
  const result = await context.env.DB.prepare(`SELECT places.*, COUNT(assets.id) AS asset_count, MAX(assets.taken_at) AS latest_taken_at
    FROM places LEFT JOIN assets ON assets.place_id = places.id GROUP BY places.id ORDER BY latest_taken_at DESC`).all()
  return context.json({ items: result.results })
})

systemRoutes.get('/timeline/months', async (context) => {
  const result = await context.env.DB.prepare(`SELECT substr(taken_at, 1, 7) AS month, COUNT(*) AS asset_count
    FROM assets WHERE status != 'trashed' GROUP BY substr(taken_at, 1, 7) ORDER BY month DESC LIMIT 240`).all<{ month: string; asset_count: number }>()
  context.header('Cache-Control', 'private, max-age=300')
  return context.json({ items: result.results })
})

systemRoutes.get('/upload-jobs', async (context) => context.json({ items: await listUploadJobs(context.env.DB) }))

systemRoutes.post('/analysis/retry-failed', async (context) => context.json({ ok: true, queued: await retryFailedAnalysis(context.env) }))

systemRoutes.get('/search', async (context) => {
  const result = await listAssets(context.env.DB, { limit: Number(context.req.query('limit') ?? 30), query: context.req.query('q') })
  return context.json({ items: result.rows.map((row) => toPublicAsset(row)), nextCursor: result.nextCursor })
})

systemRoutes.get('/settings/status', async (context) => {
  const mockMode = context.env.MOCK_TELEGRAM === 'true'
  const telegramConfig = await getTelegramRuntimeConfig(context.env.DB, context.env)
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
    limits: { inAppOriginalBytes: 20 * 1024 * 1024, maxUploadBytes: 48 * 1024 * 1024 },
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
