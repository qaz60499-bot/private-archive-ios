import { PERSONAL_WORKSPACE_ID } from './assets-repository'
import { appUserAssetPermissionPredicate } from './app-user-access-repository'

export type ActivityAction =
  | 'UPLOAD'
  | 'IMPORT'
  | 'RENAME'
  | 'MOVE'
  | 'DELETE'
  | 'RESTORE'
  | 'PURGE'
  | 'FAVORITE'
  | 'ARCHIVE'
  | 'TAG'
  | 'ALBUM_ADD'
  | 'ALBUM_REMOVE'
  | 'SHARE'
  | 'LOGIN'

export interface ActivityRow {
  id: string
  workspace_id: string
  action: ActivityAction
  asset_id: string | null
  album_id: string | null
  detail_json: string | null
  created_at: string
  asset_name: string | null
  asset_source: string | null
}

export async function logActivity(db: D1Database, input: {
  action: ActivityAction
  assetId?: string | null
  albumId?: string | null
  detail?: Record<string, unknown>
}): Promise<void> {
  await db.prepare(`INSERT INTO activity_log (id, workspace_id, action, asset_id, album_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(), PERSONAL_WORKSPACE_ID, input.action, input.assetId ?? null, input.albumId ?? null,
      input.detail ? JSON.stringify(input.detail).slice(0, 4000) : null, new Date().toISOString(),
    ).run()
}

export async function listActivity(db: D1Database, limit = 50, appUserId?: string): Promise<ActivityRow[]> {
  const accessFilter = appUserId ? `AND activity_log.asset_id IS NOT NULL AND ${appUserAssetPermissionPredicate('assets')}` : ''
  const values: unknown[] = [PERSONAL_WORKSPACE_ID]
  if (appUserId) values.push(appUserId, 'read')
  values.push(Math.min(Math.max(limit, 1), 100))
  const result = await db.prepare(`SELECT activity_log.id, activity_log.workspace_id, activity_log.action,
      activity_log.asset_id, activity_log.album_id, activity_log.detail_json, activity_log.created_at,
      assets.original_name AS asset_name, assets.source AS asset_source
    FROM activity_log LEFT JOIN assets ON assets.id = activity_log.asset_id AND assets.workspace_id = activity_log.workspace_id
    WHERE activity_log.workspace_id = ? ${accessFilter} ORDER BY activity_log.created_at DESC, activity_log.id DESC LIMIT ?`)
    .bind(...values).all<ActivityRow>()
  return result.results
}
