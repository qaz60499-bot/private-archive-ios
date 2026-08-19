import type { AssetRow, AssetTag, ReserveAssetInput, StoredFile } from '../domain/types'
import { hashToken } from '../lib/crypto'

const ASSET_COLUMNS = `
  id, storage_provider, storage_chat_id, storage_message_id, storage_file_id, storage_file_unique_id,
  preview_message_id, preview_file_id, source, media_type, mime_type, original_name, size_bytes, content_hash,
  width, height, duration_ms, taken_at, uploaded_at, latitude, longitude, place_id, primary_category,
  category_override, category_override_at, person_count, scene, favorite, status, analysis_status, telegram_url, created_at, updated_at
`

export interface CreatePendingAssetParams {
  id: string
  jobId: string
  token: string
  tokenExpiresAt: string
  input: ReserveAssetInput
  takenAt: string
  uploadedAt: string
}

export async function createPendingAsset(db: D1Database, params: CreatePendingAssetParams): Promise<void> {
  const now = params.uploadedAt
  const tokenHash = await hashToken(params.token)
  await db.batch([
    db.prepare(`INSERT INTO assets (
      id, source, media_type, mime_type, original_name, size_bytes, content_hash, width, height, duration_ms,
      taken_at, uploaded_at, latitude, longitude, status, analysis_status, created_at, updated_at
    ) VALUES (?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_upload', 'pending', ?, ?)`)
      .bind(
        params.id, params.input.mediaType, params.input.mimeType, params.input.originalName, params.input.sizeBytes,
        params.input.contentHash ?? null, params.input.width ?? null, params.input.height ?? null, params.input.durationMs ?? null,
        params.takenAt, params.uploadedAt, params.input.latitude ?? null, params.input.longitude ?? null, now, now,
      ),
    db.prepare(`INSERT INTO upload_jobs (
      id, asset_id, upload_token_hash, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'waiting', ?, ?, ?)`)
      .bind(params.jobId, params.id, tokenHash, params.tokenExpiresAt, now, now),
  ])
}

export async function verifyUploadToken(db: D1Database, assetId: string, token: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT upload_token_hash, expires_at FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(assetId).first<{ upload_token_hash: string; expires_at: string }>()
  if (!row || Date.parse(row.expires_at) <= Date.now()) return false
  return row.upload_token_hash === await hashToken(token)
}

export async function getActiveAssetByContentHash(db: D1Database, contentHash: string): Promise<AssetRow | null> {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE content_hash = ? AND status != 'trashed' ORDER BY created_at DESC LIMIT 1`)
    .bind(contentHash).first<AssetRow>()
}

export async function getLatestUploadJobState(db: D1Database, assetId: string): Promise<{ status: string; expires_at: string } | null> {
  return db.prepare(`SELECT status, expires_at FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(assetId).first<{ status: string; expires_at: string }>()
}

export async function createUploadJobForAsset(db: D1Database, params: { assetId: string; jobId: string; token: string; tokenExpiresAt: string }): Promise<void> {
  const now = new Date().toISOString()
  const tokenHash = await hashToken(params.token)
  await db.batch([
    db.prepare(`UPDATE assets SET status = CASE WHEN storage_file_id IS NULL THEN 'pending_upload' ELSE status END, updated_at = ? WHERE id = ?`)
      .bind(now, params.assetId),
    db.prepare(`INSERT INTO upload_jobs (id, asset_id, upload_token_hash, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'waiting', ?, ?, ?)`)
      .bind(params.jobId, params.assetId, tokenHash, params.tokenExpiresAt, now, now),
  ])
}

export async function claimUploadStarted(db: D1Database, assetId: string, token: string): Promise<boolean> {
  const now = new Date().toISOString()
  const tokenHash = await hashToken(token)
  const result = await db.prepare(`UPDATE upload_jobs
    SET status = 'uploading', attempts = attempts + 1, updated_at = ?
    WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)
      AND upload_token_hash = ? AND expires_at > ? AND status IN ('waiting', 'failed')`)
    .bind(now, assetId, tokenHash, now).run()
  return result.meta.changes > 0
}

export async function markStored(db: D1Database, assetId: string, stored: StoredFile): Promise<void> {
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`UPDATE assets SET storage_chat_id = ?, storage_message_id = ?, storage_file_id = ?,
      storage_file_unique_id = ?, telegram_url = ?, status = 'stored', updated_at = ? WHERE id = ?`)
      .bind(stored.chatId, stored.messageId, stored.fileId, stored.fileUniqueId, stored.telegramUrl, now, assetId),
    db.prepare(`UPDATE upload_jobs SET status = 'done', updated_at = ? WHERE asset_id = ?`).bind(now, assetId),
  ])
}

export async function markUploadFailed(db: D1Database, assetId: string, error: string): Promise<void> {
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`UPDATE assets SET status = 'failed', updated_at = ? WHERE id = ?`).bind(now, assetId),
    db.prepare(`UPDATE upload_jobs SET status = 'failed', last_error = ?, updated_at = ? WHERE asset_id = ?`)
      .bind(error.slice(0, 320), now, assetId),
  ])
}

export async function markPreviewStored(db: D1Database, assetId: string, stored: StoredFile): Promise<void> {
  await db.prepare(`UPDATE assets SET preview_message_id = ?, preview_file_id = ?, updated_at = ? WHERE id = ?`)
    .bind(stored.messageId, stored.fileId, new Date().toISOString(), assetId).run()
}

export async function markQueued(db: D1Database, assetId: string): Promise<void> {
  await db.prepare(`UPDATE assets SET status = 'queued', analysis_status = 'queued', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), assetId).run()
}

export async function markReadyWithoutAnalysis(db: D1Database, assetId: string): Promise<void> {
  await db.prepare(`UPDATE assets SET status = 'ready', analysis_status = 'skipped', updated_at = ? WHERE id = ?`)
    .bind(new Date().toISOString(), assetId).run()
}

export async function getAsset(db: D1Database, id: string): Promise<AssetRow | null> {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE id = ?`).bind(id).first<AssetRow>()
}

export async function getTagsForAsset(db: D1Database, id: string): Promise<AssetTag[]> {
  const result = await db.prepare(`SELECT tags.slug, tags.name, asset_tags.confidence, asset_tags.source
    FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = ? ORDER BY tags.name`)
    .bind(id).all<AssetTag>()
  return result.results
}

export interface AssetListFilters {
  limit: number
  cursor?: string
  mediaType?: string
  favorite?: boolean
  category?: string
  query?: string
  status?: string
  albumId?: string
  takenAfter?: string
  takenBefore?: string
}

export function encodeAssetCursor(row: Pick<AssetRow, 'taken_at' | 'id'>): string {
  return `${row.taken_at}|${row.id}`
}

export function decodeAssetCursor(cursor: string): { takenAt: string; id: string } | null {
  const separator = cursor.indexOf('|')
  if (separator <= 0 || separator === cursor.length - 1) return null
  const takenAt = cursor.slice(0, separator)
  const id = cursor.slice(separator + 1)
  return Number.isNaN(Date.parse(takenAt)) ? null : { takenAt, id }
}

export async function listAssets(db: D1Database, filters: AssetListFilters): Promise<{ rows: AssetRow[]; nextCursor: string | null }> {
  const conditions = [`status != 'trashed'`]
  const values: unknown[] = []
  if (filters.cursor) {
    const cursor = decodeAssetCursor(filters.cursor)
    if (cursor) {
      conditions.push('(taken_at < ? OR (taken_at = ? AND id < ?))')
      values.push(cursor.takenAt, cursor.takenAt, cursor.id)
    } else {
      conditions.push('taken_at < ?')
      values.push(filters.cursor)
    }
  }
  if (filters.mediaType) {
    conditions.push('media_type = ?')
    values.push(filters.mediaType)
  }
  if (filters.favorite !== undefined) {
    conditions.push('favorite = ?')
    values.push(filters.favorite ? 1 : 0)
  }
  if (filters.category) {
    conditions.push("COALESCE(category_override, primary_category, 'other') = ?")
    values.push(filters.category)
  }
  if (filters.status) {
    conditions.push('status = ?')
    values.push(filters.status)
  }
  if (filters.albumId) {
    conditions.push('EXISTS (SELECT 1 FROM album_assets WHERE album_assets.album_id = ? AND album_assets.asset_id = assets.id)')
    values.push(filters.albumId)
  }
  if (filters.takenAfter) {
    conditions.push('taken_at >= ?')
    values.push(filters.takenAfter)
  }
  if (filters.takenBefore) {
    conditions.push('taken_at < ?')
    values.push(filters.takenBefore)
  }
  if (filters.query) {
    const tokens = filters.query.toLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0, 6)
    for (const token of tokens) {
      conditions.push(`(LOWER(original_name) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(category_override, primary_category, 'other')) LIKE ? ESCAPE '\\'
        OR LOWER(COALESCE(scene, '')) LIKE ? ESCAPE '\\'
        OR EXISTS (
          SELECT 1 FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id
          WHERE asset_tags.asset_id = assets.id AND LOWER(tags.name) LIKE ? ESCAPE '\\'
        )
        OR EXISTS (
          SELECT 1 FROM places WHERE places.id = assets.place_id
          AND (LOWER(places.label) LIKE ? ESCAPE '\\' OR LOWER(COALESCE(places.city, '')) LIKE ? ESCAPE '\\')
        ))`)
      const like = `%${token.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
      values.push(like, like, like, like, like, like)
    }
  }
  const limit = Math.min(Math.max(filters.limit, 1), 60)
  values.push(limit + 1)
  const result = await db.prepare(`SELECT ${ASSET_COLUMNS} FROM assets WHERE ${conditions.join(' AND ')}
    ORDER BY taken_at DESC, id DESC LIMIT ?`).bind(...values).all<AssetRow>()
  const rows = result.results.slice(0, limit)
  const last = rows.at(-1)
  return { rows, nextCursor: result.results.length > limit && last ? encodeAssetCursor(last) : null }
}

export async function patchAsset(db: D1Database, id: string, patch: { favorite?: boolean; status?: string; categoryOverride?: string | null }): Promise<boolean> {
  const assignments: string[] = []
  const values: unknown[] = []
  if (patch.favorite !== undefined) {
    assignments.push('favorite = ?')
    values.push(patch.favorite ? 1 : 0)
  }
  if (patch.status) {
    assignments.push('status = ?')
    values.push(patch.status)
  }
  if (patch.categoryOverride !== undefined) {
    assignments.push('category_override = ?', 'category_override_at = ?')
    values.push(patch.categoryOverride, patch.categoryOverride ? new Date().toISOString() : null)
  }
  if (!assignments.length) return false
  assignments.push('updated_at = ?')
  values.push(new Date().toISOString(), id)
  const result = await db.prepare(`UPDATE assets SET ${assignments.join(', ')} WHERE id = ?`).bind(...values).run()
  return result.meta.changes > 0
}

export async function softDeleteAsset(db: D1Database, id: string): Promise<boolean> {
  return patchAsset(db, id, { status: 'trashed' })
}

export async function bulkSoftDeleteAssets(db: D1Database, ids: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)].slice(0, 100)
  if (!uniqueIds.length) return 0
  const now = new Date().toISOString()
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const result = await db.prepare(`UPDATE assets SET status = 'trashed', updated_at = ?
    WHERE id IN (${placeholders}) AND status != 'trashed'`).bind(now, ...uniqueIds).run()
  return result.meta.changes
}

export async function listUploadJobs(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT upload_jobs.id, upload_jobs.asset_id, upload_jobs.status, upload_jobs.attempts,
    upload_jobs.last_error, upload_jobs.expires_at, upload_jobs.created_at, upload_jobs.updated_at,
    assets.original_name, assets.size_bytes, assets.media_type
    FROM upload_jobs JOIN assets ON assets.id = upload_jobs.asset_id
    ORDER BY upload_jobs.updated_at DESC LIMIT 100`).all<Record<string, unknown>>()
  return result.results
}

export async function createTelegramAsset(db: D1Database, input: {
  id: string
  source: 'telegram' | 'mock'
  mediaType: string
  mimeType: string
  originalName: string
  sizeBytes: number
  width?: number
  height?: number
  durationMs?: number
  takenAt: string
  chatId: string
  messageId: number
  fileId: string
  fileUniqueId: string
  previewFileId?: string
  status: 'queued' | 'limited' | 'ready'
  telegramUrl?: string | null
}): Promise<{ created: boolean; id: string }> {
  const existing = await db.prepare(`SELECT id FROM assets WHERE storage_file_unique_id = ? OR (storage_chat_id = ? AND storage_message_id = ?) LIMIT 1`)
    .bind(input.fileUniqueId, input.chatId, input.messageId).first<{ id: string }>()
  if (existing) return { created: false, id: existing.id }
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO assets (
    id, storage_chat_id, storage_message_id, storage_file_id, storage_file_unique_id, preview_file_id,
    source, media_type, mime_type, original_name, size_bytes, width, height, duration_ms, taken_at,
    uploaded_at, status, analysis_status, telegram_url, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      input.id, input.chatId, input.messageId, input.fileId, input.fileUniqueId, input.previewFileId ?? null,
      input.source, input.mediaType, input.mimeType, input.originalName, input.sizeBytes, input.width ?? null,
      input.height ?? null, input.durationMs ?? null, input.takenAt, now, input.status,
      input.status === 'limited' ? 'limited' : input.status === 'ready' ? 'ready' : 'queued', input.telegramUrl ?? null, now, now,
    ).run()
  return { created: true, id: input.id }
}
