import http from 'node:http'

const host = '127.0.0.1'
const port = Number(process.env.PRIVATE_ARCHIVE_PROTOCOL_SMOKE_PORT ?? 18765)
const expectedSize = 256 * 1024
const uploadToken = 'native-protocol-smoke-upload-token'
const sessionCookie = 'pa_account=protocol-smoke-session'

function json(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function readBody(request, maxBytes = 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > maxBytes) throw new Error('BODY_TOO_LARGE')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function hasNativeHeaders(request) {
  return request.headers['x-private-archive-native'] === 'ios'
    && request.headers['x-requested-with'] === 'XMLHttpRequest'
    && String(request.headers.cookie ?? '').includes(sessionCookie)
}

const server = http.createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      response.writeHead(204)
      response.end()
      return
    }

    if (request.method === 'POST' && request.url === '/api/assets/reserve') {
      if (!hasNativeHeaders(request)) return json(response, 403, { error: 'PROTOCOL_SMOKE_RESERVE_HEADERS_INVALID' })
      if (request.headers['content-type'] !== 'application/json') return json(response, 400, { error: 'PROTOCOL_SMOKE_RESERVE_CONTENT_TYPE_INVALID' })
      const body = await readBody(request)
      const parsed = JSON.parse(body.toString('utf8'))
      if (parsed.originalName !== 'native-protocol-smoke.bin'
        || parsed.mimeType !== 'application/octet-stream'
        || parsed.mediaType !== 'file'
        || parsed.storageBackend !== 'telegram_bot'
        || parsed.importOrigin !== 'ios-background'
        || parsed.sizeBytes !== expectedSize
        || typeof parsed.contentHash !== 'string'
        || parsed.contentHash.length !== 64) {
        return json(response, 400, { error: 'PROTOCOL_SMOKE_RESERVE_BODY_INVALID' })
      }
      console.log('PRIVATE_ARCHIVE_PROTOCOL_SERVER_RESERVE_OK')
      return json(response, 201, {
        assetId: 'native-protocol-smoke-asset',
        uploadToken,
        duplicate: false,
        resumed: false,
        storageBackend: 'telegram_bot',
        sizeTier: 'bot',
        maxUploadBytes: 20 * 1024 * 1024,
      })
    }

    if (request.method === 'PUT' && request.url === '/api/assets/native-protocol-smoke-asset/content') {
      if (!hasNativeHeaders(request)) return json(response, 403, { error: 'PROTOCOL_SMOKE_CONTENT_HEADERS_INVALID' })
      if (request.headers['x-upload-token'] !== uploadToken) return json(response, 401, { error: 'PROTOCOL_SMOKE_UPLOAD_TOKEN_INVALID' })
      if (request.headers['content-type'] !== 'application/octet-stream') return json(response, 400, { error: 'PROTOCOL_SMOKE_CONTENT_TYPE_INVALID' })
      if (Number(request.headers['content-length']) !== expectedSize) return json(response, 411, { error: 'PROTOCOL_SMOKE_CONTENT_LENGTH_INVALID' })
      const body = await readBody(request, expectedSize + 1)
      if (body.length !== expectedSize || body.some((value) => value !== 0x5a)) {
        return json(response, 400, { error: 'PROTOCOL_SMOKE_CONTENT_BODY_INVALID' })
      }
      console.log('PRIVATE_ARCHIVE_PROTOCOL_SERVER_CONTENT_OK bytes=' + body.length)
      return json(response, 201, { asset: { id: 'native-protocol-smoke-asset' }, previewAvailable: false })
    }

    return json(response, 404, { error: 'PROTOCOL_SMOKE_ROUTE_NOT_FOUND' })
  } catch (error) {
    console.error('PRIVATE_ARCHIVE_PROTOCOL_SERVER_FAILED', error instanceof Error ? error.message : String(error))
    if (!response.headersSent) json(response, 500, { error: 'PROTOCOL_SMOKE_SERVER_FAILED' })
    else response.end()
  }
})

server.listen(port, host, () => {
  console.log(`PRIVATE_ARCHIVE_PROTOCOL_SERVER_READY http://${host}:${port}`)
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)))
}
