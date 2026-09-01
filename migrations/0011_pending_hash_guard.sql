-- Allow many logical assets to reference one stored binary, while ensuring only one
-- not-yet-stored upload owns a SHA-256 at a time. This preserves retry idempotency
-- without reintroducing the old logical-asset uniqueness bug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_pending_content_hash
ON assets(workspace_id, content_hash)
WHERE content_hash IS NOT NULL AND storage_object_id IS NULL AND status != 'trashed';
