PRAGMA foreign_keys = ON;

CREATE INDEX IF NOT EXISTS idx_storage_objects_repair_lookup
  ON storage_objects(workspace_id, source_id, storage_backend, content_hash, size_bytes, mime_type, created_at DESC)
  WHERE content_hash IS NOT NULL AND delete_state = 'active';
