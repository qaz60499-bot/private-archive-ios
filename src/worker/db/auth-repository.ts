export async function cleanupAuth(db: D1Database): Promise<void> {
  const now = new Date().toISOString()
  const attemptsCutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  await db.batch([
    db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').bind(now),
    db.prepare('DELETE FROM auth_login_attempts WHERE attempted_at < ?').bind(attemptsCutoff),
  ])
}

export async function isLoginRateLimited(db: D1Database, ip: string, maxFailures = 5, windowMinutes = 15): Promise<boolean> {
  const cutoff = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString()
  const row = await db.prepare(`SELECT COUNT(*) AS failures FROM auth_login_attempts
    WHERE ip = ? AND success = 0 AND attempted_at >= ?`).bind(ip, cutoff).first<{ failures: number }>()
  return Number(row?.failures ?? 0) >= maxFailures
}

export async function recordLoginAttempt(db: D1Database, ip: string, success: boolean): Promise<void> {
  await db.prepare('INSERT INTO auth_login_attempts (ip, success, attempted_at) VALUES (?, ?, ?)')
    .bind(ip, success ? 1 : 0, new Date().toISOString()).run()
}

export async function clearLoginFailures(db: D1Database, ip: string): Promise<void> {
  await db.prepare('DELETE FROM auth_login_attempts WHERE ip = ? AND success = 0').bind(ip).run()
}

export async function createAuthSession(db: D1Database, tokenHash: string, expiresAt: string): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at)
    VALUES (?, ?, ?, ?)`)
    .bind(tokenHash, now, expiresAt, now).run()
}

export async function hasValidAuthSession(db: D1Database, tokenHash: string): Promise<boolean> {
  const row = await db.prepare('SELECT expires_at FROM auth_sessions WHERE token_hash = ?')
    .bind(tokenHash).first<{ expires_at: string }>()
  return Boolean(row && Date.parse(row.expires_at) > Date.now())
}

export async function deleteAuthSession(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(tokenHash).run()
}
