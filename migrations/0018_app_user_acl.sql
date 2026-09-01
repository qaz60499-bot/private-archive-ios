PRAGMA foreign_keys = ON;

-- Logged-in application accounts get their own Worker-enforced ACLs. Owner remains
-- an implicit superuser; MEMBER accounts are default-deny unless a grant matches.
CREATE TABLE IF NOT EXISTS app_user_grants (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL DEFAULT 'personal',
  user_id TEXT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('workspace', 'source', 'album', 'asset')),
  scope_id TEXT NOT NULL,
  permission TEXT NOT NULL CHECK (permission IN ('read', 'download', 'upload', 'edit', 'delete')),
  created_at TEXT NOT NULL,
  UNIQUE(user_id, scope_type, scope_id, permission)
);
CREATE INDEX IF NOT EXISTS idx_app_user_grants_user
  ON app_user_grants(user_id, permission, scope_type, scope_id);
CREATE INDEX IF NOT EXISTS idx_app_user_grants_scope
  ON app_user_grants(workspace_id, scope_type, scope_id, permission);

-- Preserve the behavior of MEMBER accounts that existed before account ACLs were
-- introduced. New accounts are created with an explicit preset by the application.
INSERT OR IGNORE INTO app_user_grants (id, workspace_id, user_id, scope_type, scope_id, permission, created_at)
SELECT lower(hex(randomblob(16))), workspace_id, id, 'workspace', workspace_id, 'read', datetime('now')
FROM app_users WHERE role = 'MEMBER';
INSERT OR IGNORE INTO app_user_grants (id, workspace_id, user_id, scope_type, scope_id, permission, created_at)
SELECT lower(hex(randomblob(16))), workspace_id, id, 'workspace', workspace_id, 'download', datetime('now')
FROM app_users WHERE role = 'MEMBER';
INSERT OR IGNORE INTO app_user_grants (id, workspace_id, user_id, scope_type, scope_id, permission, created_at)
SELECT lower(hex(randomblob(16))), workspace_id, id, 'workspace', workspace_id, 'upload', datetime('now')
FROM app_users WHERE role = 'MEMBER';
INSERT OR IGNORE INTO app_user_grants (id, workspace_id, user_id, scope_type, scope_id, permission, created_at)
SELECT lower(hex(randomblob(16))), workspace_id, id, 'workspace', workspace_id, 'edit', datetime('now')
FROM app_users WHERE role = 'MEMBER';
INSERT OR IGNORE INTO app_user_grants (id, workspace_id, user_id, scope_type, scope_id, permission, created_at)
SELECT lower(hex(randomblob(16))), workspace_id, id, 'workspace', workspace_id, 'delete', datetime('now')
FROM app_users WHERE role = 'MEMBER';
