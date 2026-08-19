PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  storage_provider TEXT NOT NULL DEFAULT 'telegram',
  storage_chat_id TEXT,
  storage_message_id INTEGER,
  storage_file_id TEXT,
  storage_file_unique_id TEXT,
  preview_message_id INTEGER,
  preview_file_id TEXT,
  source TEXT NOT NULL CHECK (source IN ('web', 'telegram', 'mock')),
  media_type TEXT NOT NULL CHECK (media_type IN ('photo', 'video', 'file')),
  mime_type TEXT NOT NULL,
  original_name TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  width INTEGER,
  height INTEGER,
  duration_ms INTEGER,
  taken_at TEXT NOT NULL,
  uploaded_at TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  place_id TEXT REFERENCES places(id) ON DELETE SET NULL,
  primary_category TEXT,
  person_count INTEGER,
  scene TEXT,
  favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
  status TEXT NOT NULL CHECK (status IN ('pending_upload', 'stored', 'queued', 'analyzing', 'ready', 'limited', 'failed', 'trashed')),
  analysis_status TEXT NOT NULL DEFAULT 'pending' CHECK (analysis_status IN ('pending', 'queued', 'analyzing', 'ready', 'limited', 'failed', 'skipped')),
  telegram_url TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(storage_chat_id, storage_message_id),
  UNIQUE(storage_file_unique_id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'ai'
);

CREATE TABLE IF NOT EXISTS asset_tags (
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  confidence REAL,
  source TEXT NOT NULL,
  PRIMARY KEY(asset_id, tag_id)
);

CREATE TABLE IF NOT EXISTS places (
  id TEXT PRIMARY KEY,
  country TEXT,
  region TEXT,
  city TEXT,
  district TEXT,
  label TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  source TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS albums (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cover_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS album_assets (
  album_id TEXT NOT NULL REFERENCES albums(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  sort_order INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(album_id, asset_id)
);

CREATE TABLE IF NOT EXISTS people (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cover_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS upload_jobs (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
  upload_token_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS telegram_updates (
  update_id INTEGER PRIMARY KEY,
  message_id INTEGER,
  processed_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_assets_taken_at ON assets(taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_media_taken ON assets(media_type, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_category_taken ON assets(primary_category, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_place_taken ON assets(place_id, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_favorite_taken ON assets(favorite, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_assets_status_taken ON assets(status, taken_at DESC);
CREATE INDEX IF NOT EXISTS idx_asset_tags_tag_asset ON asset_tags(tag_id, asset_id);
CREATE INDEX IF NOT EXISTS idx_album_assets_album_sort ON album_assets(album_id, sort_order);
CREATE INDEX IF NOT EXISTS idx_upload_jobs_status ON upload_jobs(status, updated_at DESC);

