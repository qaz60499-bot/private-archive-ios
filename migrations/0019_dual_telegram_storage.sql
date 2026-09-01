PRAGMA foreign_keys = ON;

-- Dual Telegram storage backend. Existing rows remain Bot-backed; new writes default
-- to the Telegram user-group bridge at the application layer.
ALTER TABLE assets ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'telegram_bot'
  CHECK (storage_backend IN ('telegram_user_group', 'telegram_bot'));
ALTER TABLE assets ADD COLUMN telegram_media_id TEXT;
ALTER TABLE assets ADD COLUMN import_origin TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE storage_objects ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'telegram_bot'
  CHECK (storage_backend IN ('telegram_user_group', 'telegram_bot'));
ALTER TABLE storage_objects ADD COLUMN telegram_media_id TEXT;
ALTER TABLE storage_objects ADD COLUMN import_origin TEXT NOT NULL DEFAULT 'legacy';

ALTER TABLE asset_versions ADD COLUMN storage_backend TEXT NOT NULL DEFAULT 'telegram_bot'
  CHECK (storage_backend IN ('telegram_user_group', 'telegram_bot'));

UPDATE assets SET storage_backend = 'telegram_bot' WHERE storage_backend IS NULL OR storage_backend = '';
UPDATE storage_objects SET storage_backend = 'telegram_bot' WHERE storage_backend IS NULL OR storage_backend = '';
UPDATE assets SET import_origin = CASE WHEN source = 'telegram' THEN 'telegram_bot' ELSE 'web' END
  WHERE import_origin = 'legacy';
UPDATE storage_objects SET import_origin = 'telegram_bot' WHERE import_origin = 'legacy';

-- MTProto chat/message is the durable identity for User Group imports. The partial
-- unique index makes listener replay, catch-up replay and Worker retries idempotent.
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_user_group_message
  ON storage_objects(workspace_id, storage_backend, storage_chat_id, storage_message_id)
  WHERE storage_backend = 'telegram_user_group' AND storage_chat_id IS NOT NULL AND storage_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_assets_storage_backend_taken
  ON assets(workspace_id, storage_backend, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_storage_objects_backend_created
  ON storage_objects(workspace_id, storage_backend, created_at DESC);

INSERT OR IGNORE INTO app_settings (key, value, updated_at)
VALUES ('default_storage_backend', 'telegram_user_group', datetime('now'));

CREATE TABLE IF NOT EXISTS telegram_user_group_runtime (
  workspace_id TEXT PRIMARY KEY,
  storage_chat_id TEXT,
  storage_chat_title TEXT,
  connection_status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (connection_status IN ('disconnected', 'auth_required', 'connected', 'syncing', 'error')),
  last_sync_at TEXT,
  last_error TEXT,
  last_ack_message_id INTEGER,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO telegram_user_group_runtime (workspace_id, connection_status, updated_at)
VALUES ('personal', 'disconnected', datetime('now'));
