import { Hono } from 'hono'
import { PERSONAL_WORKSPACE_ID } from '../db/assets-repository'
import type { Env } from '../env'
import { requireOwner } from '../lib/security'

export const recoveryRoutes = new Hono<{ Bindings: Env }>()
recoveryRoutes.use('*', requireOwner)

recoveryRoutes.get('/integrity', async (context) => {
  const db = context.env.DB
  const [missingObjects, orphanObjects, missingSearch, duplicateMessages, manifests, totalObjects] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS count FROM assets
      LEFT JOIN storage_objects ON storage_objects.id = assets.storage_object_id
      WHERE assets.workspace_id = ?
        AND assets.status IN ('stored','queued','analyzing','ready','limited')
        AND (assets.storage_object_id IS NULL OR storage_objects.id IS NULL)`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM storage_objects
      WHERE workspace_id = ? AND delete_state != 'deleted'
        AND NOT EXISTS (SELECT 1 FROM assets WHERE assets.storage_object_id = storage_objects.id)`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM assets
      WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM asset_search WHERE asset_search.asset_id = assets.id)`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM (
      SELECT storage_chat_id, storage_message_id FROM storage_objects
      WHERE workspace_id = ? AND storage_message_id IS NOT NULL
      GROUP BY storage_chat_id, storage_message_id HAVING COUNT(*) > 1
    )`).bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM storage_objects WHERE workspace_id = ? AND manifest_version = 1`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM storage_objects WHERE workspace_id = ? AND delete_state != 'deleted'`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>(),
  ])

  return context.json({
    ok: true,
    checks: {
      missingStorageObjectLinks: Number(missingObjects?.count ?? 0),
      orphanStorageObjects: Number(orphanObjects?.count ?? 0),
      missingSearchRows: Number(missingSearch?.count ?? 0),
      duplicateStorageMessages: Number(duplicateMessages?.count ?? 0),
    },
    recovery: {
      manifestVersion: 1,
      manifestedObjects: Number(manifests?.count ?? 0),
      totalActiveObjects: Number(totalObjects?.count ?? 0),
      botHistoryEnumerationSupported: false,
      controlledIndexRebuildSupported: true,
      note: 'Telegram Bot API cannot enumerate arbitrary historical channel messages; future web uploads carry a compact PA1 manifest on the storage message.',
    },
  })
})

recoveryRoutes.post('/search-rebuild', async (context) => {
  const body = await context.req.json<{ dryRun?: unknown }>().catch(() => ({ dryRun: true }))
  const dryRun = body.dryRun !== false
  const before = await context.env.DB.prepare(`SELECT COUNT(*) AS count FROM assets
    WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM asset_search WHERE asset_search.asset_id = assets.id)`)
    .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>()
  if (dryRun) return context.json({ ok: true, dryRun: true, missingSearchRows: Number(before?.count ?? 0) })

  await context.env.DB.batch([
    context.env.DB.prepare(`DELETE FROM asset_search WHERE workspace_id = ?`).bind(PERSONAL_WORKSPACE_ID),
    context.env.DB.prepare(`INSERT INTO asset_search (asset_id, workspace_id, search_text)
      SELECT assets.id, assets.workspace_id,
        trim(
          assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
          COALESCE(assets.logical_path, '') || ' ' || COALESCE(assets.scene, '') || ' ' ||
          COALESCE(assets.category_override, assets.primary_category, '') || ' ' ||
          COALESCE((SELECT places.label || ' ' || COALESCE(places.city, '') FROM places WHERE places.id = assets.place_id), '') || ' ' ||
          COALESCE((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
          COALESCE((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
        )
      FROM assets WHERE assets.workspace_id = ?`).bind(PERSONAL_WORKSPACE_ID),
  ])
  const after = await context.env.DB.prepare(`SELECT COUNT(*) AS count FROM assets
    WHERE workspace_id = ? AND NOT EXISTS (SELECT 1 FROM asset_search WHERE asset_search.asset_id = assets.id)`)
    .bind(PERSONAL_WORKSPACE_ID).first<{ count: number }>()
  return context.json({ ok: true, dryRun: false, missingBefore: Number(before?.count ?? 0), missingAfter: Number(after?.count ?? 0) })
})
