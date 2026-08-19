const PREVIEW_EDGE_TTL_SECONDS = 7 * 24 * 60 * 60
const PHOTO_EDGE_TTL_SECONDS = 24 * 60 * 60

export type EdgeMediaVariant = 'preview' | 'photo'
export type EdgeMediaSource = 'kv' | 'telegram' | 'mock'

interface EdgeCacheOptions {
  browserCacheControl: string
  edgeTtlSeconds: number
  source: EdgeMediaSource
  waitUntil?: (promise: Promise<unknown>) => void
}

export const EDGE_MEDIA_TTL = {
  preview: PREVIEW_EDGE_TTL_SECONDS,
  photo: PHOTO_EDGE_TTL_SECONDS,
} as const

export async function openEdgeMediaCache(): Promise<Cache> {
  return caches.open('private-archive-media-v1')
}

export function edgeMediaCacheKey(request: Request, variant: EdgeMediaVariant, assetId: string): Request {
  const url = new URL(request.url)
  url.pathname = `/__private-archive-edge/v1/${variant}/${encodeURIComponent(assetId)}`
  url.search = ''
  url.hash = ''
  return new Request(url.toString(), { method: 'GET' })
}

function clientHeaders(source: Headers, state: 'HIT' | 'MISS', upstream: 'edge' | EdgeMediaSource, browserCacheControl: string): Headers {
  const headers = new Headers(source)
  headers.set('Cache-Control', browserCacheControl)
  headers.set('X-Private-Archive-Edge-Cache', state)
  headers.set('X-Private-Archive-Upstream', upstream)
  headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive')
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  headers.set('Server-Timing', `edge-cache;desc="${state}", upstream;desc="${upstream}"`)
  headers.delete('Set-Cookie')
  return headers
}

export async function matchEdgeMedia(
  cache: Cache,
  cacheKey: Request,
  browserCacheControl: string,
): Promise<Response | undefined> {
  const cached = await cache.match(cacheKey)
  if (!cached) return undefined
  return new Response(cached.body, {
    status: cached.status,
    statusText: cached.statusText,
    headers: clientHeaders(cached.headers, 'HIT', 'edge', browserCacheControl),
  })
}

export function storeEdgeMedia(
  cache: Cache,
  cacheKey: Request,
  response: Response,
  options: EdgeCacheOptions,
): Response {
  if (!response.ok || response.status !== 200 || !response.body) {
    const headers = clientHeaders(response.headers, 'MISS', options.source, options.browserCacheControl)
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
  }

  const [clientBody, cacheBody] = response.body.tee()
  const storedHeaders = new Headers(response.headers)
  storedHeaders.set('Cache-Control', `public, s-maxage=${options.edgeTtlSeconds}, immutable`)
  storedHeaders.set('X-Private-Archive-Origin-Source', options.source)
  storedHeaders.delete('Set-Cookie')

  const put = cache.put(cacheKey, new Response(cacheBody, {
    status: response.status,
    statusText: response.statusText,
    headers: storedHeaders,
  }))
  if (options.waitUntil) options.waitUntil(put)
  else void put

  return new Response(clientBody, {
    status: response.status,
    statusText: response.statusText,
    headers: clientHeaders(response.headers, 'MISS', options.source, options.browserCacheControl),
  })
}
