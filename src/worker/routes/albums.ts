import { Hono } from 'hono'
import { createAlbum, deleteAlbum, getAlbum, listAlbums, removeAssetFromAlbum, updateAlbum } from '../db/albums-repository'
import { logActivity } from '../db/activity-repository'
import type { Env } from '../env'
import { requireAccount, resolveRequestAppUser } from '../lib/security'
import { canAppUserAccessAlbum, canAppUserAccessAsset, hasWorkspacePermission, listAccessibleAlbumIdsForAppUser, listAppUserAlbumScopedPermissions } from '../db/app-user-access-repository'

export const albumsRoutes = new Hono<{ Bindings: Env }>()
albumsRoutes.use('*', requireAccount)

albumsRoutes.get('/', async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const [items, allowedIds] = await Promise.all([
    listAlbums(context.env.DB, user.role === 'MEMBER' ? user.id : undefined),
    listAccessibleAlbumIdsForAppUser(context.env.DB, user),
  ])
  if (allowedIds === null) return context.json({ items })
  const allowed = new Set(allowedIds)
  return context.json({ items: items.filter((album) => allowed.has(album.id)) })
})

albumsRoutes.get('/:id', async (context) => {
  const user = await resolveRequestAppUser(context)
  const albumId = context.req.param('id')
  if (!user || !(await canAppUserAccessAlbum(context.env.DB, user, albumId, 'read'))) return context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
  const album = await getAlbum(context.env.DB, albumId, user.role === 'MEMBER' ? user.id : undefined)
  return album ? context.json({ album }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

albumsRoutes.post('/', async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user || !(await hasWorkspacePermission(context.env.DB, user, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const body = await context.req.json<{ name?: unknown }>()
  if (typeof body.name !== 'string' || body.name.trim().length < 1 || body.name.length > 80) {
    return context.json({ error: 'ALBUM_NAME_INVALID' }, 400)
  }
  return context.json({ album: await createAlbum(context.env.DB, body.name.trim()) }, 201)
})

albumsRoutes.patch('/:id', async (context) => {
  const body = await context.req.json<{ name?: unknown; assetId?: unknown; coverAssetId?: unknown }>()
  const name = typeof body.name === 'string' && body.name.trim() ? body.name.trim() : undefined
  const assetId = typeof body.assetId === 'string' ? body.assetId : undefined
  const coverAssetId = typeof body.coverAssetId === 'string' ? body.coverAssetId : undefined
  if (!name && !assetId && !coverAssetId) return context.json({ error: 'ALBUM_PATCH_INVALID' }, 400)
  const albumId = context.req.param('id')
  const user = await resolveRequestAppUser(context)
  if (!user || !(await canAppUserAccessAlbum(context.env.DB, user, albumId, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const linkedAssetId = assetId ?? coverAssetId
  if (linkedAssetId && !(await canAppUserAccessAsset(context.env.DB, user, linkedAssetId, 'read'))) return context.json({ error: 'ASSET_NOT_FOUND' }, 404)
  if (assetId && user.role === 'MEMBER') {
    const inheritedPermissions = (await listAppUserAlbumScopedPermissions(context.env.DB, user, albumId))
      .filter((permission) => permission !== 'read' && permission !== 'upload')
    for (const permission of inheritedPermissions) {
      if (!(await canAppUserAccessAsset(context.env.DB, user, assetId, permission))) {
        return context.json({ error: 'ALBUM_LINK_WOULD_EXPAND_ACCESS' }, 403)
      }
    }
  }
  const updated = await updateAlbum(context.env.DB, albumId, { name, assetId, coverAssetId })
  if (updated && assetId) await logActivity(context.env.DB, { action: 'ALBUM_ADD', assetId, albumId })
  return updated ? context.json({ ok: true }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

albumsRoutes.delete('/:id/assets/:assetId', async (context) => {
  const albumId = context.req.param('id')
  const assetId = context.req.param('assetId')
  const user = await resolveRequestAppUser(context)
  if (!user || !(await canAppUserAccessAlbum(context.env.DB, user, albumId, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const removed = await removeAssetFromAlbum(context.env.DB, albumId, assetId)
  if (removed) await logActivity(context.env.DB, { action: 'ALBUM_REMOVE', assetId, albumId })
  return removed ? context.json({ ok: true }) : context.json({ error: 'ALBUM_ASSET_NOT_FOUND' }, 404)
})

albumsRoutes.delete('/:id', async (context) => {
  const albumId = context.req.param('id')
  const user = await resolveRequestAppUser(context)
  if (!user || !(await canAppUserAccessAlbum(context.env.DB, user, albumId, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const deleted = await deleteAlbum(context.env.DB, albumId)
  return deleted ? context.json({ ok: true }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

