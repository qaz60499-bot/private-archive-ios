import { Hono } from 'hono'
import { albumsRoutes } from './routes/albums'
import { authRoutes } from './routes/auth'
import { assetsRoutes } from './routes/assets'
import { accessRoutes } from './routes/access'
import { shareRoutes } from './routes/share'
import { systemRoutes } from './routes/system'
import { telegramRoutes } from './routes/telegram'
import { discoverModulesRoutes } from './routes/discover-modules'
import { recoveryRoutes } from './routes/recovery'
import { consumeAnalysisQueue } from './queue/consumer'
import type { AnalysisMessage, Env } from './env'
import { applyBrowserSecurityHeaders } from './lib/browser-security'
import { restrictHostedUploadApiScope } from './lib/security'

export { PasswordVerifier } from './durable/password-verifier'

const app = new Hono<{ Bindings: Env }>()

app.use('*', async (context, next) => {
  await next()
  const url = new URL(context.req.url)
  const path = url.pathname
  // Every API response can depend on the current Access/app/share principal. Do not
  // let a browser reuse an owner-authorized JSON/media response after an account or
  // permission change. Worker-side media Cache API entries remain independently
  // reusable because authorization runs before the edge cache lookup.
  if (path === '/api' || path.startsWith('/api/')) {
    context.res.headers.set('Cache-Control', 'private, no-store')
    if (!context.res.headers.has('Permissions-Policy')) {
      context.res.headers.set('Permissions-Policy', 'geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), document-domain=()')
    }
    if (!context.res.headers.has('Cross-Origin-Resource-Policy')) context.res.headers.set('Cross-Origin-Resource-Policy', 'same-origin')
    if (url.protocol === 'https:' && !context.res.headers.has('Strict-Transport-Security')) {
      context.res.headers.set('Strict-Transport-Security', 'max-age=31536000')
    }
  }
  if (!context.res.headers.has('X-Content-Type-Options')) context.res.headers.set('X-Content-Type-Options', 'nosniff')
  if (!context.res.headers.has('Referrer-Policy')) context.res.headers.set('Referrer-Policy', 'no-referrer')
  if (!context.res.headers.has('X-Frame-Options')) context.res.headers.set('X-Frame-Options', 'DENY')
  if (!context.res.headers.has('Content-Security-Policy')) {
    context.res.headers.set('Content-Security-Policy', "base-uri 'none'; object-src 'none'; frame-ancestors 'none'")
  }
})

app.use('/api/*', restrictHostedUploadApiScope)

app.get('/api/health', (context) => {
  context.header('Cache-Control', 'no-store')
  return context.json({
    ok: true,
    service: 'private-archive',
    time: new Date().toISOString(),
  })
})
app.route('/api/share', shareRoutes)
app.route('/api/auth', authRoutes)
app.route('/api/access', accessRoutes)
app.route('/api/assets', assetsRoutes)
app.route('/api/albums', albumsRoutes)
app.route('/api/discover-modules', discoverModulesRoutes)
app.route('/api/telegram', telegramRoutes)
app.route('/api/recovery', recoveryRoutes)
app.route('/api', systemRoutes)

app.notFound(async (context) => {
  const url = new URL(context.req.url)
  const path = url.pathname
  const desktopApiHosts = (context.env.DESKTOP_API_HOST ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean)
  const apiOnlyHost = desktopApiHosts.includes(url.hostname.toLowerCase())

  // Unknown API routes must stay JSON 404s on every surface. The dedicated
  // desktop API host is API-only as well. Every other non-API request belongs
  // to the hosted Web surface, where the Assets binding provides the Vite SPA
  // fallback (including `/` -> `index.html`). With run_worker_first=true this
  // fallback must be explicit or the Worker shadows the static application.
  if (path === '/api' || path.startsWith('/api/') || apiOnlyHost) {
    return context.json({ error: 'NOT_FOUND' }, 404)
  }
  return applyBrowserSecurityHeaders(await context.env.ASSETS.fetch(context.req.raw), context.req.url)
})
app.onError((error, context) => {
  console.error('Unhandled worker error', error instanceof Error ? error.message : 'unknown')
  return context.json({ error: 'INTERNAL_ERROR' }, 500)
})

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<AnalysisMessage>, env: Env) => consumeAnalysisQueue(batch, env),
  // A legacy Cloudflare Cron Trigger still targets this Worker every minute even
  // though scheduled maintenance was removed from the product. Keep the event
  // explicitly handled and side-effect free: in particular, do not touch D1 here,
  // because background auth/session cleanup must not consume row-write quota.
  scheduled: () => undefined,
} satisfies ExportedHandler<Env, AnalysisMessage>
