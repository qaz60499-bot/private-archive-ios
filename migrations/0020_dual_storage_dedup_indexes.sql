PRAGMA foreign_keys = ON;

-- Deduplication must respect the explicitly selected storage backend. Choosing the
-- User Group must never silently reuse a Bot-backed physical object (or vice versa).
DROP INDEX IF EXISTS idx_assets_pending_source_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_pending_backend_hash
  ON assets(workspace_id, source_id, storage_backend, content_hash)
  WHERE content_hash IS NOT NULL AND storage_object_id IS NULL AND status != 'trashed';

DROP INDEX IF EXISTS idx_storage_objects_source_file_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_backend_file_unique
  ON storage_objects(workspace_id, source_id, storage_backend, storage_file_unique_id)
  WHERE storage_file_unique_id IS NOT NULL;
