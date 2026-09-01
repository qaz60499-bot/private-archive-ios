import type { AppUserRow } from './app-users-repository'

const PERSONAL_WORKSPACE_ID = 'personal'

export type AppUserPermission = 'read' | 'download' | 'upload' | 'edit' | 'delete'
export type AppUserScopeType = 'workspace' | 'source' | 'album' | 'asset'
export type AppUserAccessPreset = 'FULL' | 'VIEWER' | 'UPLOAD_ONLY' | 'SCOPED' | 'CUSTOM'

export interface AppUserGrant {
  scopeType: AppUserScopeType
  scopeId: string
  permission: AppUserPermission
}

const FULL_PERMISSIONS: AppUserPermission[] = ['read', 'download', 'upload', 'edit', 'delete']

function uniqueGrants(grants: AppUserGrant[]): AppUserGrant[] {
  const seen = new Set<string>()
  const result: AppUserGrant[] = []
  for (const grant of grants) {
    const key = `${grant.scopeType}\u0000${grant.scopeId}\u0000${grant.permission}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(grant)
  }
  return result
}

export function grantsForPreset(preset: Exclude<AppUserAccessPreset, 'SCOPED' | 'CUSTOM'>): AppUserGrant[] {
  if (preset === 'FULL') return FULL_PERMISSIONS.map((permission) => ({ scopeType: 'workspace', scopeId: PERSONAL_WORKSPACE_ID, permission }))
  if (preset === 'VIEWER') return [{ scopeType: 'workspace', scopeId: PERSONAL_WORKSPACE_ID, permission: 'read' }]
  return [{ scopeType: 'workspace', scopeId: PERSONAL_WORKSPACE_ID, permission: 'upload' }]
}

export function deriveAccessPreset(grants: AppUserGrant[]): AppUserAccessPreset {
  const normalized = uniqueGrants(grants)
  const workspace = new Set(normalized.filter((grant) => grant.scopeType === 'workspace' && grant.scopeId === PERSONAL_WORKSPACE_ID).map((grant) => grant.permission))
  const nonWorkspace = normalized.some((grant) => grant.scopeType !== 'workspace')
  if (!nonWorkspace && FULL_PERMISSIONS.every((permission) => workspace.has(permission)) && workspace.size === FULL_PERMISSIONS.length) return 'FULL'
  if (!nonWorkspace && workspace.size === 1 && workspace.has('read')) return 'VIEWER'
  if (!nonWorkspace && workspace.size === 1 && workspace.has('upload')) return 'UPLOAD_ONLY'
  if (!workspace.has('read') && nonWorkspace) return 'SCOPED'
  return 'CUSTOM'
}

export async function listAppUserGrants(db: D1Database, userId: string): Promise<AppUserGrant[]> {
  const rows = await db.prepare(`SELECT scope_type, scope_id, permission FROM app_user_grants
    WHERE workspace_id = ? AND user_id = ?
    ORDER BY CASE scope_type WHEN 'workspace' THEN 0 WHEN 'source' THEN 1 WHEN 'album' THEN 2 ELSE 3 END,
      scope_id, permission`)
    .bind(PERSONAL_WORKSPACE_ID, userId)
    .all<{ scope_type: AppUserScopeType; scope_id: string; permission: AppUserPermission }>()
  return rows.results.map((row) => ({ scopeType: row.scope_type, scopeId: row.scope_id, permission: row.permission }))
}

export async function validateAppUserGrants(db: D1Database, grants: AppUserGrant[]): Promise<AppUserGrant[]> {
  if (grants.length > 100) throw new Error('APP_ACCESS_TOO_MANY_GRANTS')
  const normalized = uniqueGrants(grants)
  for (const grant of normalized) {
    if (!['workspace', 'source', 'album', 'asset'].includes(grant.scopeType)) throw new Error('APP_ACCESS_SCOPE_INVALID')
    if (!['read', 'download', 'upload', 'edit', 'delete'].includes(grant.permission)) throw new Error('APP_ACCESS_PERMISSION_INVALID')
    if (!grant.scopeId || grant.scopeId.length > 160) throw new Error('APP_ACCESS_SCOPE_INVALID')
    if (grant.permission === 'upload' && !['workspace', 'source'].includes(grant.scopeType)) throw new Error('APP_ACCESS_UPLOAD_SCOPE_INVALID')
    if (grant.scopeType === 'workspace') {
      if (grant.scopeId !== PERSONAL_WORKSPACE_ID) throw new Error('APP_ACCESS_SCOPE_INVALID')
      continue
    }
    const sql = grant.scopeType === 'source'
      ? 'SELECT 1 AS found FROM telegram_sources WHERE workspace_id = ? AND id = ? LIMIT 1'
      : grant.scopeType === 'album'
        ? 'SELECT 1 AS found FROM albums WHERE workspace_id = ? AND id = ? LIMIT 1'
        : "SELECT 1 AS found FROM assets WHERE workspace_id = ? AND id = ? AND status != 'trashed' LIMIT 1"
    const row = await db.prepare(sql).bind(PERSONAL_WORKSPACE_ID, grant.scopeId).first<{ found: number }>()
    if (!row) throw new Error('APP_ACCESS_SCOPE_NOT_FOUND')
  }
  return normalized
}

export async function replaceAppUserGrants(db: D1Database, userId: string, grants: AppUserGrant[]): Promise<AppUserGrant[]> {
  const now = new Date().toISOString()
  const normalized = await validateAppUserGrants(db, grants)
  const statements: D1PreparedStatement[] = [
    db.prepare('DELETE FROM app_user_grants WHERE workspace_id = ? AND user_id = ?').bind(PERSONAL_WORKSPACE_ID, userId),
  ]
  for (const grant of normalized) {
    statements.push(db.prepare(`INSERT INTO app_user_grants (
      id, workspace_id, user_id, scope_type, scope_id, permission, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), PERSONAL_WORKSPACE_ID, userId, grant.scopeType, grant.scopeId, grant.permission, now))
  }
  await db.batch(statements)
  return normalized
}

export async function applyAppUserPreset(db: D1Database, userId: string, preset: 'FULL' | 'VIEWER' | 'UPLOAD_ONLY'): Promise<AppUserGrant[]> {
  return replaceAppUserGrants(db, userId, grantsForPreset(preset))
}

function scopedGrantSql(assetAlias: string): string {
  return `(
    (grant_row.scope_type = 'workspace' AND grant_row.scope_id = ${assetAlias}.workspace_id)
    OR (grant_row.scope_type = 'source' AND grant_row.scope_id = ${assetAlias}.source_id)
    OR (grant_row.scope_type = 'asset' AND grant_row.scope_id = ${assetAlias}.id)
    OR (grant_row.scope_type = 'album' AND EXISTS (
      SELECT 1 FROM album_assets scoped_album_asset
      WHERE scoped_album_asset.album_id = grant_row.scope_id AND scoped_album_asset.asset_id = ${assetAlias}.id
    ))
  )`
}

export function appUserAssetPermissionPredicate(assetAlias = 'assets'): string {
  return `EXISTS (
    SELECT 1 FROM app_user_grants grant_row
    WHERE grant_row.workspace_id = ${assetAlias}.workspace_id
      AND grant_row.user_id = ? AND grant_row.permission = ?
      AND ${scopedGrantSql(assetAlias)}
  )`
}

export async function canAppUserAccessAsset(
  db: D1Database,
  user: AppUserRow,
  assetId: string,
  permission: AppUserPermission,
): Promise<boolean> {
  if (user.role === 'OWNER') return true
  const readPredicate = appUserAssetPermissionPredicate('assets')
  const requestedPredicate = permission === 'read' ? '' : ` AND ${appUserAssetPermissionPredicate('assets')}`
  const bindings: unknown[] = [assetId, PERSONAL_WORKSPACE_ID, user.id, 'read']
  if (permission !== 'read') bindings.push(user.id, permission)
  const row = await db.prepare(`SELECT 1 AS allowed FROM assets
    WHERE assets.id = ? AND assets.workspace_id = ? AND ${readPredicate}${requestedPredicate} LIMIT 1`)
    .bind(...bindings).first<{ allowed: number }>()
  return Boolean(row)
}

export async function canAppUserAccessAssets(
  db: D1Database,
  user: AppUserRow,
  assetIds: string[],
  permission: AppUserPermission,
): Promise<boolean> {
  const ids = [...new Set(assetIds)]
  if (user.role === 'OWNER') return true
  if (!ids.length) return false
  const placeholders = ids.map(() => '?').join(', ')
  const readPredicate = appUserAssetPermissionPredicate('assets')
  const requestedPredicate = permission === 'read' ? '' : ` AND ${appUserAssetPermissionPredicate('assets')}`
  const bindings: unknown[] = [PERSONAL_WORKSPACE_ID, ...ids, user.id, 'read']
  if (permission !== 'read') bindings.push(user.id, permission)
  const row = await db.prepare(`SELECT COUNT(*) AS allowed FROM assets
    WHERE assets.workspace_id = ? AND assets.id IN (${placeholders}) AND ${readPredicate}${requestedPredicate}`)
    .bind(...bindings).first<{ allowed: number }>()
  return Number(row?.allowed ?? 0) === ids.length
}

export async function canAppUserAccessSource(
  db: D1Database,
  user: AppUserRow,
  sourceId: string,
  permission: AppUserPermission,
): Promise<boolean> {
  if (user.role === 'OWNER') return true
  const row = await db.prepare(`SELECT 1 AS allowed FROM telegram_sources source_row
    WHERE source_row.id = ? AND source_row.workspace_id = ? AND EXISTS (
      SELECT 1 FROM app_user_grants grant_row
      WHERE grant_row.workspace_id = source_row.workspace_id AND grant_row.user_id = ? AND grant_row.permission = ?
        AND (
          (grant_row.scope_type = 'workspace' AND grant_row.scope_id = source_row.workspace_id)
          OR (grant_row.scope_type = 'source' AND grant_row.scope_id = source_row.id)
        )
    ) LIMIT 1`)
    .bind(sourceId, PERSONAL_WORKSPACE_ID, user.id, permission).first<{ allowed: number }>()
  return Boolean(row)
}

export async function canAppUserAccessAlbum(
  db: D1Database,
  user: AppUserRow,
  albumId: string,
  permission: AppUserPermission,
): Promise<boolean> {
  if (user.role === 'OWNER') return true
  const hasDirectAlbumPermission = async (wanted: AppUserPermission): Promise<boolean> => {
    const row = await db.prepare(`SELECT 1 AS allowed FROM albums album_row
      WHERE album_row.id = ? AND album_row.workspace_id = ? AND EXISTS (
        SELECT 1 FROM app_user_grants grant_row
        WHERE grant_row.workspace_id = album_row.workspace_id AND grant_row.user_id = ? AND grant_row.permission = ?
          AND (
            (grant_row.scope_type = 'workspace' AND grant_row.scope_id = album_row.workspace_id)
            OR (grant_row.scope_type = 'album' AND grant_row.scope_id = album_row.id)
          )
      ) LIMIT 1`)
      .bind(albumId, PERSONAL_WORKSPACE_ID, user.id, wanted).first<{ allowed: number }>()
    return Boolean(row)
  }
  const hasReadableAsset = async (): Promise<boolean> => {
    const row = await db.prepare(`SELECT 1 AS allowed FROM album_assets aa
      JOIN albums album_row ON album_row.id = aa.album_id
      JOIN assets ON assets.id = aa.asset_id
      WHERE aa.album_id = ? AND album_row.workspace_id = ? AND ${appUserAssetPermissionPredicate('assets')} LIMIT 1`)
      .bind(albumId, PERSONAL_WORKSPACE_ID, user.id, 'read').first<{ allowed: number }>()
    return Boolean(row)
  }
  const canRead = await hasDirectAlbumPermission('read') || await hasReadableAsset()
  if (!canRead) return false
  return permission === 'read' ? true : hasDirectAlbumPermission(permission)
}

export async function listAppUserAlbumScopedPermissions(
  db: D1Database,
  user: AppUserRow,
  albumId: string,
): Promise<AppUserPermission[]> {
  if (user.role === 'OWNER') return FULL_PERMISSIONS
  const rows = await db.prepare(`SELECT permission FROM app_user_grants
    WHERE workspace_id = ? AND user_id = ? AND scope_type = 'album' AND scope_id = ?`)
    .bind(PERSONAL_WORKSPACE_ID, user.id, albumId).all<{ permission: AppUserPermission }>()
  return [...new Set(rows.results.map((row) => row.permission))]
}

export async function listAccessibleAlbumIdsForAppUser(db: D1Database, user: AppUserRow, permission: AppUserPermission = 'read'): Promise<string[] | null> {
  if (user.role === 'OWNER') return null
  const rows = await db.prepare(`SELECT DISTINCT albums.id FROM albums
    WHERE albums.workspace_id = ? AND (
      EXISTS (
        SELECT 1 FROM app_user_grants grant_row
        WHERE grant_row.workspace_id = albums.workspace_id AND grant_row.user_id = ? AND grant_row.permission = ?
          AND (
            (grant_row.scope_type = 'workspace' AND grant_row.scope_id = albums.workspace_id)
            OR (grant_row.scope_type = 'album' AND grant_row.scope_id = albums.id)
          )
      )
      OR EXISTS (
        SELECT 1 FROM album_assets aa JOIN assets ON assets.id = aa.asset_id
        WHERE aa.album_id = albums.id AND ${appUserAssetPermissionPredicate('assets')}
      )
    )`)
    .bind(PERSONAL_WORKSPACE_ID, user.id, permission, user.id, permission).all<{ id: string }>()
  return rows.results.map((row) => row.id)
}

export async function hasWorkspacePermission(db: D1Database, user: AppUserRow, permission: AppUserPermission): Promise<boolean> {
  if (user.role === 'OWNER') return true
  const row = await db.prepare(`SELECT 1 AS allowed FROM app_user_grants
    WHERE workspace_id = ? AND user_id = ? AND scope_type = 'workspace' AND scope_id = ? AND permission = ? LIMIT 1`)
    .bind(PERSONAL_WORKSPACE_ID, user.id, PERSONAL_WORKSPACE_ID, permission).first<{ allowed: number }>()
  return Boolean(row)
}
