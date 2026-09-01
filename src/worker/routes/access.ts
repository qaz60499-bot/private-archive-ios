import { Hono } from 'hono'
import { createShareLink, listShareLinks, revokeShareLink, rotateShareLink, type ShareScopeType } from '../db/share-access-repository'
import type { Env } from '../env'
import { requireOwner } from '../lib/security'

export const accessRoutes = new Hono<{ Bindings: Env }>()
accessRoutes.use('*', requireOwner)

function shareUrl(origin: string | undefined, token: string): string | null {
  if (!origin) return null
  try {
    const url = new URL(origin)
    url.hash = `/share/${token}`
    return url.toString()
  } catch {
    return null
  }
}

accessRoutes.get('/shares', async (context) => context.json({ items: await listShareLinks(context.env.DB) }))

accessRoutes.post('/shares', async (context) => {
  const body = await context.req.json<{
    name?: unknown
    scopeType?: unknown
    scopeId?: unknown
    allowDownload?: unknown
    expiresInDays?: unknown
  }>()
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const scopeType = String(body.scopeType ?? '') as ShareScopeType
  const scopeId = typeof body.scopeId === 'string' ? body.scopeId : ''
  if (!name || name.length > 80) return context.json({ error: 'SHARE_NAME_INVALID' }, 400)
  if (!['source', 'album', 'asset'].includes(scopeType)) return context.json({ error: 'SHARE_SCOPE_TYPE_INVALID' }, 400)
  if (!scopeId || scopeId.length > 160) return context.json({ error: 'SHARE_SCOPE_ID_INVALID' }, 400)
  const expiresInDays = body.expiresInDays === null ? null : Number(body.expiresInDays)
  if (expiresInDays !== null && ![1, 7, 30].includes(expiresInDays)) return context.json({ error: 'SHARE_EXPIRY_INVALID' }, 400)
  try {
    const result = await createShareLink(context.env.DB, {
      name,
      scopeType,
      scopeId,
      allowDownload: body.allowDownload === true,
      expiresInDays: expiresInDays as 1 | 7 | 30 | null,
    })
    return context.json({ item: result.item, url: shareUrl(context.env.SHARE_ORIGIN ?? new URL(context.req.url).origin, result.token) }, 201)
  } catch (error) {
    if (error instanceof Error && error.message === 'SHARE_SCOPE_NOT_FOUND') return context.json({ error: error.message }, 404)
    throw error
  }
})

accessRoutes.post('/shares/:id/revoke', async (context) => {
  const revoked = await revokeShareLink(context.env.DB, context.req.param('id'))
  return revoked ? context.json({ ok: true }) : context.json({ error: 'SHARE_NOT_FOUND' }, 404)
})

accessRoutes.post('/shares/:id/rotate', async (context) => {
  const rotated = await rotateShareLink(context.env.DB, context.req.param('id'))
  if (!rotated) return context.json({ error: 'SHARE_NOT_FOUND' }, 404)
  return context.json({ ok: true, url: shareUrl(context.env.SHARE_ORIGIN ?? new URL(context.req.url).origin, rotated.token) })
})
