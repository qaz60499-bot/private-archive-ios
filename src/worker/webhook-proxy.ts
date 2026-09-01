interface ProxyEnv {
  PRIVATE_ARCHIVE: Fetcher
}

const WEBHOOK_PATH = '/api/telegram/webhook'

export default {
  async fetch(request: Request, env: ProxyEnv): Promise<Response> {
    const url = new URL(request.url)

    if (request.method === 'GET' && url.pathname === '/health') {
      return Response.json({ ok: true, service: 'private-archive-telegram-webhook' })
    }


    const webhookPath = url.pathname === WEBHOOK_PATH || url.pathname.startsWith(`${WEBHOOK_PATH}/`)
    if (request.method !== 'POST' || !webhookPath) {
      return Response.json({ error: 'NOT_FOUND' }, { status: 404 })
    }

    const forwarded = new Request(`https://private-archive.internal${url.pathname}`, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
    })
    return env.PRIVATE_ARCHIVE.fetch(forwarded)
  },
} satisfies ExportedHandler<ProxyEnv>
