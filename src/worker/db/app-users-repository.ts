import { APP_SESSION_TTL_SECONDS, hashAppSessionToken } from '../lib/app-auth'
import { PERSONAL_WORKSPACE_ID } from './assets-repository'

export type AppUserRole = 'OWNER' | 'MEMBER'
export type AppUserStatus = 'ACTIVE' | 'DISABLED'

export interface AppUserRow {
  id: string
  workspace_id: string
  username: string
  display_name: string
  password_hash: string
  role: AppUserRole
  status: AppUserStatus
  last_login_at: string | null
  created_at: string
  updated_at: string
}

export interface PublicAppUser {
  id: string
  username: string
  displayName: string
  role: AppUserRole
  status: AppUserStatus
  lastLoginAt: string | null
  createdAt: string
}

export function toPublicAppUser(row: AppUserRow): PublicAppUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at,
  }
}

export async function appUsersInitialized(db: D1Database): Promise<boolean> {
  const row = await db.prepare('SELECT 1 AS present FROM app_users WHERE workspace_id = ? LIMIT 1')
    .bind(PERSONAL_WORKSPACE_ID).first<{ present: number }>()
  return Boolean(row)
}

export async function createAppUser(db: D1Database, input: {
  username: string
  displayName: string
  passwordHash: string
  role: AppUserRole
}): Promise<AppUserRow> {
  const now = new Date().toISOString()
  const id = crypto.randomUUID()
  await db.prepare(`INSERT INTO app_users (
    id, workspace_id, username, display_name, password_hash, role, status, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', ?, ?)`)
    .bind(id, PERSONAL_WORKSPACE_ID, input.username, input.displayName, input.passwordHash, input.role, now, now).run()
  const row = await getAppUserById(db, id)
  if (!row) throw new Error('APP_USER_CREATE_FAILED')
  return row
}

export async function getAppUserById(db: D1Database, id: string): Promise<AppUserRow | null> {
  return db.prepare(`SELECT id, workspace_id, username, display_name, password_hash, role, status,
    last_login_at, created_at, updated_at FROM app_users WHERE id = ? AND workspace_id = ? LIMIT 1`)
    .bind(id, PERSONAL_WORKSPACE_ID).first<AppUserRow>()
}

export async function getAppUserByUsername(db: D1Database, username: string): Promise<AppUserRow | null> {
  return db.prepare(`SELECT id, workspace_id, username, display_name, password_hash, role, status,
    last_login_at, created_at, updated_at FROM app_users
    WHERE workspace_id = ? AND username = ? COLLATE NOCASE LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, username).first<AppUserRow>()
}

export async function getActiveAppOwner(db: D1Database): Promise<AppUserRow | null> {
  return db.prepare(`SELECT id, workspace_id, username, display_name, password_hash, role, status,
    last_login_at, created_at, updated_at FROM app_users
    WHERE workspace_id = ? AND role = 'OWNER' AND status = 'ACTIVE'
    ORDER BY created_at ASC LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID).first<AppUserRow>()
}

export async function listAppUsers(db: D1Database): Promise<PublicAppUser[]> {
  const rows = await db.prepare(`SELECT id, workspace_id, username, display_name, password_hash, role, status,
    last_login_at, created_at, updated_at FROM app_users WHERE workspace_id = ?
    ORDER BY CASE role WHEN 'OWNER' THEN 0 ELSE 1 END, created_at ASC`)
    .bind(PERSONAL_WORKSPACE_ID).all<AppUserRow>()
  return rows.results.map(toPublicAppUser)
}

export async function updateAppUser(db: D1Database, id: string, input: {
  displayName?: string
  passwordHash?: string
  status?: AppUserStatus
}): Promise<AppUserRow | null> {
  const assignments: string[] = []
  const values: unknown[] = []
  if (input.displayName !== undefined) {
    assignments.push('display_name = ?')
    values.push(input.displayName)
  }
  if (input.passwordHash !== undefined) {
    assignments.push('password_hash = ?')
    values.push(input.passwordHash)
  }
  if (input.status !== undefined) {
    assignments.push('status = ?')
    values.push(input.status)
  }
  if (!assignments.length) return getAppUserById(db, id)
  assignments.push('updated_at = ?')
  values.push(new Date().toISOString(), id, PERSONAL_WORKSPACE_ID)
  const update = db.prepare(`UPDATE app_users SET ${assignments.join(', ')} WHERE id = ? AND workspace_id = ?`).bind(...values)
  if (input.status === 'DISABLED' || input.passwordHash !== undefined) {
    // Password/status changes and legacy D1-session invalidation are one transaction.
    // A quota/network failure must not commit a new credential while leaving old
    // database sessions valid (or report failure after the credential already changed).
    await db.batch([
      update,
      db.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(id),
    ])
  } else {
    await update.run()
  }
  return getAppUserById(db, id)
}

export async function resetAllAppUserPasswords(db: D1Database, updates: Array<{ id: string; passwordHash: string }>): Promise<number> {
  if (!updates.length) return 0
  const now = new Date().toISOString()
  const statements = updates.map(({ id, passwordHash }) => db.prepare(`UPDATE app_users
    SET password_hash = ?, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(passwordHash, now, id, PERSONAL_WORKSPACE_ID))
  await db.batch([
    ...statements,
    db.prepare('DELETE FROM app_sessions WHERE workspace_id = ?').bind(PERSONAL_WORKSPACE_ID),
  ])
  return updates.length
}

export async function createAppSession(db: D1Database, userId: string, rawToken: string): Promise<string> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + APP_SESSION_TTL_SECONDS * 1000).toISOString()
  const tokenHash = await hashAppSessionToken(rawToken)
  await db.batch([
    db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').bind(now.toISOString()),
    db.prepare(`INSERT INTO app_sessions (token_hash, user_id, workspace_id, expires_at, created_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(tokenHash, userId, PERSONAL_WORKSPACE_ID, expiresAt, now.toISOString(), now.toISOString()),
    db.prepare('UPDATE app_users SET last_login_at = ?, updated_at = ? WHERE id = ? AND workspace_id = ?')
      .bind(now.toISOString(), now.toISOString(), userId, PERSONAL_WORKSPACE_ID),
  ])
  return expiresAt
}

export async function refreshAppSession(db: D1Database, userId: string, rawToken: string): Promise<boolean> {
  const now = new Date()
  const expiresAt = new Date(now.getTime() + APP_SESSION_TTL_SECONDS * 1000).toISOString()
  const tokenHash = await hashAppSessionToken(rawToken)
  const result = await db.prepare(`UPDATE app_sessions SET expires_at = ?, last_seen_at = ?
    WHERE token_hash = ? AND user_id = ? AND workspace_id = ?`)
    .bind(expiresAt, now.toISOString(), tokenHash, userId, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function resolveAppSession(db: D1Database, rawToken: string): Promise<AppUserRow | null> {
  const tokenHash = await hashAppSessionToken(rawToken)
  const now = new Date().toISOString()
  // Legacy D1 sessions are intentionally read-only. Updating last_seen_at on every
  // authenticated request made session validation depend on the D1 daily write
  // quota, so a quota exhaustion could log out every client. New sessions live in
  // the auth Durable Object; D1 sessions remain readable until they expire.
  return db.prepare(`SELECT users.id, users.workspace_id, users.username, users.display_name,
      users.password_hash, users.role, users.status, users.last_login_at, users.created_at, users.updated_at
    FROM app_sessions sessions JOIN app_users users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ? AND sessions.workspace_id = ? AND sessions.expires_at > ?
      AND users.status = 'ACTIVE' LIMIT 1`)
    .bind(tokenHash, PERSONAL_WORKSPACE_ID, now).first<AppUserRow>()
}

export async function deleteAppSession(db: D1Database, rawToken: string): Promise<void> {
  const tokenHash = await hashAppSessionToken(rawToken)
  await db.prepare('DELETE FROM app_sessions WHERE token_hash = ?').bind(tokenHash).run()
}

export async function deleteAppSessionsForUser(db: D1Database, userId: string): Promise<void> {
  await db.prepare('DELETE FROM app_sessions WHERE user_id = ?').bind(userId).run()
}

export async function pruneAppAuth(db: D1Database): Promise<void> {
  const now = new Date()
  const cutoff = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()
  await db.batch([
    db.prepare('DELETE FROM app_sessions WHERE expires_at <= ?').bind(now.toISOString()),
    db.prepare('DELETE FROM app_login_attempts WHERE attempted_at < ?').bind(cutoff),
  ])
}

function accountLoginAttemptKey(username: string): string {
  return `account:${username.trim().toLowerCase()}`
}

async function recentLoginFailuresForKey(db: D1Database, key: string, windowMinutes = 15): Promise<number> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  const row = await db.prepare(`SELECT COUNT(*) AS failures FROM app_login_attempts
    WHERE ip = ? AND success = 0 AND attempted_at >= ?`).bind(key, cutoff).first<{ failures: number }>()
  return Number(row?.failures ?? 0)
}

export async function recentLoginFailures(db: D1Database, ip: string, windowMinutes = 15): Promise<number> {
  return recentLoginFailuresForKey(db, ip, windowMinutes)
}

export async function recentAccountLoginFailures(db: D1Database, username: string, windowMinutes = 15): Promise<number> {
  return recentLoginFailuresForKey(db, accountLoginAttemptKey(username), windowMinutes)
}

export async function recordLoginAttempt(db: D1Database, ip: string, username: string, success: boolean): Promise<void> {
  const attemptedAt = new Date().toISOString()
  const successFlag = success ? 1 : 0
  await db.batch([
    db.prepare('INSERT INTO app_login_attempts (ip, success, attempted_at) VALUES (?, ?, ?)').bind(ip, successFlag, attemptedAt),
    db.prepare('INSERT INTO app_login_attempts (ip, success, attempted_at) VALUES (?, ?, ?)').bind(accountLoginAttemptKey(username), successFlag, attemptedAt),
  ])
}

export async function clearLoginFailures(db: D1Database, ip: string, username: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM app_login_attempts WHERE ip = ? AND success = 0').bind(ip),
    db.prepare('DELETE FROM app_login_attempts WHERE ip = ? AND success = 0').bind(accountLoginAttemptKey(username)),
  ])
}
