import { Hono } from 'hono'
import { createAlbum, deleteAlbum, getAlbum, listAlbums, removeAssetFromAlbum, updateAlbum } from '../db/albums-repository'
import type { Env } from '../env'
import { requireOwner } from '../lib/security'

export const albumsRoutes = new Hono<{ Bindings: Env }>()
albumsRoutes.use('*', requireOwner)

albumsRoutes.get('/', async (context) => context.json({ items: await listAlbums(context.env.DB) }))

albumsRoutes.get('/:id', async (context) => {
  const album = await getAlbum(context.env.DB, context.req.param('id'))
  return album ? context.json({ album }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

albumsRoutes.post('/', async (context) => {
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
  const updated = await updateAlbum(context.env.DB, context.req.param('id'), { name, assetId, coverAssetId })
  return updated ? context.json({ ok: true }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

albumsRoutes.delete('/:id/assets/:assetId', async (context) => {
  const removed = await removeAssetFromAlbum(context.env.DB, context.req.param('id'), context.req.param('assetId'))
  return removed ? context.json({ ok: true }) : context.json({ error: 'ALBUM_ASSET_NOT_FOUND' }, 404)
})

albumsRoutes.delete('/:id', async (context) => {
  const deleted = await deleteAlbum(context.env.DB, context.req.param('id'))
  return deleted ? context.json({ ok: true }) : context.json({ error: 'ALBUM_NOT_FOUND' }, 404)
})

