import { Hono } from 'hono'
import { createDiscoverModule, deleteDiscoverModule, listDiscoverModules } from '../db/discover-modules-repository'
import type { Env } from '../env'
import { requireAccount, resolveRequestAppUser } from '../lib/security'
import { hasWorkspacePermission } from '../db/app-user-access-repository'

export const discoverModulesRoutes = new Hono<{ Bindings: Env }>()
discoverModulesRoutes.use('*', requireAccount)

discoverModulesRoutes.get('/', async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user) return context.json({ error: 'APP_AUTH_REQUIRED' }, 401)
  const items = await listDiscoverModules(context.env.DB, user.role === 'MEMBER' ? user.id : undefined)
  return context.json({
    items: items.map((item) => ({
      slug: item.slug,
      name: item.name,
      description: item.description,
      kind: item.kind,
      sortOrder: item.sort_order,
      isSystem: item.is_system === 1,
      assetCount: item.asset_count,
      coverAssetId: item.cover_asset_id,
    })),
  })
})

discoverModulesRoutes.post('/', async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user || !(await hasWorkspacePermission(context.env.DB, user, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const body = await context.req.json<{ name?: unknown; description?: unknown }>()
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  if (!name || name.length > 24 || description.length > 80) {
    return context.json({ error: 'DISCOVER_MODULE_INVALID' }, 400)
  }
  const module = await createDiscoverModule(context.env.DB, name, description || `${name}相关的自定义内容`)
  return context.json({
    module: {
      slug: module.slug,
      name: module.name,
      description: module.description,
      kind: module.kind,
      sortOrder: module.sort_order,
      isSystem: false,
      assetCount: 0,
      coverAssetId: null,
    },
  }, 201)
})

discoverModulesRoutes.delete('/:slug', async (context) => {
  const user = await resolveRequestAppUser(context)
  if (!user || !(await hasWorkspacePermission(context.env.DB, user, 'edit'))) return context.json({ error: 'APP_EDIT_NOT_ALLOWED' }, 403)
  const deleted = await deleteDiscoverModule(context.env.DB, context.req.param('slug'))
  return deleted ? context.json({ ok: true }) : context.json({ error: 'DISCOVER_MODULE_NOT_DELETABLE' }, 400)
})
