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

const ALBUM_SELECT = `SELECT albums.id, albums.name, albums.cover_asset_id, albums.created_at, albums.updated_at,
  COUNT(assets.id) AS asset_count,
  MIN(assets.taken_at) AS first_taken_at,
  MAX(assets.taken_at) AS latest_taken_at
  FROM albums
  LEFT JOIN album_assets ON album_assets.album_id = albums.id
  LEFT JOIN assets ON assets.id = album_assets.asset_id AND assets.status != 'trashed'`

export async function listAlbums(db: D1Database): Promise<AlbumRow[]> {
  const result = await db.prepare(`${ALBUM_SELECT} GROUP BY albums.id ORDER BY albums.updated_at DESC`).all<AlbumRow>()
  return result.results
}

export async function getAlbum(db: D1Database, id: string): Promise<AlbumRow | null> {
  return db.prepare(`${ALBUM_SELECT} WHERE albums.id = ? GROUP BY albums.id`).bind(id).first<AlbumRow>()
}

export async function createAlbum(db: D1Database, name: string): Promise<AlbumRow> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO albums (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).bind(id, name, now, now).run()
  return { id, name, cover_asset_id: null, created_at: now, updated_at: now, asset_count: 0 }
}

export async function updateAlbum(db: D1Database, id: string, input: { name?: string; assetId?: string; coverAssetId?: string }): Promise<boolean> {
  const now = new Date().toISOString()
  const statements: D1PreparedStatement[] = []
  if (input.name) statements.push(db.prepare(`UPDATE albums SET name = ?, updated_at = ? WHERE id = ?`).bind(input.name, now, id))
  if (input.assetId) {
    statements.push(
      db.prepare(`INSERT INTO album_assets (album_id, asset_id, sort_order) VALUES (?, ?,
        COALESCE((SELECT MAX(sort_order) + 1 FROM album_assets WHERE album_id = ?), 0))
        ON CONFLICT(album_id, asset_id) DO NOTHING`).bind(id, input.assetId, id),
      db.prepare(`UPDATE albums SET cover_asset_id = COALESCE(cover_asset_id, ?), updated_at = ? WHERE id = ?`).bind(input.assetId, now, id),
    )
  }
  if (input.coverAssetId) {
    statements.push(db.prepare(`UPDATE albums SET cover_asset_id = ?, updated_at = ? WHERE id = ?
      AND EXISTS (SELECT 1 FROM album_assets WHERE album_id = ? AND asset_id = ?)`)
      .bind(input.coverAssetId, now, id, id, input.coverAssetId))
  }
  if (!statements.length) return false
  const results = await db.batch(statements)
  return results.some((result) => result.meta.changes > 0)
}

export async function removeAssetFromAlbum(db: D1Database, id: string, assetId: string): Promise<boolean> {
  const existing = await db.prepare(`SELECT 1 AS found FROM album_assets WHERE album_id = ? AND asset_id = ?`).bind(id, assetId).first<{ found: number }>()
  if (!existing) return false
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`DELETE FROM album_assets WHERE album_id = ? AND asset_id = ?`).bind(id, assetId),
    db.prepare(`UPDATE albums SET cover_asset_id = CASE WHEN cover_asset_id = ? THEN
      (SELECT asset_id FROM album_assets WHERE album_id = ? ORDER BY sort_order, asset_id LIMIT 1)
      ELSE cover_asset_id END, updated_at = ? WHERE id = ?`).bind(assetId, id, now, id),
  ])
  return true
}

export async function deleteAlbum(db: D1Database, id: string): Promise<boolean> {
  const existing = await db.prepare(`SELECT id FROM albums WHERE id = ?`).bind(id).first<{ id: string }>()
  if (!existing) return false
  await db.batch([
    db.prepare(`DELETE FROM album_assets WHERE album_id = ?`).bind(id),
    db.prepare(`DELETE FROM albums WHERE id = ?`).bind(id),
  ])
  return true
}

