import { PERSONAL_WORKSPACE_ID } from './assets-repository'

export interface UsageSnapshot {
  workspaceId: string
  fileCount: number
  photoCount: number
  storageBytes: number
  uploadCount: number
  uploadBytes: number
  quotaFiles: number | null
  quotaStorageBytes: number | null
  updatedAt: string
}

export async function getUsageSnapshot(db: D1Database): Promise<UsageSnapshot> {
  const row = await db.prepare(`SELECT workspace_id, file_count, photo_count, storage_bytes, upload_count, upload_bytes,
    quota_files, quota_storage_bytes, updated_at FROM usage_snapshots WHERE workspace_id = ?`)
    .bind(PERSONAL_WORKSPACE_ID).first<{
      workspace_id: string
      file_count: number
      photo_count: number
      storage_bytes: number
      upload_count: number
      upload_bytes: number
      quota_files: number | null
      quota_storage_bytes: number | null
      updated_at: string
    }>()
  if (!row) return refreshUsageSnapshot(db)
  return {
    workspaceId: row.workspace_id,
    fileCount: row.file_count,
    photoCount: row.photo_count,
    storageBytes: row.storage_bytes,
    uploadCount: row.upload_count,
    uploadBytes: row.upload_bytes,
    quotaFiles: row.quota_files,
    quotaStorageBytes: row.quota_storage_bytes,
    updatedAt: row.updated_at,
  }
}

export async function refreshUsageSnapshot(db: D1Database): Promise<UsageSnapshot> {
  const [assetCounts, storageCounts, previous] = await Promise.all([
    db.prepare(`SELECT
      SUM(CASE WHEN status != 'trashed' AND media_type != 'photo' THEN 1 ELSE 0 END) AS file_count,
      SUM(CASE WHEN status != 'trashed' AND media_type = 'photo' THEN 1 ELSE 0 END) AS photo_count,
      COUNT(*) AS upload_count,
      COALESCE(SUM(size_bytes), 0) AS upload_bytes
      FROM assets WHERE workspace_id = ?`).bind(PERSONAL_WORKSPACE_ID).first<{
        file_count: number | null
        photo_count: number | null
        upload_count: number
        upload_bytes: number
      }>(),
    db.prepare(`SELECT COALESCE(SUM(size_bytes), 0) AS storage_bytes
      FROM storage_objects WHERE workspace_id = ? AND delete_state != 'deleted'`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ storage_bytes: number }>(),
    db.prepare(`SELECT quota_files, quota_storage_bytes FROM usage_snapshots WHERE workspace_id = ?`)
      .bind(PERSONAL_WORKSPACE_ID).first<{ quota_files: number | null; quota_storage_bytes: number | null }>(),
  ])
  const now = new Date().toISOString()
  const snapshot: UsageSnapshot = {
    workspaceId: PERSONAL_WORKSPACE_ID,
    fileCount: Number(assetCounts?.file_count ?? 0),
    photoCount: Number(assetCounts?.photo_count ?? 0),
    storageBytes: Number(storageCounts?.storage_bytes ?? 0),
    uploadCount: Number(assetCounts?.upload_count ?? 0),
    uploadBytes: Number(assetCounts?.upload_bytes ?? 0),
    quotaFiles: previous?.quota_files ?? null,
    quotaStorageBytes: previous?.quota_storage_bytes ?? null,
    updatedAt: now,
  }
  await db.prepare(`INSERT INTO usage_snapshots (
      workspace_id, file_count, photo_count, storage_bytes, upload_count, upload_bytes,
      quota_files, quota_storage_bytes, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      file_count = excluded.file_count,
      photo_count = excluded.photo_count,
      storage_bytes = excluded.storage_bytes,
      upload_count = excluded.upload_count,
      upload_bytes = excluded.upload_bytes,
      updated_at = excluded.updated_at`)
    .bind(
      snapshot.workspaceId, snapshot.fileCount, snapshot.photoCount, snapshot.storageBytes, snapshot.uploadCount,
      snapshot.uploadBytes, snapshot.quotaFiles, snapshot.quotaStorageBytes, snapshot.updatedAt,
    ).run()
  return snapshot
}
