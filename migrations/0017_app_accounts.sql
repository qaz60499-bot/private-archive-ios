PRAGMA foreign_keys = ON;

-- Application accounts sit inside the existing personal workspace. Cloudflare Access
-- remains the outer perimeter; these accounts provide the desktop/web login, persistent
-- sessions, and account switching requested for the personal Photo SaaS.
CREATE TABLE IF NOT EXISTS app_users (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  username TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'MEMBER' CHECK (role IN ('OWNER', 'MEMBER')),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DISABLED')),
  last_login_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(workspace_id, username)
);
CREATE INDEX IF NOT EXISTS idx_app_users_workspace_status
  ON app_users(workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS app_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_sessions_user_expires
  ON app_sessions(user_id, expires_at DESC);
CREATE INDEX IF NOT EXISTS idx_app_sessions_expires
  ON app_sessions(expires_at);

CREATE TABLE IF NOT EXISTS app_login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ip TEXT NOT NULL,
  success INTEGER NOT NULL CHECK (success IN (0, 1)),
  attempted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_app_login_attempts_ip_time
  ON app_login_attempts(ip, attempted_at DESC);
