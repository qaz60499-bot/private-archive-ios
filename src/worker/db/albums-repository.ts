import { PERSONAL_WORKSPACE_ID, refreshAssetSearchIndex } from './assets-repository'
import { appUserAssetPermissionPredicate } from './app-user-access-repository'

export interface AlbumRow {
  id: string
  name: string
  cover_asset_id: string | null
  created_at: string
  updated_at: string
  asset_count?: number
  first_taken_at?: string | null
  latest_taken_at?: string | null
}

function albumSelect(scoped: boolean): string {
  const cover = `COALESCE(MAX(CASE WHEN assets.id = albums.cover_asset_id THEN assets.id END), MIN(assets.id)) AS cover_asset_id`
  const access = scoped ? ` AND ${appUserAssetPermissionPredicate('assets')}` : ''
  return `SELECT albums.id, albums.name, ${cover}, albums.created_at, albums.updated_at,
    COUNT(assets.id) AS asset_count,
    MIN(assets.taken_at) AS first_taken_at,
    MAX(assets.taken_at) AS latest_taken_at
    FROM albums
    LEFT JOIN album_assets ON album_assets.album_id = albums.id
    LEFT JOIN assets ON assets.id = album_assets.asset_id AND assets.status NOT IN ('trashed', 'pending_upload', 'failed')${access}`
}

export async function listAlbums(db: D1Database, appUserId?: string): Promise<AlbumRow[]> {
  const values: unknown[] = []
  if (appUserId) values.push(appUserId, 'read')
  values.push(PERSONAL_WORKSPACE_ID)
  const result = await db.prepare(`${albumSelect(Boolean(appUserId))} WHERE albums.workspace_id = ? GROUP BY albums.id ORDER BY albums.updated_at DESC`)
    .bind(...values).all<AlbumRow>()
  return result.results
}

export async function getAlbum(db: D1Database, id: string, appUserId?: string): Promise<AlbumRow | null> {
  const values: unknown[] = []
  if (appUserId) values.push(appUserId, 'read')
  values.push(PERSONAL_WORKSPACE_ID, id)
  return db.prepare(`${albumSelect(Boolean(appUserId))} WHERE albums.workspace_id = ? AND albums.id = ? GROUP BY albums.id`)
    .bind(...values).first<AlbumRow>()
}

export async function listAlbumNamesForAssets(db: D1Database, assetIds: string[]): Promise<Map<string, string[]>> {
  const namesByAsset = new Map<string, string[]>()
  if (!assetIds.length) return namesByAsset
  const uniqueIds = [...new Set(assetIds)].slice(0, 100)
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const rows = await db.prepare(`SELECT album_assets.asset_id, albums.name
    FROM album_assets JOIN albums ON albums.id = album_assets.album_id
    WHERE albums.workspace_id = ? AND album_assets.asset_id IN (${placeholders})
    ORDER BY albums.name COLLATE NOCASE`)
    .bind(PERSONAL_WORKSPACE_ID, ...uniqueIds).all<{ asset_id: string; name: string }>()
  for (const row of rows.results) namesByAsset.set(row.asset_id, [...(namesByAsset.get(row.asset_id) ?? []), row.name])
  return namesByAsset
}

export async function createAlbum(db: D1Database, name: string): Promise<AlbumRow> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO albums (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, PERSONAL_WORKSPACE_ID, name, now, now).run()
  return { id, name, cover_asset_id: null, created_at: now, updated_at: now, asset_count: 0 }
}

export async function updateAlbum(db: D1Database, id: string, input: { name?: string; assetId?: string; coverAssetId?: string }): Promise<boolean> {
  const album = await db.prepare(`SELECT id FROM albums WHERE id = ? AND workspace_id = ?`).bind(id, PERSONAL_WORKSPACE_ID).first<{ id: string }>()
  if (!album) return false
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  if (input.name) statements.push(db.prepare(`UPDATE albums SET name = ?, updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(input.name, now, id, PERSONAL_WORKSPACE_ID))
  if (input.assetId) {
    statements.push(
      db.prepare(`INSERT INTO album_assets (album_id, asset_id, sort_order)
        SELECT ?, assets.id, COALESCE((SELECT MAX(sort_order) + 1 FROM album_assets WHERE album_id = ?), 0)
        FROM assets WHERE assets.id = ? AND assets.workspace_id = ? AND assets.status NOT IN ('trashed', 'pending_upload', 'failed')
        ON CONFLICT(album_id, asset_id) DO NOTHING`).bind(id, id, input.assetId, PERSONAL_WORKSPACE_ID),
      db.prepare(`UPDATE albums SET cover_asset_id = COALESCE(cover_asset_id, ?), updated_at = ?
        WHERE id = ? AND workspace_id = ? AND EXISTS (
          SELECT 1 FROM album_assets WHERE album_assets.album_id = albums.id AND album_assets.asset_id = ?
        )`).bind(input.assetId, now, id, PERSONAL_WORKSPACE_ID, input.assetId),
    )
  }
  if (input.coverAssetId) {
    statements.push(db.prepare(`UPDATE albums SET cover_asset_id = ?, updated_at = ? WHERE id = ? AND workspace_id = ?
      AND EXISTS (SELECT 1 FROM album_assets WHERE album_id = ? AND asset_id = ?)`)
      .bind(input.coverAssetId, now, id, PERSONAL_WORKSPACE_ID, id, input.coverAssetId))
  }
  if (!statements.length) return false
  const results = await db.batch(statements)
  const changed = results.some((result) => result.meta.changes > 0)
  if (changed) {
    if (input.assetId) await refreshAssetSearchIndex(db, input.assetId)
    if (input.name) {
      const assets = await db.prepare(`SELECT asset_id FROM album_assets WHERE album_id = ?`).bind(id).all<{ asset_id: string }>()
      await Promise.all(assets.results.map((row) => refreshAssetSearchIndex(db, row.asset_id)))
    }
  }
  return changed
}

export async function removeAssetFromAlbum(db: D1Database, id: string, assetId: string): Promise<boolean> {
  const existing = await db.prepare(`SELECT 1 AS found FROM album_assets
    JOIN albums ON albums.id = album_assets.album_id
    JOIN assets ON assets.id = album_assets.asset_id
    WHERE album_assets.album_id = ? AND album_assets.asset_id = ? AND albums.workspace_id = ? AND assets.workspace_id = ?`)
    .bind(id, assetId, PERSONAL_WORKSPACE_ID, PERSONAL_WORKSPACE_ID).first<{ found: number }>()
  if (!existing) return false
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?`).bind(id, assetId),
    db.prepare(`UPDATE albums SET cover_asset_id = CASE WHEN cover_asset_id = ? THEN
      (SELECT asset_id FROM album_assets WHERE album_id = ? ORDER BY sort_order, asset_id LIMIT 1)
      ELSE cover_asset_id END, updated_at = ? WHERE id = ? AND workspace_id = ?`).bind(assetId, id, now, id, PERSONAL_WORKSPACE_ID),
  ])
  await refreshAssetSearchIndex(db, assetId)
  return true
}

export async function deleteAlbum(db: D1Database, id: string): Promise<boolean> {
  const existing = await db.prepare(`SELECT id FROM albums WHERE id = ? AND workspace_id = ?`).bind(id, PERSONAL_WORKSPACE_ID).first<{ id: string }>()
  if (!existing) return false
  const assets = await db.prepare(`SELECT asset_id FROM album_assets WHERE album_id = ?`).bind(id).all<{ asset_id: string }>()
  await db.batch([
    db.prepare(`DELETE FROM album_assets WHERE album_id = ?`).bind(id),
    db.prepare(`DELETE FROM albums WHERE id = ? AND workspace_id = ?`).bind(id, PERSONAL_WORKSPACE_ID),
  ])
  await Promise.all(assets.results.map((row) => refreshAssetSearchIndex(db, row.asset_id)))
  return true
}

