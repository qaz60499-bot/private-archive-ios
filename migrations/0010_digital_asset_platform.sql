PRAGMA foreign_keys = ON;

-- Personal workspace boundary. The current product remains single-owner; this is the
-- smallest schema boundary that allows a future company workspace without a rewrite.
CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'personal' CHECK (kind IN ('personal', 'company')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO workspaces (id, name, kind, created_at, updated_at)
VALUES ('personal', 'Personal Workspace', 'personal', datetime('now'), datetime('now'));

-- Physical Telegram objects are separate from logical assets. Existing denormalized
-- Telegram columns stay on assets for forward/backward compatibility during rollout.
CREATE TABLE IF NOT EXISTS storage_objects (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  storage_provider TEXT NOT NULL DEFAULT 'telegram',
  storage_chat_id TEXT,
  storage_message_id INTEGER,
  storage_file_id TEXT,
  storage_file_unique_id TEXT,
  preview_message_id INTEGER,
  preview_file_id TEXT,
  telegram_url TEXT,
  content_hash TEXT,
  size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
  mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  delete_state TEXT NOT NULL DEFAULT 'active' CHECK (delete_state IN ('active', 'deleting', 'delete_failed', 'deleted')),
  delete_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

DROP INDEX IF EXISTS idx_assets_active_content_hash;
CREATE INDEX IF NOT EXISTS idx_assets_content_hash ON assets(content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_file_unique
  ON storage_objects(workspace_id, storage_file_unique_id)
  WHERE storage_file_unique_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storage_objects_hash
  ON storage_objects(workspace_id, content_hash)
  WHERE content_hash IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_storage_objects_message
  ON storage_objects(workspace_id, storage_chat_id, storage_message_id);

ALTER TABLE assets ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal';
ALTER TABLE assets ADD COLUMN storage_object_id TEXT;
ALTER TABLE assets ADD COLUMN extension TEXT NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN file_category TEXT NOT NULL DEFAULT 'other';
ALTER TABLE assets ADD COLUMN metadata_json TEXT;
ALTER TABLE assets ADD COLUMN archived INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1));
ALTER TABLE assets ADD COLUMN archived_at TEXT;
ALTER TABLE assets ADD COLUMN pre_trash_status TEXT;
ALTER TABLE assets ADD COLUMN deleted_at TEXT;
ALTER TABLE assets ADD COLUMN purge_at TEXT;
ALTER TABLE assets ADD COLUMN purge_state TEXT NOT NULL DEFAULT 'active' CHECK (purge_state IN ('active', 'pending', 'delete_failed'));
ALTER TABLE assets ADD COLUMN purge_error TEXT;
ALTER TABLE assets ADD COLUMN logical_path TEXT NOT NULL DEFAULT '/';
ALTER TABLE assets ADD COLUMN last_viewed_at TEXT;

ALTER TABLE albums ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'personal';

-- Safe extension/category backfill for the common formats requested by the product.
UPDATE assets SET extension = CASE
  WHEN lower(original_name) LIKE '%.xlsx' THEN 'xlsx'
  WHEN lower(original_name) LIKE '%.xlsm' THEN 'xlsm'
  WHEN lower(original_name) LIKE '%.xls' THEN 'xls'
  WHEN lower(original_name) LIKE '%.csv' THEN 'csv'
  WHEN lower(original_name) LIKE '%.docx' THEN 'docx'
  WHEN lower(original_name) LIKE '%.doc' THEN 'doc'
  WHEN lower(original_name) LIKE '%.pdf' THEN 'pdf'
  WHEN lower(original_name) LIKE '%.txt' THEN 'txt'
  WHEN lower(original_name) LIKE '%.md' THEN 'md'
  WHEN lower(original_name) LIKE '%.zip' THEN 'zip'
  WHEN lower(original_name) LIKE '%.7z' THEN '7z'
  WHEN lower(original_name) LIKE '%.rar' THEN 'rar'
  WHEN lower(original_name) LIKE '%.tar.gz' THEN 'tar.gz'
  WHEN lower(original_name) LIKE '%.tgz' THEN 'tgz'
  WHEN lower(original_name) LIKE '%.tar' THEN 'tar'
  WHEN lower(original_name) LIKE '%.json' THEN 'json'
  WHEN lower(original_name) LIKE '%.xml' THEN 'xml'
  WHEN lower(original_name) LIKE '%.yaml' THEN 'yaml'
  WHEN lower(original_name) LIKE '%.yml' THEN 'yml'
  WHEN lower(original_name) LIKE '%.js' THEN 'js'
  WHEN lower(original_name) LIKE '%.ts' THEN 'ts'
  WHEN lower(original_name) LIKE '%.py' THEN 'py'
  WHEN lower(original_name) LIKE '%.mp3' THEN 'mp3'
  WHEN lower(original_name) LIKE '%.wav' THEN 'wav'
  WHEN lower(original_name) LIKE '%.m4a' THEN 'm4a'
  ELSE '' END
WHERE extension = '';

UPDATE assets SET file_category = CASE
  WHEN media_type = 'photo' OR mime_type LIKE 'image/%' THEN 'images'
  WHEN media_type = 'video' OR mime_type LIKE 'video/%' THEN 'video'
  WHEN mime_type LIKE 'audio/%' OR extension IN ('mp3','wav','m4a','flac','aac','ogg') THEN 'audio'
  WHEN extension IN ('xls','xlsx','xlsm','csv','ods') THEN 'spreadsheets'
  WHEN extension IN ('pdf','doc','docx','txt','md','rtf','odt') THEN 'documents'
  WHEN extension IN ('zip','7z','rar','tar','tar.gz','tgz','gz') THEN 'archives'
  WHEN extension IN ('json','xml','yaml','yml','js','ts','tsx','jsx','py','go','rs','java','c','cpp','h','css','html','sql') THEN 'code'
  ELSE 'other' END;

UPDATE assets
SET pre_trash_status = COALESCE(pre_trash_status, 'ready'),
    deleted_at = COALESCE(deleted_at, updated_at),
    purge_at = COALESCE(purge_at, datetime(updated_at, '+30 days'))
WHERE status = 'trashed';

-- One physical object per currently known Telegram file_unique_id. INSERT OR IGNORE
-- protects legacy duplicate rows without inventing a destructive merge.
INSERT OR IGNORE INTO storage_objects (
  id, workspace_id, storage_provider, storage_chat_id, storage_message_id, storage_file_id,
  storage_file_unique_id, preview_message_id, preview_file_id, telegram_url, content_hash,
  size_bytes, mime_type, created_at, updated_at
)
SELECT 'obj-' || id, workspace_id, storage_provider, storage_chat_id, storage_message_id,
  storage_file_id, storage_file_unique_id, preview_message_id, preview_file_id, telegram_url,
  content_hash, size_bytes, mime_type, created_at, updated_at
FROM assets
WHERE storage_file_id IS NOT NULL;

UPDATE assets
SET storage_object_id = (
  SELECT storage_objects.id FROM storage_objects
  WHERE storage_objects.workspace_id = assets.workspace_id
    AND storage_objects.storage_file_unique_id = assets.storage_file_unique_id
  LIMIT 1
)
WHERE storage_object_id IS NULL AND storage_file_unique_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_assets_workspace_taken ON assets(workspace_id, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_status_taken ON assets(workspace_id, status, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_category_taken ON assets(workspace_id, file_category, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_extension_taken ON assets(workspace_id, extension, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_mime_taken ON assets(workspace_id, mime_type, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_favorite_taken ON assets(workspace_id, favorite, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_archive_taken ON assets(workspace_id, archived, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_deleted ON assets(workspace_id, deleted_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_purge ON assets(workspace_id, purge_at);
CREATE INDEX IF NOT EXISTS idx_assets_workspace_path_taken ON assets(workspace_id, logical_path, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_assets_storage_object ON assets(storage_object_id);
CREATE INDEX IF NOT EXISTS idx_albums_workspace_updated ON albums(workspace_id, updated_at DESC);

-- Lightweight activity log: personal "recent activity" now, audit-ready later.
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  action TEXT NOT NULL,
  asset_id TEXT,
  album_id TEXT,
  detail_json TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_workspace_created ON activity_log(workspace_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_activity_asset_created ON activity_log(asset_id, created_at DESC);

-- Low-cost usage/quota snapshot. It is refreshed transactionally by application code;
-- quota columns are nullable so public-plan limits can be added later without Billing.
CREATE TABLE IF NOT EXISTS usage_snapshots (
  workspace_id TEXT PRIMARY KEY,
  file_count INTEGER NOT NULL DEFAULT 0,
  photo_count INTEGER NOT NULL DEFAULT 0,
  storage_bytes INTEGER NOT NULL DEFAULT 0,
  upload_count INTEGER NOT NULL DEFAULT 0,
  upload_bytes INTEGER NOT NULL DEFAULT 0,
  quota_files INTEGER,
  quota_storage_bytes INTEGER,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO usage_snapshots (
  workspace_id, file_count, photo_count, storage_bytes, upload_count, upload_bytes, quota_files, quota_storage_bytes, updated_at
)
SELECT 'personal',
  SUM(CASE WHEN status != 'trashed' AND media_type != 'photo' THEN 1 ELSE 0 END),
  SUM(CASE WHEN status != 'trashed' AND media_type = 'photo' THEN 1 ELSE 0 END),
  COALESCE((SELECT SUM(size_bytes) FROM storage_objects WHERE workspace_id = 'personal' AND delete_state != 'deleted'), 0),
  COUNT(*),
  COALESCE(SUM(size_bytes), 0),
  NULL, NULL, datetime('now')
FROM assets WHERE workspace_id = 'personal';

-- Document versioning is schema-ready/service-ready. No photo version UI is introduced.
CREATE TABLE IF NOT EXISTS asset_versions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  logical_asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  storage_object_id TEXT NOT NULL,
  version_number INTEGER NOT NULL,
  original_name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  content_hash TEXT,
  created_at TEXT NOT NULL,
  UNIQUE(logical_asset_id, version_number)
);
CREATE INDEX IF NOT EXISTS idx_asset_versions_asset_version ON asset_versions(logical_asset_id, version_number DESC);

-- D1-native full-text index. This is not a second search service; it avoids repeated
-- leading-wildcard scans when metadata grows toward tens of thousands of rows.
CREATE VIRTUAL TABLE IF NOT EXISTS asset_search USING fts5(
  asset_id UNINDEXED,
  workspace_id UNINDEXED,
  search_text,
  tokenize='trigram'
);

INSERT INTO asset_search (asset_id, workspace_id, search_text)
SELECT assets.id, assets.workspace_id,
  trim(
    assets.original_name || ' ' || assets.extension || ' ' || assets.file_category || ' ' || assets.mime_type || ' ' ||
    COALESCE(assets.logical_path, '') || ' ' || COALESCE(assets.scene, '') || ' ' ||
    COALESCE((SELECT group_concat(tags.name, ' ') FROM asset_tags JOIN tags ON tags.id = asset_tags.tag_id WHERE asset_tags.asset_id = assets.id), '') || ' ' ||
    COALESCE((SELECT group_concat(albums.name, ' ') FROM album_assets JOIN albums ON albums.id = album_assets.album_id WHERE album_assets.asset_id = assets.id), '')
  )
FROM assets;

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('trash_retention_days', '30', datetime('now'));
