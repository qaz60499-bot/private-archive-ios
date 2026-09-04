PRAGMA foreign_keys = ON;

-- Upload reserve/retry/content paths repeatedly fetch the newest job for one asset.
-- Without this composite index D1 scans a large part of upload_jobs for every lookup,
-- which amplifies row-read usage during iOS background batches.
CREATE INDEX IF NOT EXISTS idx_upload_jobs_asset_created
  ON upload_jobs(asset_id, created_at DESC, id);

-- Upload queue/status views sort by the most recent update without constraining
-- status. The older (status, updated_at) index cannot satisfy that ordering by
-- itself, which forces a full upload_jobs scan plus a temporary sort.
CREATE INDEX IF NOT EXISTS idx_upload_jobs_updated
  ON upload_jobs(updated_at DESC, id);

-- Deduplication first narrows by workspace/source/content hash, then validates the
-- selected storage backend/object state. Keep that first-stage candidate lookup
-- indexed so a large archive does not scan every historical asset per reservation.
CREATE INDEX IF NOT EXISTS idx_assets_workspace_source_hash_created
  ON assets(workspace_id, source_id, content_hash, created_at DESC)
  WHERE content_hash IS NOT NULL AND status != 'trashed';

-- Cross-representation photo deduplication (for example the same iPhone capture
-- materialized as HEIC in one build and JPEG in another) first narrows by capture
-- timestamp and pixel dimensions before checking the normalized filename stem. Keep
-- that narrow candidate set indexed so a large camera roll is not rescanned for each
-- reservation.
CREATE INDEX IF NOT EXISTS idx_assets_capture_identity_lookup
  ON assets(workspace_id, source_id, media_type, taken_at, width, height, created_at DESC)
  WHERE status != 'trashed';
