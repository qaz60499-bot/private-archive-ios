import { PERSONAL_WORKSPACE_ID } from './assets-repository'
import { createSecretToken } from '../lib/source-secrets'
import { hashToken } from '../lib/crypto'

export type ShareScopeType = 'source' | 'album' | 'asset'
export type SharePermission = 'read' | 'download'

export interface SharePrincipal {
  id: string
  displayName: string
}

export interface ShareSessionPrincipal extends SharePrincipal {
  linkId: string
  expiresAt: string
}

export interface PublicShareLink {
  id: string
  name: string
  scopeType: ShareScopeType
  scopeId: string
  permissions: SharePermission[]
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
}

function expiresAtFromDays(days: number | null): string | null {
  if (days === null) return null
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

async function assertScopeExists(db: D1Database, scopeType: ShareScopeType, scopeId: string): Promise<void> {
  const sql = scopeType === 'source'
    ? `SELECT 1 AS found FROM telegram_sources WHERE id = ? AND workspace_id = ?`
    : scopeType === 'album'
      ? `SELECT 1 AS found FROM albums WHERE id = ? AND workspace_id = ?`
      : `SELECT 1 AS found FROM assets WHERE id = ? AND workspace_id = ? AND status != 'trashed'`
  const row = await db.prepare(sql).bind(scopeId, PERSONAL_WORKSPACE_ID).first<{ found: number }>()
  if (!row) throw new Error('SHARE_SCOPE_NOT_FOUND')
}

export async function createShareLink(db: D1Database, input: {
  name: string
  scopeType: ShareScopeType
  scopeId: string
  allowDownload: boolean
  expiresInDays: 1 | 7 | 30 | null
}): Promise<{ item: PublicShareLink; token: string }> {
  await assertScopeExists(db, input.scopeType, input.scopeId)
  const now = new Date().toISOString()
  const principalId = crypto.randomUUID()
  const linkId = crypto.randomUUID()
  const rawToken = createSecretToken(32)
  const tokenHash = await hashToken(rawToken)
  const expiresAt = expiresAtFromDays(input.expiresInDays)
  const grants = [
    db.prepare(`INSERT INTO access_grants (id, workspace_id, principal_id, scope_type, scope_id, permission, created_at)
      VALUES (?, ?, ?, ?, ?, 'read', ?)`)
      .bind(crypto.randomUUID(), PERSONAL_WORKSPACE_ID, principalId, input.scopeType, input.scopeId, now),
  ]
  if (input.allowDownload) {
    grants.push(db.prepare(`INSERT INTO access_grants (id, workspace_id, principal_id, scope_type, scope_id, permission, created_at)
      VALUES (?, ?, ?, ?, ?, 'download', ?)`)
      .bind(crypto.randomUUID(), PERSONAL_WORKSPACE_ID, principalId, input.scopeType, input.scopeId, now))
  }
  await db.batch([
    db.prepare(`INSERT INTO share_principals (id, workspace_id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(principalId, PERSONAL_WORKSPACE_ID, input.name, now, now),
    db.prepare(`INSERT INTO share_links (id, workspace_id, principal_id, token_hash, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(linkId, PERSONAL_WORKSPACE_ID, principalId, tokenHash, expiresAt, now, now),
    ...grants,
  ])
  return {
    token: rawToken,
    item: {
      id: linkId,
      name: input.name,
      scopeType: input.scopeType,
      scopeId: input.scopeId,
      permissions: input.allowDownload ? ['read', 'download'] : ['read'],
      createdAt: now,
      expiresAt,
      lastUsedAt: null,
      revoked: false,
    },
  }
}

export async function listShareLinks(db: D1Database): Promise<PublicShareLink[]> {
  const rows = await db.prepare(`SELECT links.id, principals.display_name, links.created_at, links.expires_at, links.last_used_at,
      links.revoked_at,
      MAX(CASE WHEN grants.permission = 'download' THEN 1 ELSE 0 END) AS can_download,
      MIN(grants.scope_type) AS scope_type,
      MIN(grants.scope_id) AS scope_id
    FROM share_links links
    JOIN share_principals principals ON principals.id = links.principal_id
    JOIN access_grants grants ON grants.principal_id = principals.id
    WHERE links.workspace_id = ?
    GROUP BY links.id, principals.display_name, links.created_at, links.expires_at, links.last_used_at, links.revoked_at
    ORDER BY links.created_at DESC`)
    .bind(PERSONAL_WORKSPACE_ID).all<{
      id: string; display_name: string; created_at: string; expires_at: string | null; last_used_at: string | null;
      revoked_at: string | null; can_download: number; scope_type: ShareScopeType; scope_id: string
    }>()
  return rows.results.map((row) => ({
    id: row.id,
    name: row.display_name,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    permissions: row.can_download ? ['read', 'download'] : ['read'],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revoked: Boolean(row.revoked_at),
  }))
}

export async function revokeShareLink(db: D1Database, linkId: string): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE share_links SET revoked_at = COALESCE(revoked_at, ?), updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(now, now, linkId, PERSONAL_WORKSPACE_ID).run()
  if (result.meta.changes > 0) await db.prepare(`DELETE FROM share_sessions WHERE link_id = ?`).bind(linkId).run()
  return result.meta.changes > 0
}

export async function rotateShareLink(db: D1Database, linkId: string): Promise<{ token: string } | null> {
  const rawToken = createSecretToken(32)
  const tokenHash = await hashToken(rawToken)
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE share_links SET token_hash = ?, revoked_at = NULL, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(tokenHash, now, linkId, PERSONAL_WORKSPACE_ID).run()
  if (result.meta.changes === 0) return null
  await db.prepare(`DELETE FROM share_sessions WHERE link_id = ?`).bind(linkId).run()
  return { token: rawToken }
}

export async function exchangeShareToken(db: D1Database, rawToken: string): Promise<{ sessionToken: string; principal: ShareSessionPrincipal } | null> {
  const tokenHash = await hashToken(rawToken)
  const now = new Date().toISOString()
  const link = await db.prepare(`SELECT links.id AS link_id, links.principal_id, links.expires_at, principals.display_name
    FROM share_links links JOIN share_principals principals ON principals.id = links.principal_id
    WHERE links.workspace_id = ? AND links.token_hash = ? AND links.revoked_at IS NULL AND principals.revoked_at IS NULL
      AND (links.expires_at IS NULL OR links.expires_at > ?) LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, tokenHash, now).first<{ link_id: string; principal_id: string; expires_at: string | null; display_name: string }>()
  if (!link) return null
  const sessionToken = createSecretToken(32)
  const sessionHash = await hashToken(sessionToken)
  const twelveHours = Date.now() + 12 * 60 * 60 * 1000
  const sessionExpiry = new Date(link.expires_at ? Math.min(Date.parse(link.expires_at), twelveHours) : twelveHours).toISOString()
  await db.batch([
    db.prepare(`INSERT INTO share_sessions (token_hash, workspace_id, link_id, principal_id, expires_at, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(sessionHash, PERSONAL_WORKSPACE_ID, link.link_id, link.principal_id, sessionExpiry, now, now),
    db.prepare(`UPDATE share_links SET last_used_at = ?, updated_at = ? WHERE id = ?`).bind(now, now, link.link_id),
  ])
  return {
    sessionToken,
    principal: { id: link.principal_id, displayName: link.display_name, linkId: link.link_id, expiresAt: sessionExpiry },
  }
}

export async function deleteShareSession(db: D1Database, sessionToken: string): Promise<void> {
  const tokenHash = await hashToken(sessionToken)
  await db.prepare(`DELETE FROM share_sessions WHERE workspace_id = ? AND token_hash = ?`)
    .bind(PERSONAL_WORKSPACE_ID, tokenHash).run()
}

export async function resolveShareSession(db: D1Database, sessionToken: string): Promise<ShareSessionPrincipal | null> {
  const tokenHash = await hashToken(sessionToken)
  const now = new Date().toISOString()
  const row = await db.prepare(`SELECT sessions.principal_id, sessions.link_id, sessions.expires_at, principals.display_name
    FROM share_sessions sessions
    JOIN share_links links ON links.id = sessions.link_id
    JOIN share_principals principals ON principals.id = sessions.principal_id
    WHERE sessions.workspace_id = ? AND sessions.token_hash = ? AND sessions.expires_at > ?
      AND links.revoked_at IS NULL AND principals.revoked_at IS NULL
      AND (links.expires_at IS NULL OR links.expires_at > ?) LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, tokenHash, now, now)
    .first<{ principal_id: string; link_id: string; expires_at: string; display_name: string }>()
  if (!row) return null
  await db.prepare(`UPDATE share_sessions SET last_used_at = ? WHERE token_hash = ?`).bind(now, tokenHash).run()
  return { id: row.principal_id, displayName: row.display_name, linkId: row.link_id, expiresAt: row.expires_at }
}

export async function canPrincipalAccessAsset(db: D1Database, principalId: string, assetId: string, permission: SharePermission): Promise<boolean> {
  const row = await db.prepare(`SELECT 1 AS allowed FROM assets
    WHERE assets.id = ? AND assets.workspace_id = ? AND assets.status != 'trashed'
      AND EXISTS (
        SELECT 1 FROM access_grants grants
        WHERE grants.workspace_id = assets.workspace_id AND grants.principal_id = ? AND grants.permission = ?
          AND (
            (grants.scope_type = 'source' AND grants.scope_id = assets.source_id)
            OR (grants.scope_type = 'asset' AND grants.scope_id = assets.id)
            OR (grants.scope_type = 'album' AND EXISTS (
              SELECT 1 FROM album_assets WHERE album_assets.album_id = grants.scope_id AND album_assets.asset_id = assets.id
            ))
          )
      ) LIMIT 1`)
    .bind(assetId, PERSONAL_WORKSPACE_ID, principalId, permission).first<{ allowed: number }>()
  return Boolean(row)
}

export async function listAccessibleAlbumIds(db: D1Database, principalId: string): Promise<string[]> {
  const rows = await db.prepare(`SELECT DISTINCT albums.id
    FROM albums
    JOIN album_assets ON album_assets.album_id = albums.id
    JOIN assets ON assets.id = album_assets.asset_id
    WHERE albums.workspace_id = ? AND assets.status != 'trashed' AND EXISTS (
      SELECT 1 FROM access_grants grants WHERE grants.principal_id = ? AND grants.permission = 'read'
        AND (
          (grants.scope_type = 'album' AND grants.scope_id = albums.id)
          OR (grants.scope_type = 'asset' AND grants.scope_id = assets.id)
          OR (grants.scope_type = 'source' AND grants.scope_id = assets.source_id)
        )
    )`).bind(PERSONAL_WORKSPACE_ID, principalId).all<{ id: string }>()
  return rows.results.map((row) => row.id)
}
