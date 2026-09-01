PRAGMA foreign_keys = ON;

-- Multi-Telegram Source + Scoped Access.
-- This migration is intentionally additive: no asset/storage row is deleted, no Telegram
-- identifier is rewritten, and the current production bot remains available as a legacy source.
CREATE TABLE IF NOT EXISTS telegram_sources (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  display_name TEXT NOT NULL,
  bot_user_id TEXT,
  bot_username TEXT,
  token_ciphertext TEXT,
  token_iv TEXT,
  webhook_secret_ciphertext TEXT,
  webhook_secret_iv TEXT,
  chat_id TEXT,
  chat_type TEXT,
  source_type TEXT CHECK (source_type IS NULL OR source_type IN ('private_chat', 'group', 'channel')),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  connection_status TEXT NOT NULL DEFAULT 'unconfigured' CHECK (connection_status IN ('unconfigured', 'legacy', 'verified', 'bound', 'disabled', 'error', 'disconnected')),
  last_sync_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_telegram_sources_workspace ON telegram_sources(workspace_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_sources_bot_user
  ON telegram_sources(workspace_id, bot_user_id) WHERE bot_user_id IS NOT NULL;

INSERT OR IGNORE INTO telegram_sources (
  id, workspace_id, display_name, source_type, enabled, connection_status, created_at, updated_at
) VALUES (
  'telegram-legacy', 'personal', 'Primary Telegram', NULL, 1, 'legacy', datetime('now'), datetime('now')
);

ALTER TABLE assets ADD COLUMN source_id TEXT;
ALTER TABLE storage_objects ADD COLUMN source_id TEXT;

UPDATE assets SET source_id = 'telegram-legacy' WHERE source_id IS NULL;
UPDATE storage_objects SET source_id = 'telegram-legacy' WHERE source_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_assets_workspace_source_taken
  ON assets(workspace_id, source_id, taken_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_storage_objects_workspace_source
  ON storage_objects(workspace_id, source_id, created_at DESC);

-- Telegram file_unique_id is not a safe cross-bot fetch credential. Keep physical
-- dedup within a source by default; logical assets may still share an object when the
-- application explicitly chooses a safe object.
DROP INDEX IF EXISTS idx_storage_objects_file_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_storage_objects_source_file_unique
  ON storage_objects(workspace_id, source_id, storage_file_unique_id)
  WHERE storage_file_unique_id IS NOT NULL;
DROP INDEX IF EXISTS idx_storage_objects_message;
CREATE INDEX IF NOT EXISTS idx_storage_objects_source_message
  ON storage_objects(workspace_id, source_id, storage_chat_id, storage_message_id);

-- Pending upload ownership also becomes source-aware so two configured destinations
-- can safely accept the same logical content without cross-wiring credentials.
DROP INDEX IF EXISTS idx_assets_pending_content_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_assets_pending_source_hash
  ON assets(workspace_id, source_id, content_hash)
  WHERE content_hash IS NOT NULL AND storage_object_id IS NULL AND status != 'trashed';

-- Source-aware Telegram update idempotency. The original telegram_updates table remains
-- untouched for rollback/legacy observability.
CREATE TABLE IF NOT EXISTS telegram_source_updates (
  source_id TEXT NOT NULL,
  update_id INTEGER NOT NULL,
  message_id INTEGER,
  processed_at TEXT NOT NULL,
  PRIMARY KEY(source_id, update_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_source_updates_processed
  ON telegram_source_updates(source_id, processed_at DESC);

CREATE TABLE IF NOT EXISTS telegram_source_discovered_chats (
  source_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  chat_type TEXT NOT NULL,
  title TEXT,
  username TEXT,
  first_name TEXT,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY(source_id, chat_id)
);
CREATE INDEX IF NOT EXISTS idx_telegram_source_discovered_chats_seen
  ON telegram_source_discovered_chats(source_id, last_seen_at DESC);

CREATE TABLE IF NOT EXISTS share_principals (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  display_name TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_principals_workspace
  ON share_principals(workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS share_links (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  principal_id TEXT NOT NULL REFERENCES share_principals(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT,
  revoked_at TEXT,
  last_used_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_share_links_principal ON share_links(principal_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_share_links_active ON share_links(workspace_id, revoked_at, expires_at);

CREATE TABLE IF NOT EXISTS access_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  principal_id TEXT NOT NULL REFERENCES share_principals(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('source', 'album', 'asset')),
  scope_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'download')),
  created_at TEXT NOT NULL,
  UNIQUE(principal_id, scope_type, scope_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_access_grants_principal ON access_grants(principal_id, permission, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_access_grants_scope ON access_grants(workspace_id, scope_type, scope_id, permission);

CREATE TABLE IF NOT EXISTS share_sessions (
  token_hash TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  link_id TEXT NOT NULL REFERENCES share_links(id) ON DELETE CASCADE,
  principal_id TEXT NOT NULL REFERENCES share_principals(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_used_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_share_sessions_principal ON share_sessions(principal_id, expires_at);
