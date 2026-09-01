ALTER TABLE storage_objects ADD COLUMN manifest_version INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_storage_objects_manifest ON storage_objects(workspace_id, manifest_version, created_at DESC);
