-- Recent views are product-level feeds, so they need their own ordered access paths
-- once the personal workspace grows to tens of thousands of metadata rows.
CREATE INDEX IF NOT EXISTS idx_assets_workspace_recent_added
ON assets(workspace_id, uploaded_at DESC, id DESC)
WHERE status != 'trashed';

CREATE INDEX IF NOT EXISTS idx_assets_workspace_recent_viewed
ON assets(workspace_id, last_viewed_at DESC, id DESC)
WHERE status != 'trashed' AND last_viewed_at IS NOT NULL;
