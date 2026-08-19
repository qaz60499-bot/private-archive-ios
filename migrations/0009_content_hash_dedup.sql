ALTER TABLE assets ADD COLUMN content_hash TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_active_content_hash
ON assets(content_hash)
WHERE content_hash IS NOT NULL AND status != 'trashed';
