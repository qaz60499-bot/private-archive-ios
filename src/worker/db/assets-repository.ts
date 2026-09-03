import { classifyFileCategory, inferExtension } from '../domain/asset-metadata'
import type { AssetRow, AssetTag, ReserveAssetInput, StoredFile } from '../domain/types'
import { hashToken } from '../lib/crypto'
import { appUserAssetPermissionPredicate } from './app-user-access-repository'

export const PERSONAL_WORKSPACE_ID = 'personal'

const ASSET_FROM = `assets LEFT JOIN storage_objects ON storage_objects.id = assets.storage_object_id`
const ASSET_COLUMNS = `
  assets.id, assets.storage_provider,
  COALESCE(storage_objects.storage_backend, assets.storage_backend) AS storage_backend,
  COALESCE(storage_objects.storage_chat_id, assets.storage_chat_id) AS storage_chat_id,
  COALESCE(storage_objects.storage_message_id, assets.storage_message_id) AS storage_message_id,
  COALESCE(storage_objects.storage_file_id, assets.storage_file_id) AS storage_file_id,
  COALESCE(storage_objects.storage_file_unique_id, assets.storage_file_unique_id) AS storage_file_unique_id,
  COALESCE(storage_objects.telegram_media_id, assets.telegram_media_id) AS telegram_media_id,
  COALESCE(storage_objects.import_origin, assets.import_origin) AS import_origin,
  COALESCE(storage_objects.preview_message_id, assets.preview_message_id) AS preview_message_id,
  COALESCE(storage_objects.preview_file_id, assets.preview_file_id) AS preview_file_id,
  assets.source, assets.media_type, assets.mime_type, assets.original_name, assets.size_bytes, assets.content_hash,
  assets.workspace_id, assets.source_id, assets.storage_object_id, assets.extension, assets.file_category, assets.metadata_json,
  assets.archived, assets.archived_at, assets.pre_trash_status, assets.deleted_at, assets.purge_at, assets.purge_state,
  assets.purge_error, assets.logical_path, assets.last_viewed_at,
  assets.width, assets.height, assets.duration_ms, assets.taken_at, assets.uploaded_at, assets.latitude, assets.longitude,
  assets.place_id, assets.primary_category, assets.category_override, assets.category_override_at, assets.person_count,
  assets.scene, assets.favorite, assets.status, assets.analysis_status,
  COALESCE(storage_objects.telegram_url, assets.telegram_url) AS telegram_url, assets.created_at, assets.updated_at
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
  const extension = inferExtension(params.input.originalName)
  const fileCategory = classifyFileCategory(params.input.originalName, params.input.mimeType, params.input.mediaType)
  const metadataJson = params.input.metadata ? JSON.stringify(params.input.metadata) : null
  const logicalPath = params.input.logicalPath ?? '/'
  const searchText = `${params.input.originalName} ${extension} ${fileCategory} ${params.input.mimeType} ${logicalPath}`.trim()
  await db.batch([
    db.prepare(`INSERT INTO assets (
      id, workspace_id, source_id, storage_backend, import_origin, source, media_type, mime_type, original_name, size_bytes, content_hash, extension, file_category,
      metadata_json, logical_path, width, height, duration_ms, taken_at, uploaded_at, latitude, longitude,
      status, analysis_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_upload', 'pending', ?, ?)`)
      .bind(
        params.id, PERSONAL_WORKSPACE_ID, params.input.sourceId ?? 'telegram-legacy', params.input.storageBackend ?? 'telegram_user_group', params.input.importOrigin ?? 'web', params.input.mediaType, params.input.mimeType, params.input.originalName, params.input.sizeBytes,
        params.input.contentHash ?? null, extension, fileCategory, metadataJson, logicalPath,
        params.input.width ?? null, params.input.height ?? null, params.input.durationMs ?? null,
        params.takenAt, params.uploadedAt, params.input.latitude ?? null, params.input.longitude ?? null, now, now,
      ),
    db.prepare(`INSERT INTO upload_jobs (
      id, asset_id, upload_token_hash, status, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'waiting', ?, ?, ?)`)
      .bind(params.jobId, params.id, tokenHash, params.tokenExpiresAt, now, now),
    db.prepare(`INSERT INTO asset_search (asset_id, workspace_id, search_text) VALUES (?, ?, ?)`)
      .bind(params.id, PERSONAL_WORKSPACE_ID, searchText),
  ])
}

export async function verifyUploadToken(db: D1Database, assetId: string, token: string): Promise<boolean> {
  const row = await db.prepare(
    `SELECT upload_token_hash, expires_at FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`,
  ).bind(assetId).first<{ upload_token_hash: string; expires_at: string }>()
  if (!row || Date.parse(row.expires_at) <= Date.now()) return false
  return row.upload_token_hash === await hashToken(token)
}

export async function getActiveAssetByContentHash(db: D1Database, contentHash: string, sourceId = 'telegram-legacy', storageBackend: AssetRow['storage_backend'] = 'telegram_bot'): Promise<AssetRow | null> {
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM}
    WHERE assets.workspace_id = ? AND assets.source_id = ? AND COALESCE(storage_objects.storage_backend, assets.storage_backend) = ? AND assets.content_hash = ? AND assets.status != 'trashed'
      AND (assets.storage_object_id IS NULL OR storage_objects.delete_state = 'active')
    ORDER BY assets.created_at DESC LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, sourceId, storageBackend, contentHash).first<AssetRow>()
}

export interface StorageObjectState {
  id: string
  deleteState: 'active' | 'deleting' | 'delete_failed' | 'deleted'
}

export async function getStorageObjectStateByFileUniqueId(db: D1Database, fileUniqueId: string, sourceId = 'telegram-legacy', storageBackend: AssetRow['storage_backend'] = 'telegram_bot'): Promise<StorageObjectState | null> {
  const row = await db.prepare(`SELECT id, delete_state FROM storage_objects
    WHERE workspace_id = ? AND source_id = ? AND storage_backend = ? AND storage_file_unique_id = ? LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, sourceId, storageBackend, fileUniqueId).first<{ id: string; delete_state: StorageObjectState['deleteState'] }>()
  return row ? { id: row.id, deleteState: row.delete_state } : null
}

export async function repairAssetFromActiveStorageObject(db: D1Database, assetId: string): Promise<boolean> {
  const asset = await db.prepare(`SELECT source_id, storage_backend, content_hash, size_bytes, mime_type
    FROM assets WHERE id = ? AND workspace_id = ? AND storage_object_id IS NULL AND storage_file_id IS NULL`)
    .bind(assetId, PERSONAL_WORKSPACE_ID)
    .first<{ source_id: string; storage_backend: AssetRow['storage_backend']; content_hash: string | null; size_bytes: number; mime_type: string }>()
  if (!asset?.content_hash) return false

  const object = await db.prepare(`SELECT id FROM storage_objects
    WHERE workspace_id = ? AND source_id = ? AND storage_backend = ? AND content_hash = ?
      AND size_bytes = ? AND mime_type = ? AND delete_state = 'active'
    ORDER BY created_at DESC LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, asset.source_id, asset.storage_backend, asset.content_hash, asset.size_bytes, asset.mime_type)
    .first<{ id: string }>()
  if (!object) return false

  const now = new Date().toISOString()
  const attached = await db.prepare(`UPDATE assets SET storage_object_id = ?, status = 'stored', updated_at = ?
    WHERE id = ? AND workspace_id = ? AND storage_object_id IS NULL AND storage_file_id IS NULL`)
    .bind(object.id, now, assetId, PERSONAL_WORKSPACE_ID).run()
  if (attached.meta.changes === 0) return false

  await db.prepare(`UPDATE upload_jobs SET status = 'done', last_error = NULL, updated_at = ?
    WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)`)
    .bind(now, assetId).run()
  return true
}

export async function createDeduplicatedLogicalAsset(db: D1Database, params: {
  id: string
  existing: AssetRow
  input: ReserveAssetInput
  takenAt: string
  uploadedAt: string
}): Promise<void> {
  if (!params.existing.storage_object_id) throw new Error('DEDUP_STORAGE_OBJECT_MISSING')
  const extension = inferExtension(params.input.originalName)
  const fileCategory = classifyFileCategory(params.input.originalName, params.input.mimeType, params.input.mediaType)
  const metadataJson = params.input.metadata ? JSON.stringify(params.input.metadata) : params.existing.metadata_json
  const inserted = await db.prepare(`INSERT INTO assets (
      id, workspace_id, source_id, storage_provider, storage_backend, import_origin, storage_object_id, source, media_type, mime_type, original_name, size_bytes,
      content_hash, extension, file_category, metadata_json, logical_path, width, height, duration_ms, taken_at, uploaded_at,
      latitude, longitude, place_id, primary_category, category_override, category_override_at, person_count, scene,
      favorite, archived, status, analysis_status, created_at, updated_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, 'web', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND workspace_id = ? AND delete_state = 'active')`)
    .bind(
      params.id, PERSONAL_WORKSPACE_ID, params.input.sourceId ?? params.existing.source_id, params.existing.storage_provider, params.existing.storage_backend, params.input.importOrigin ?? 'web', params.existing.storage_object_id,
      params.input.mediaType, params.input.mimeType, params.input.originalName, params.input.sizeBytes,
      params.input.contentHash ?? params.existing.content_hash, extension, fileCategory, metadataJson, params.input.logicalPath ?? '/',
      params.input.width ?? params.existing.width, params.input.height ?? params.existing.height, params.input.durationMs ?? params.existing.duration_ms,
      params.takenAt, params.uploadedAt, params.input.latitude ?? params.existing.latitude, params.input.longitude ?? params.existing.longitude,
      params.existing.place_id, params.existing.primary_category, params.existing.category_override, params.existing.category_override_at,
      params.existing.person_count, params.existing.scene, params.existing.status, params.existing.analysis_status,
      params.uploadedAt, params.uploadedAt, params.existing.storage_object_id, PERSONAL_WORKSPACE_ID,
    ).run()
  if (inserted.meta.changes === 0) throw new Error('DEDUP_STORAGE_OBJECT_UNAVAILABLE')
  const existingTags = await db.prepare(`SELECT tag_id, confidence, source FROM asset_tags WHERE asset_id = ?`).bind(params.existing.id)
    .all<{ tag_id: string; confidence: number | null; source: string }>()
  if (existingTags.results.length) {
    await db.batch(existingTags.results.map((tag) => db.prepare(`INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, confidence, source) VALUES (?, ?, ?, ?)`)
      .bind(params.id, tag.tag_id, tag.confidence, tag.source)))
  }
  await refreshAssetSearchIndex(db, params.id)
}

export async function getLatestUploadJobState(db: D1Database, assetId: string): Promise<{ status: string; expires_at: string; updated_at: string } | null> {
  return db.prepare(`SELECT status, expires_at, updated_at FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(assetId).first<{ status: string; expires_at: string; updated_at: string }>()
}

export async function createUploadJobForAsset(db: D1Database, params: {
  assetId: string
  jobId: string
  token: string
  tokenExpiresAt: string
  expectedUpdatedAt?: string
}): Promise<boolean> {
  const now = new Date().toISOString()
  const tokenHash = await hashToken(params.token)

  if (params.expectedUpdatedAt) {
    // Keep capability rotation and the asset's resumable state in one D1 transaction.
    // If the CAS loses a race, the second statement is guarded by the newly generated
    // token hash/timestamp and therefore cannot mutate the asset independently.
    const [rotated] = await db.batch([
      db.prepare(`UPDATE upload_jobs
        SET upload_token_hash = ?, status = 'waiting', last_error = NULL, expires_at = ?, updated_at = ?
        WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)
          AND updated_at = ? AND status != 'done'`)
        .bind(tokenHash, params.tokenExpiresAt, now, params.assetId, params.expectedUpdatedAt),
      db.prepare(`UPDATE assets SET status = 'pending_upload', updated_at = ?
        WHERE id = ? AND storage_file_id IS NULL AND status != 'pending_upload'
          AND EXISTS (
            SELECT 1 FROM upload_jobs
            WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)
              AND upload_token_hash = ? AND updated_at = ? AND status = 'waiting'
          )`)
        .bind(now, params.assetId, params.assetId, tokenHash, now),
    ])
    return rotated.meta.changes > 0
  }

  // New retry rows are still needed for legacy/non-CAS callers, but the job and asset
  // transition must commit or roll back together so UI state never advertises a retry
  // without a matching server capability (or vice versa).
  await db.batch([
    db.prepare(`INSERT INTO upload_jobs (id, asset_id, upload_token_hash, status, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, 'waiting', ?, ?, ?)`)
      .bind(params.jobId, params.assetId, tokenHash, params.tokenExpiresAt, now, now),
    db.prepare(`UPDATE assets SET status = 'pending_upload', updated_at = ?
      WHERE id = ? AND storage_file_id IS NULL AND status != 'pending_upload'`)
      .bind(now, params.assetId),
  ])
  return true
}

export async function claimUploadStarted(db: D1Database, assetId: string, token: string, staleAfterMs?: number): Promise<number | null> {
  const nowDate = new Date()
  const now = nowDate.toISOString()
  const staleCutoff = staleAfterMs === undefined
    ? '0001-01-01T00:00:00.000Z'
    : new Date(nowDate.getTime() - Math.max(0, staleAfterMs)).toISOString()
  const tokenHash = await hashToken(token)
  const result = await db.prepare(`UPDATE upload_jobs
    SET status = 'uploading', attempts = attempts + 1, updated_at = ?
    WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)
      AND upload_token_hash = ? AND expires_at > ?
      AND (status IN ('waiting', 'failed') OR (status = 'uploading' AND updated_at <= ?))`)
    .bind(now, assetId, tokenHash, now, staleCutoff).run()
  if (result.meta.changes === 0) return null
  const row = await db.prepare(`SELECT attempts FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`)
    .bind(assetId).first<{ attempts: number }>()
  return row?.attempts ?? null
}

export interface MarkStoredResult {
  attached: boolean
  discardStoredMessage: boolean
  staleAttempt?: boolean
}

export async function markStored(db: D1Database, assetId: string, stored: StoredFile, expectedAttempt?: number): Promise<MarkStoredResult> {
  const now = new Date().toISOString()
  if (expectedAttempt !== undefined) {
    const job = await db.prepare(`SELECT status, attempts FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(assetId).first<{ status: string; attempts: number }>()
    if (!job || job.status !== 'uploading' || job.attempts !== expectedAttempt) {
      return { attached: false, discardStoredMessage: true, staleAttempt: true }
    }
  }
  const objectId = `obj-${assetId}`
  const source = await db.prepare(`SELECT source_id, storage_backend FROM assets
    WHERE id = ? AND workspace_id = ? AND status != 'trashed'`)
    .bind(assetId, PERSONAL_WORKSPACE_ID).first<{ source_id: string; storage_backend: AssetRow['storage_backend'] }>()
  if (!source) return { attached: false, discardStoredMessage: true }
  if (source.storage_backend !== stored.backend) return { attached: false, discardStoredMessage: true }
  const existing = await getStorageObjectStateByFileUniqueId(db, stored.fileUniqueId, source.source_id, stored.backend)
  let targetObjectId = existing?.id ?? objectId
  let discardStoredMessage = existing?.deleteState === 'active'

  if (existing?.deleteState === 'deleting' || existing?.deleteState === 'delete_failed') {
    return { attached: false, discardStoredMessage: true }
  }

  if (existing?.deleteState === 'deleted') {
    const reactivated = await db.prepare(`UPDATE storage_objects SET
        storage_backend = ?, storage_chat_id = ?, storage_message_id = ?, storage_file_id = ?, telegram_media_id = ?, import_origin = ?, preview_message_id = ?, preview_file_id = ?,
        telegram_url = ?, delete_state = 'active', delete_error = NULL, manifest_version = 1, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND delete_state = 'deleted'`)
      .bind(
        stored.backend, stored.chatId, stored.messageId, stored.fileId, stored.mediaId ?? null, stored.importOrigin ?? 'web', stored.previewFileId ? stored.messageId : null,
        stored.previewFileId ?? null, stored.telegramUrl, now, existing.id, PERSONAL_WORKSPACE_ID,
      ).run()
    if (reactivated.meta.changes === 0) return { attached: false, discardStoredMessage: true }
    discardStoredMessage = false
  } else if (!existing) {
    await db.prepare(`INSERT OR IGNORE INTO storage_objects (
        id, workspace_id, source_id, storage_provider, storage_backend, storage_chat_id, storage_message_id, storage_file_id, storage_file_unique_id,
        telegram_media_id, import_origin, preview_message_id, preview_file_id, telegram_url, content_hash, size_bytes, mime_type, manifest_version, created_at, updated_at
      ) SELECT ?, workspace_id, source_id, storage_provider, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, content_hash, size_bytes, mime_type, 1, ?, ?
        FROM assets WHERE id = ? AND workspace_id = ?`)
      .bind(
        objectId, stored.backend, stored.chatId, stored.messageId, stored.fileId, stored.fileUniqueId,
        stored.mediaId ?? null, stored.importOrigin ?? 'web', stored.previewFileId ? stored.messageId : null, stored.previewFileId ?? null, stored.telegramUrl,
        now, now, assetId, PERSONAL_WORKSPACE_ID,
      ).run()
    const inserted = await getStorageObjectStateByFileUniqueId(db, stored.fileUniqueId, source.source_id, stored.backend)
    if (!inserted || inserted.deleteState !== 'active') return { attached: false, discardStoredMessage: true }
    targetObjectId = inserted.id
    discardStoredMessage = inserted.id !== objectId
  }

  const preserveAssetStorageColumns = discardStoredMessage || source.source_id !== 'telegram-legacy'
  const attached = await db.prepare(`UPDATE assets SET
      storage_backend = ?, telegram_media_id = ?, import_origin = ?,
      storage_chat_id = CASE WHEN ? THEN storage_chat_id ELSE ? END,
      storage_message_id = CASE WHEN ? THEN storage_message_id ELSE ? END,
      storage_file_id = CASE WHEN ? THEN storage_file_id ELSE ? END,
      storage_file_unique_id = CASE WHEN ? THEN storage_file_unique_id ELSE ? END,
      telegram_url = CASE WHEN ? THEN telegram_url ELSE ? END,
      storage_object_id = ?,
      preview_message_id = CASE WHEN ? OR preview_file_id IS NOT NULL OR ? IS NULL THEN preview_message_id ELSE ? END,
      preview_file_id = CASE WHEN ? THEN preview_file_id ELSE COALESCE(preview_file_id, ?) END,
      status = 'stored', updated_at = ?
    WHERE id = ? AND workspace_id = ?
      AND EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND workspace_id = ? AND delete_state = 'active')`)
    .bind(
      stored.backend, stored.mediaId ?? null, stored.importOrigin ?? 'web',
      preserveAssetStorageColumns, stored.chatId,
      preserveAssetStorageColumns, stored.messageId,
      preserveAssetStorageColumns, stored.fileId,
      preserveAssetStorageColumns, stored.fileUniqueId,
      preserveAssetStorageColumns, stored.telegramUrl,
      targetObjectId,
      preserveAssetStorageColumns, stored.previewFileId ?? null, stored.messageId,
      preserveAssetStorageColumns, stored.previewFileId ?? null,
      now, assetId, PERSONAL_WORKSPACE_ID, targetObjectId, PERSONAL_WORKSPACE_ID,
    ).run()
  if (attached.meta.changes === 0) return { attached: false, discardStoredMessage: true }

  await db.prepare(`UPDATE upload_jobs SET status = 'done', updated_at = ?
    WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)`)
    .bind(now, assetId).run()
  return { attached: true, discardStoredMessage }
}

export async function markUploadFailed(db: D1Database, assetId: string, error: string, expectedAttempt?: number): Promise<boolean> {
  const now = new Date().toISOString()
  if (expectedAttempt !== undefined) {
    const job = await db.prepare(`UPDATE upload_jobs SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)
        AND status = 'uploading' AND attempts = ?`)
      .bind(error.slice(0, 320), now, assetId, expectedAttempt).run()
    if (job.meta.changes === 0) return false
    await db.prepare(`UPDATE assets SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'trashed'`).bind(now, assetId).run()
    return true
  }
  await db.batch([
    db.prepare(`UPDATE assets SET status = 'failed', updated_at = ? WHERE id = ? AND status != 'trashed'`).bind(now, assetId),
    db.prepare(`UPDATE upload_jobs SET status = 'failed', last_error = ?, updated_at = ?
      WHERE id = (SELECT id FROM upload_jobs WHERE asset_id = ? ORDER BY created_at DESC LIMIT 1)`)
      .bind(error.slice(0, 320), now, assetId),
  ])
  return true
}

export async function markPreviewStored(db: D1Database, assetId: string, stored: StoredFile): Promise<void> {
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`UPDATE assets SET preview_message_id = ?, preview_file_id = ?, updated_at = ? WHERE id = ?`)
      .bind(stored.messageId, stored.fileId, now, assetId),
    db.prepare(`UPDATE storage_objects SET preview_message_id = ?, preview_file_id = ?, updated_at = ?
      WHERE id = (SELECT storage_object_id FROM assets WHERE id = ?)`)
      .bind(stored.messageId, stored.fileId, now, assetId),
  ])
}

export async function clearPreviewStored(db: D1Database, assetId: string): Promise<void> {
  const now = new Date().toISOString()
  await db.batch([
    db.prepare(`UPDATE assets SET preview_message_id = NULL, preview_file_id = NULL, updated_at = ? WHERE id = ?`)
      .bind(now, assetId),
    db.prepare(`UPDATE storage_objects SET preview_message_id = NULL, preview_file_id = NULL, updated_at = ?
      WHERE id = (SELECT storage_object_id FROM assets WHERE id = ?)`)
      .bind(now, assetId),
  ])
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
  return db.prepare(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM} WHERE assets.workspace_id = ? AND assets.id = ?`)
    .bind(PERSONAL_WORKSPACE_ID, id).first<AssetRow>()
}

export async function getTagsForAsset(db: D1Database, id: string): Promise<AssetTag[]> {
  const result = await db.prepare(`SELECT tags.slug, tags.name, asset_tags.confidence, asset_tags.source
    FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = ? ORDER BY tags.name`)
    .bind(id).all<AssetTag>()
  return result.results
}

export async function refreshAssetSearchIndex(db: D1Database, id: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM asset_search WHERE asset_id = ?').bind(id),
    db.prepare(`INSERT INTO asset_search (asset_id, workspace_id, search_text)
      SELECT assets.id, assets.workspace_id,
        trim(
          assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
          COALESCE(assets.logical_path, '') || ' ' || COALESCE(assets.scene, '') || ' ' ||
          COALESCE(assets.category_override, assets.primary_category, '') || ' ' ||
          COALESCE((SELECT places.label || ' ' || COALESCE(places.city, '') FROM places WHERE places.id = assets.place_id), '') || ' ' ||
          COALESCE((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
          COALESCE((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
        )
      FROM assets WHERE assets.id = ? AND assets.workspace_id = ?`)
      .bind(id, PERSONAL_WORKSPACE_ID),
  ])
}

export async function setManualTags(db: D1Database, id: string, names: string[]): Promise<boolean> {
  const asset = await db.prepare('SELECT id FROM assets WHERE id = ? AND workspace_id = ?').bind(id, PERSONAL_WORKSPACE_ID).first<{ id: string }>()
  if (!asset) return false
  const normalized = [...new Set(names.map((name) => name.trim()).filter(Boolean).map((name) => name.slice(0, 80)))].slice(0, 20)
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM asset_tags WHERE asset_id = ? AND source = 'manual'`).bind(id),
  ]
  for (const name of normalized) {
    const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || crypto.randomUUID()
    const tagId = `tag-manual-${slug}`
    statements.push(
      db.prepare(`INSERT INTO tags (id, slug, name, kind) VALUES (?, ?, ?, 'manual')
        ON CONFLICT(slug) DO UPDATE SET name = excluded.name`).bind(tagId, slug, name),
      db.prepare(`INSERT INTO asset_tags (asset_id, tag_id, confidence, source) VALUES (?, ?, NULL, 'manual')
        ON CONFLICT(asset_id, tag_id) DO UPDATE SET source = 'manual', confidence = NULL`).bind(id, tagId),
    )
  }
  await db.batch(statements)
  await refreshAssetSearchIndex(db, id)
  return true
}

export async function markAssetViewed(db: D1Database, id: string): Promise<void> {
  await db.prepare(`UPDATE assets SET last_viewed_at = ? WHERE id = ? AND workspace_id = ? AND status != 'trashed'`)
    .bind(new Date().toISOString(), id, PERSONAL_WORKSPACE_ID).run()
}

export interface AssetListFilters {
  limit: number
  cursor?: string
  mediaType?: string
  favorite?: boolean
  category?: string
  fileCategory?: string
  extension?: string
  mimeType?: string
  archived?: boolean
  tag?: string
  query?: string
  status?: string
  albumId?: string
  logicalPath?: string
  sourceId?: string
  principalId?: string
  appUserId?: string
  takenAfter?: string
  takenBefore?: string
  minSizeBytes?: number
  maxSizeBytes?: number
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
  const conditions = ['assets.workspace_id = ?']
  const values: unknown[] = [PERSONAL_WORKSPACE_ID]
  if (filters.status === 'trashed') conditions.push("assets.status = 'trashed'")
  else if (filters.status) {
    conditions.push('assets.status = ?')
    values.push(filters.status)
  } else {
    // The archive surface represents committed media. Pending/failed reservations
    // belong in the upload queue until an original is actually stored, otherwise a
    // just-selected iPhone photo appears as a broken viewer card before Telegram has it.
    conditions.push("assets.status NOT IN ('trashed', 'pending_upload', 'failed')")
  }

  if (filters.cursor) {
    const cursor = decodeAssetCursor(filters.cursor)
    if (cursor) {
      conditions.push('(assets.taken_at < ? OR (assets.taken_at = ? AND assets.id < ?))')
      values.push(cursor.takenAt, cursor.takenAt, cursor.id)
    } else {
      conditions.push('assets.taken_at < ?')
      values.push(filters.cursor)
    }
  }
  if (filters.mediaType) {
    conditions.push('assets.media_type = ?')
    values.push(filters.mediaType)
  }
  if (filters.favorite !== undefined) {
    conditions.push('assets.favorite = ?')
    values.push(filters.favorite ? 1 : 0)
  }
  if (filters.archived !== undefined) {
    conditions.push('assets.archived = ?')
    values.push(filters.archived ? 1 : 0)
  } else if (filters.status !== 'trashed' && !filters.albumId) {
    conditions.push('assets.archived = 0')
  }
  if (filters.category) {
    conditions.push("COALESCE(assets.category_override, assets.primary_category, 'other') = ?")
    values.push(filters.category)
  }
  if (filters.fileCategory) {
    conditions.push('assets.file_category = ?')
    values.push(filters.fileCategory)
  }
  if (filters.extension) {
    conditions.push('assets.extension = ?')
    values.push(filters.extension.toLowerCase())
  }
  if (filters.mimeType) {
    conditions.push('assets.mime_type = ?')
    values.push(filters.mimeType.toLowerCase())
  }
  if (filters.albumId) {
    conditions.push('EXISTS (SELECT 1 FROM album_assets WHERE album_assets.album_id = ? AND album_assets.asset_id = assets.id)')
    values.push(filters.albumId)
  }
  if (filters.tag) {
    conditions.push(`EXISTS (SELECT 1 FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id
      WHERE asset_tags.asset_id = assets.id AND tags.slug = ?)`)
    values.push(filters.tag.toLowerCase())
  }
  if (filters.logicalPath) {
    conditions.push('assets.logical_path = ?')
    values.push(filters.logicalPath)
  }
  if (filters.sourceId) {
    conditions.push('assets.source_id = ?')
    values.push(filters.sourceId)
  }
  if (filters.principalId) {
    conditions.push(`EXISTS (
      SELECT 1 FROM access_grants grant_row
      WHERE grant_row.workspace_id = assets.workspace_id AND grant_row.principal_id = ? AND grant_row.permission = 'read'
        AND (
          (grant_row.scope_type = 'source' AND grant_row.scope_id = assets.source_id)
          OR (grant_row.scope_type = 'asset' AND grant_row.scope_id = assets.id)
          OR (grant_row.scope_type = 'album' AND EXISTS (
            SELECT 1 FROM album_assets scoped_album_asset
            WHERE scoped_album_asset.album_id = grant_row.scope_id AND scoped_album_asset.asset_id = assets.id
          ))
        )
    )`)
    values.push(filters.principalId)
  }
  if (filters.appUserId) {
    conditions.push(appUserAssetPermissionPredicate('assets'))
    values.push(filters.appUserId, 'read')
  }
  if (filters.takenAfter) {
    conditions.push('assets.taken_at >= ?')
    values.push(filters.takenAfter)
  }
  if (filters.takenBefore) {
    conditions.push('assets.taken_at < ?')
    values.push(filters.takenBefore)
  }
  if (filters.minSizeBytes !== undefined) {
    conditions.push('assets.size_bytes >= ?')
    values.push(filters.minSizeBytes)
  }
  if (filters.maxSizeBytes !== undefined) {
    conditions.push('assets.size_bytes <= ?')
    values.push(filters.maxSizeBytes)
  }
  if (filters.query) {
    const tokens = filters.query.toLowerCase().trim().split(/\s+/u).filter(Boolean).slice(0, 6)
    for (const token of tokens) {
      if ([...token].length >= 3) {
        const match = `"${token.replaceAll('"', '""')}"`
        conditions.push(`assets.id IN (
          SELECT asset_id FROM asset_search WHERE workspace_id = ? AND asset_search MATCH ?
        )`)
        values.push(PERSONAL_WORKSPACE_ID, match)
      } else {
        const like = `%${token.replaceAll('%', '\\%').replaceAll('_', '\\_')}%`
        conditions.push(`assets.id IN (
          SELECT asset_id FROM asset_search WHERE workspace_id = ? AND search_text LIKE ? ESCAPE '\\'
        )`)
        values.push(PERSONAL_WORKSPACE_ID, like)
      }
    }
  }
  const limit = Math.min(Math.max(filters.limit, 1), 60)
  values.push(limit + 1)
  const result = await db.prepare(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM} WHERE ${conditions.join(' AND ')}
    ORDER BY assets.taken_at DESC, assets.id DESC LIMIT ?`).bind(...values).all<AssetRow>()
  const rows = result.results.slice(0, limit)
  const last = rows.at(-1)
  return { rows, nextCursor: result.results.length > limit && last ? encodeAssetCursor(last) : null }
}

export async function patchAsset(db: D1Database, id: string, patch: {
  favorite?: boolean
  archived?: boolean
  status?: string
  categoryOverride?: string | null
  logicalPath?: string
  originalName?: string
}): Promise<boolean> {
  const assignments: string[] = []
  const values: unknown[] = []
  if (patch.favorite !== undefined) {
    assignments.push('favorite = ?')
    values.push(patch.favorite ? 1 : 0)
  }
  if (patch.archived !== undefined) {
    assignments.push('archived = ?', 'archived_at = ?')
    values.push(patch.archived ? 1 : 0, patch.archived ? new Date().toISOString() : null)
  }
  if (patch.status) {
    assignments.push('status = ?')
    values.push(patch.status)
  }
  if (patch.categoryOverride !== undefined) {
    assignments.push('category_override = ?', 'category_override_at = ?')
    values.push(patch.categoryOverride, patch.categoryOverride ? new Date().toISOString() : null)
  }
  if (patch.logicalPath !== undefined) {
    assignments.push('logical_path = ?')
    values.push(patch.logicalPath)
  }
  if (patch.originalName !== undefined) {
    assignments.push('original_name = ?', 'extension = ?', 'file_category = ?')
    const extension = inferExtension(patch.originalName)
    const current = await getAsset(db, id)
    values.push(patch.originalName, extension, current ? classifyFileCategory(patch.originalName, current.mime_type, current.media_type) : 'other')
  }
  if (!assignments.length) return false
  assignments.push('updated_at = ?')
  values.push(new Date().toISOString(), id, PERSONAL_WORKSPACE_ID)
  const result = await db.prepare(`UPDATE assets SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ?`).bind(...values).run()
  if (result.meta.changes > 0) await refreshAssetSearchIndex(db, id)
  return result.meta.changes > 0
}

export async function getTrashRetentionDays(db: D1Database): Promise<number | null> {
  const row = await db.prepare(`SELECT value FROM app_settings WHERE key = 'trash_retention_days'`).first<{ value: string }>()
  if (!row) return 30
  if (row.value === 'never') return null
  const days = Number(row.value)
  return [7, 30, 90].includes(days) ? days : 30
}

export async function softDeleteAsset(db: D1Database, id: string): Promise<boolean> {
  const retention = await getTrashRetentionDays(db)
  const now = new Date()
  const purgeAt = retention === null ? null : new Date(now.getTime() + retention * 24 * 60 * 60 * 1000).toISOString()
  const result = await db.prepare(`UPDATE assets SET
      pre_trash_status = CASE WHEN status = 'trashed' THEN pre_trash_status ELSE status END,
      status = 'trashed', deleted_at = ?, purge_at = ?, purge_state = 'active', purge_error = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status != 'trashed'`)
    .bind(now.toISOString(), purgeAt, now.toISOString(), id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function bulkSoftDeleteAssets(db: D1Database, ids: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)].slice(0, 90)
  if (!uniqueIds.length) return 0
  const retention = await getTrashRetentionDays(db)
  const now = new Date()
  const purgeAt = retention === null ? null : new Date(now.getTime() + retention * 24 * 60 * 60 * 1000).toISOString()
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const result = await db.prepare(`UPDATE assets SET
      pre_trash_status = status, status = 'trashed', deleted_at = ?, purge_at = ?, purge_state = 'active', purge_error = NULL, updated_at = ?
    WHERE workspace_id = ? AND id IN (${placeholders}) AND status != 'trashed'`)
    .bind(now.toISOString(), purgeAt, now.toISOString(), PERSONAL_WORKSPACE_ID, ...uniqueIds).run()
  return result.meta.changes
}

export async function bulkDiscardUnstoredAssets(db: D1Database, ids: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)].slice(0, 90)
  if (!uniqueIds.length) return 0
  const retention = await getTrashRetentionDays(db)
  const now = new Date()
  const purgeAt = retention === null ? null : new Date(now.getTime() + retention * 24 * 60 * 60 * 1000).toISOString()
  const placeholders = uniqueIds.map(() => '?').join(', ')
  // Queue cleanup must never hide media that actually reached storage in a race with
  // the cancel action. Only discard reservations that are still explicitly unstored.
  const result = await db.prepare(`UPDATE assets SET
      pre_trash_status = status, status = 'trashed', deleted_at = ?, purge_at = ?, purge_state = 'active', purge_error = NULL, updated_at = ?
    WHERE workspace_id = ? AND id IN (${placeholders})
      AND status IN ('pending_upload', 'failed')
      AND storage_object_id IS NULL AND storage_file_id IS NULL`)
    .bind(now.toISOString(), purgeAt, now.toISOString(), PERSONAL_WORKSPACE_ID, ...uniqueIds).run()
  return result.meta.changes
}

export async function restoreAsset(db: D1Database, id: string): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE assets SET status = CASE
      WHEN pre_trash_status IN ('stored','queued','analyzing','ready','limited','failed') THEN pre_trash_status ELSE 'ready' END,
      pre_trash_status = NULL, deleted_at = NULL, purge_at = NULL, purge_state = 'active', purge_error = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'trashed'`)
    .bind(now, id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function bulkRestoreAssets(db: D1Database, ids: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)].slice(0, 90)
  if (!uniqueIds.length) return 0
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE assets SET status = CASE
      WHEN pre_trash_status IN ('stored','queued','analyzing','ready','limited','failed') THEN pre_trash_status ELSE 'ready' END,
      pre_trash_status = NULL, deleted_at = NULL, purge_at = NULL, purge_state = 'active', purge_error = NULL, updated_at = ?
    WHERE workspace_id = ? AND id IN (${placeholders}) AND status = 'trashed'`)
    .bind(now, PERSONAL_WORKSPACE_ID, ...uniqueIds).run()
  return result.meta.changes
}

export async function countStorageObjectReferences(db: D1Database, storageObjectId: string, excludeAssetId?: string): Promise<number> {
  const result = await db.prepare(`SELECT COUNT(*) AS count FROM assets
    WHERE workspace_id = ? AND storage_object_id = ? AND (? IS NULL OR id != ?)`)
    .bind(PERSONAL_WORKSPACE_ID, storageObjectId, excludeAssetId ?? null, excludeAssetId ?? null).first<{ count: number }>()
  return Number(result?.count ?? 0)
}

export type StorageObjectPurgeClaim = 'claimed' | 'shared' | 'busy' | 'deleted' | 'missing'

export async function claimStorageObjectForPurge(db: D1Database, storageObjectId: string, assetId: string): Promise<StorageObjectPurgeClaim> {
  const now = new Date().toISOString()
  const claimed = await db.prepare(`UPDATE storage_objects SET delete_state = 'deleting', delete_error = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND delete_state IN ('active', 'delete_failed')
      AND NOT EXISTS (
        SELECT 1 FROM assets
        WHERE workspace_id = ? AND storage_object_id = ? AND id != ?
      )`)
    .bind(now, storageObjectId, PERSONAL_WORKSPACE_ID, PERSONAL_WORKSPACE_ID, storageObjectId, assetId).run()
  if (claimed.meta.changes > 0) return 'claimed'

  const row = await db.prepare(`SELECT delete_state FROM storage_objects WHERE id = ? AND workspace_id = ?`)
    .bind(storageObjectId, PERSONAL_WORKSPACE_ID)
    .first<{ delete_state: StorageObjectState['deleteState'] }>()
  if (!row) return 'missing'
  if (row.delete_state === 'deleted') return 'deleted'
  if (await countStorageObjectReferences(db, storageObjectId, assetId) > 0) return 'shared'
  return 'busy'
}

export async function markStorageObjectDeleteFailed(db: D1Database, storageObjectId: string, error: string): Promise<void> {
  await db.prepare(`UPDATE storage_objects SET delete_state = 'delete_failed', delete_error = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND delete_state = 'deleting'`)
    .bind(error.slice(0, 320), new Date().toISOString(), storageObjectId, PERSONAL_WORKSPACE_ID).run()
}

export async function deleteLogicalAsset(db: D1Database, id: string): Promise<boolean> {
  await db.prepare('DELETE FROM asset_search WHERE asset_id = ?').bind(id).run()
  const result = await db.prepare(`DELETE FROM assets WHERE id = ? AND workspace_id = ? AND status = 'trashed'`)
    .bind(id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function markPurgeFailure(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`UPDATE assets SET purge_state = 'delete_failed', purge_error = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND status = 'trashed'`)
    .bind(error.slice(0, 320), new Date().toISOString(), id, PERSONAL_WORKSPACE_ID).run()
}

export async function markStorageObjectDeleted(db: D1Database, storageObjectId: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE storage_objects SET delete_state = 'deleted', delete_error = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ? AND delete_state = 'deleting'`)
    .bind(new Date().toISOString(), storageObjectId, PERSONAL_WORKSPACE_ID).run()
  if (result.meta.changes > 0) return true
  const row = await db.prepare(`SELECT delete_state FROM storage_objects WHERE id = ? AND workspace_id = ?`)
    .bind(storageObjectId, PERSONAL_WORKSPACE_ID).first<{ delete_state: StorageObjectState['deleteState'] }>()
  return row?.delete_state === 'deleted'
}

export async function bulkPatchAssetFlags(db: D1Database, ids: string[], patch: { favorite?: boolean; archived?: boolean }): Promise<number> {
  const uniqueIds = [...new Set(ids)].slice(0, 90)
  if (!uniqueIds.length || patch.favorite === undefined && patch.archived === undefined) return 0
  const assignments: string[] = []
  const values: unknown[] = []
  const now = new Date().toISOString()
  if (patch.favorite !== undefined) {
    assignments.push('favorite = ?')
    values.push(patch.favorite ? 1 : 0)
  }
  if (patch.archived !== undefined) {
    assignments.push('archived = ?', 'archived_at = ?')
    values.push(patch.archived ? 1 : 0, patch.archived ? now : null)
  }
  assignments.push('updated_at = ?')
  values.push(now, PERSONAL_WORKSPACE_ID)
  const placeholders = uniqueIds.map(() => '?').join(', ')
  values.push(...uniqueIds)
  const result = await db.prepare(`UPDATE assets SET ${assignments.join(', ')}
    WHERE workspace_id = ? AND id IN (${placeholders}) AND status != 'trashed'`).bind(...values).run()
  return result.meta.changes
}

export async function setManualTagsForAssets(db: D1Database, ids: string[], names: string[]): Promise<number> {
  const uniqueIds = [...new Set(ids)].filter(Boolean).slice(0, 50)
  if (!uniqueIds.length) return 0
  const normalized = [...new Set(names.map((name) => name.trim()).filter(Boolean).map((name) => name.slice(0, 80)))].slice(0, 10)
  const placeholders = uniqueIds.map(() => '?').join(', ')
  const existing = await db.prepare(`SELECT id FROM assets WHERE workspace_id = ? AND id IN (${placeholders}) AND status != 'trashed'`)
    .bind(PERSONAL_WORKSPACE_ID, ...uniqueIds).all<{ id: string }>()
  const existingIds = existing.results.map((row) => row.id)
  if (!existingIds.length) return 0
  const existingPlaceholders = existingIds.map(() => '?').join(', ')
  const statements: D1PreparedStatement[] = [
    db.prepare(`DELETE FROM asset_tags WHERE source = 'manual' AND asset_id IN (${existingPlaceholders})`).bind(...existingIds),
  ]
  for (const name of normalized) {
    const slug = name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 80) || crypto.randomUUID()
    const tagId = `tag-manual-${slug}`
    statements.push(db.prepare(`INSERT INTO tags (id, slug, name, kind) VALUES (?, ?, ?, 'manual')
      ON CONFLICT(slug) DO UPDATE SET name = excluded.name`).bind(tagId, slug, name))
    statements.push(db.prepare(`INSERT OR IGNORE INTO asset_tags (asset_id, tag_id, confidence, source)
      SELECT id, ?, NULL, 'manual' FROM assets WHERE workspace_id = ? AND id IN (${existingPlaceholders}) AND status != 'trashed'`)
      .bind(tagId, PERSONAL_WORKSPACE_ID, ...existingIds))
  }
  statements.push(
    db.prepare(`DELETE FROM asset_search WHERE asset_id IN (${existingPlaceholders})`).bind(...existingIds),
    db.prepare(`INSERT INTO asset_search (asset_id, workspace_id, search_text)
      SELECT assets.id, assets.workspace_id,
        trim(
          assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
          COALESCE(assets.logical_path, '') || ' ' || COALESCE(assets.scene, '') || ' ' ||
          COALESCE(assets.category_override, assets.primary_category, '') || ' ' ||
          COALESCE((SELECT places.label || ' ' || COALESCE(places.city, '') FROM places WHERE places.id = assets.place_id), '') || ' ' ||
          COALESCE((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
          COALESCE((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
        )
      FROM assets WHERE assets.workspace_id = ? AND assets.id IN (${existingPlaceholders})`)
      .bind(PERSONAL_WORKSPACE_ID, ...existingIds),
  )
  await db.batch(statements)
  return existingIds.length
}

export async function listRecentAssets(db: D1Database, kind: 'added' | 'viewed', limit = 30, appUserId?: string): Promise<AssetRow[]> {
  const boundedLimit = Math.min(Math.max(limit, 1), 60)
  const viewed = kind === 'viewed'
  const accessFilter = appUserId ? `AND ${appUserAssetPermissionPredicate('assets')}` : ''
  const values: unknown[] = [PERSONAL_WORKSPACE_ID]
  if (appUserId) values.push(appUserId, 'read')
  values.push(boundedLimit)
  const result = await db.prepare(`SELECT ${ASSET_COLUMNS} FROM ${ASSET_FROM}
    WHERE assets.workspace_id = ? AND assets.status NOT IN ('trashed', 'pending_upload', 'failed') ${viewed ? 'AND assets.last_viewed_at IS NOT NULL' : ''} ${accessFilter}
    ORDER BY ${viewed ? 'assets.last_viewed_at' : 'assets.uploaded_at'} DESC, assets.id DESC LIMIT ?`)
    .bind(...values).all<AssetRow>()
  return result.results
}

export async function listUploadJobs(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const result = await db.prepare(`SELECT upload_jobs.id, upload_jobs.asset_id, upload_jobs.status, upload_jobs.attempts,
    upload_jobs.last_error, upload_jobs.expires_at, upload_jobs.created_at, upload_jobs.updated_at,
    assets.original_name, assets.size_bytes, assets.media_type
    FROM upload_jobs JOIN assets ON assets.id = upload_jobs.asset_id
    WHERE upload_jobs.id = (
      SELECT latest.id FROM upload_jobs latest
      WHERE latest.asset_id = upload_jobs.asset_id
      ORDER BY latest.created_at DESC LIMIT 1
    )
    ORDER BY upload_jobs.updated_at DESC LIMIT 100`).all<Record<string, unknown>>()
  return result.results
}

export async function createTelegramAsset(db: D1Database, input: {
  id: string
  sourceId?: string
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
  storageBackend?: AssetRow['storage_backend']
  telegramMediaId?: string | null
  importOrigin?: string
}): Promise<{ created: boolean; id: string }> {
  const sourceId = input.sourceId ?? 'telegram-legacy'
  const storageBackend = input.storageBackend ?? 'telegram_bot'
  const importOrigin = input.importOrigin ?? (storageBackend === 'telegram_user_group' ? 'telegram_user_group' : 'telegram_bot')
  const existingMessage = await db.prepare(`SELECT assets.id FROM assets LEFT JOIN storage_objects ON storage_objects.id = assets.storage_object_id
    WHERE assets.workspace_id = ? AND COALESCE(storage_objects.storage_backend, assets.storage_backend) = ?
      AND COALESCE(storage_objects.storage_chat_id, assets.storage_chat_id) = ?
      AND COALESCE(storage_objects.storage_message_id, assets.storage_message_id) = ? LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, storageBackend, input.chatId, input.messageId).first<{ id: string }>()
  if (existingMessage) return { created: false, id: existingMessage.id }

  const existingObject = await getStorageObjectStateByFileUniqueId(db, input.fileUniqueId, sourceId, storageBackend)
  if (existingObject?.deleteState === 'deleting' || existingObject?.deleteState === 'delete_failed') {
    throw new Error('STORAGE_OBJECT_DELETE_IN_PROGRESS')
  }
  const now = new Date().toISOString()
  const objectId = existingObject?.id ?? `obj-${input.id}`
  const reuseActiveObject = existingObject?.deleteState === 'active'
  const keepLegacyColumns = sourceId === 'telegram-legacy' && !reuseActiveObject
  const extension = inferExtension(input.originalName)
  const fileCategory = classifyFileCategory(input.originalName, input.mimeType, input.mediaType as AssetRow['media_type'])
  const statements: D1PreparedStatement[] = []
  if (existingObject?.deleteState === 'deleted') {
    statements.push(db.prepare(`UPDATE storage_objects SET
        storage_backend = ?, storage_chat_id = ?, storage_message_id = ?, storage_file_id = ?, telegram_media_id = ?, import_origin = ?, preview_message_id = ?, preview_file_id = ?,
        telegram_url = ?, size_bytes = ?, mime_type = ?, delete_state = 'active', delete_error = NULL, updated_at = ?
      WHERE id = ? AND workspace_id = ? AND delete_state = 'deleted'`)
      .bind(
        storageBackend, input.chatId, input.messageId, input.fileId, input.telegramMediaId ?? null, importOrigin, input.previewFileId ? input.messageId : null,
        input.previewFileId ?? null, input.telegramUrl ?? null, input.sizeBytes, input.mimeType,
        now, objectId, PERSONAL_WORKSPACE_ID,
      ))
  } else if (!existingObject) {
    statements.push(db.prepare(`INSERT INTO storage_objects (
      id, workspace_id, source_id, storage_provider, storage_backend, storage_chat_id, storage_message_id, storage_file_id, storage_file_unique_id,
      telegram_media_id, import_origin, preview_message_id, preview_file_id, telegram_url, size_bytes, mime_type, created_at, updated_at
    ) VALUES (?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(
        objectId, PERSONAL_WORKSPACE_ID, sourceId, storageBackend, input.chatId, input.messageId, input.fileId, input.fileUniqueId,
        input.telegramMediaId ?? null, importOrigin, input.previewFileId ? input.messageId : null, input.previewFileId ?? null, input.telegramUrl ?? null,
        input.sizeBytes, input.mimeType, now, now,
      ))
  }
  statements.push(db.prepare(`INSERT INTO assets (
      id, workspace_id, source_id, storage_provider, storage_backend, import_origin, telegram_media_id, storage_object_id, storage_chat_id, storage_message_id, storage_file_id,
      storage_file_unique_id, preview_file_id, source, media_type, mime_type, original_name, size_bytes,
      extension, file_category, width, height, duration_ms, taken_at, uploaded_at, status, analysis_status,
      telegram_url, created_at, updated_at
    ) SELECT ?, ?, ?, 'telegram', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM storage_objects WHERE id = ? AND workspace_id = ? AND delete_state = 'active')`)
    .bind(
      input.id, PERSONAL_WORKSPACE_ID, sourceId, storageBackend, importOrigin, input.telegramMediaId ?? null, objectId,
      keepLegacyColumns ? input.chatId : null, keepLegacyColumns ? input.messageId : null, keepLegacyColumns ? input.fileId : null,
      keepLegacyColumns ? input.fileUniqueId : null, keepLegacyColumns ? input.previewFileId ?? null : null,
      input.source, input.mediaType, input.mimeType, input.originalName, input.sizeBytes, extension, fileCategory,
      input.width ?? null, input.height ?? null, input.durationMs ?? null, input.takenAt, now, input.status,
      input.status === 'limited' ? 'limited' : input.status === 'ready' ? 'ready' : 'queued',
      keepLegacyColumns ? input.telegramUrl ?? null : null, now, now, objectId, PERSONAL_WORKSPACE_ID,
    ))
  await db.batch(statements)
  const created = await db.prepare(`SELECT id FROM assets WHERE id = ? AND workspace_id = ?`).bind(input.id, PERSONAL_WORKSPACE_ID).first<{ id: string }>()
  if (!created) throw new Error('STORAGE_OBJECT_DELETE_IN_PROGRESS')
  await refreshAssetSearchIndex(db, input.id)
  return { created: true, id: input.id }
}
