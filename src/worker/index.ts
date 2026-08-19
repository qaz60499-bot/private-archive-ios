import { Hono } from 'hono'
import { albumsRoutes } from './routes/albums'
import { assetsRoutes } from './routes/assets'
import { systemRoutes } from './routes/system'
import { telegramRoutes } from './routes/telegram'
import { discoverModulesRoutes } from './routes/discover-modules'
import { consumeAnalysisQueue } from './queue/consumer'
import type { AnalysisMessage, Env } from './env'

const app = new Hono<{ Bindings: Env }>()

app.get('/api/health', (context) => context.json({ ok: true, service: 'private-archive', time: new Date().toISOString() }))
app.route('/api/assets', assetsRoutes)
app.route('/api/albums', albumsRoutes)
app.route('/api/discover-modules', discoverModulesRoutes)
app.route('/api/telegram', telegramRoutes)
app.route('/api', systemRoutes)

app.notFound((context) => context.json({ error: 'NOT_FOUND' }, 404))
app.onError((error, context) => {
  console.error('Unhandled worker error', error instanceof Error ? error.message : 'unknown')
  return context.json({ error: 'INTERNAL_ERROR' }, 500)
})

export default {
  fetch: app.fetch,
  queue: (batch: MessageBatch<AnalysisMessage>, env: Env) => consumeAnalysisQueue(batch, env),
} satisfies ExportedHandler<Env, AnalysisMessage>
