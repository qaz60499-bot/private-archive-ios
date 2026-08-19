import type { StorageAdapter } from './storage-adapter'

const PREVIEW_BROWSER_TTL_SECONDS = 7 * 24 * 60 * 60
const PREVIEW_KV_TTL_SECONDS = 30 * 24 * 60 * 60
const PREVIEW_KV_EDGE_TTL_SECONDS = 24 * 60 * 60

interface PreviewCacheMetadata {
  contentType?: string
  etag?: string
  lastModified?: string
}

async function cacheKeyForFile(fileId: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(fileId))
  return `preview:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function responseForBrowser(body: BodyInit | null, metadata: PreviewCacheMetadata, source: 'kv' | 'telegram'): Response {
  const headers = new Headers({
    'Content-Type': metadata.contentType ?? 'image/jpeg',
    'Cache-Control': `private, max-age=${PREVIEW_BROWSER_TTL_SECONDS}, immutable`,
    'X-Private-Archive-Preview-Cache': source,
  })
  if (metadata.etag) headers.set('ETag', metadata.etag)
  if (metadata.lastModified) headers.set('Last-Modified', metadata.lastModified)
  return new Response(body, { status: 200, headers })
}

type StorageSource = StorageAdapter | (() => StorageAdapter | Promise<StorageAdapter>)

async function resolveStorage(source: StorageSource): Promise<StorageAdapter> {
  return typeof source === 'function' ? await source() : source
}

export async function fetchPreviewCached(
  storageSource: StorageSource,
  fileId: string,
  previewCache?: KVNamespace,
  waitUntil?: (promise: Promise<unknown>) => void,
): Promise<Response> {
  const cacheKey = await cacheKeyForFile(fileId)

  if (previewCache) {
    const cached = await previewCache.getWithMetadata<PreviewCacheMetadata>(cacheKey, {
      type: 'stream',
      cacheTtl: PREVIEW_KV_EDGE_TTL_SECONDS,
    })
    if (cached.value) return responseForBrowser(cached.value, cached.metadata ?? {}, 'kv')
  }

  const upstream = await (await resolveStorage(storageSource)).fetchFile(fileId)
  if (!upstream.ok || !upstream.body) return upstream

  const metadata: PreviewCacheMetadata = {
    contentType: upstream.headers.get('Content-Type') ?? 'image/jpeg',
    etag: upstream.headers.get('ETag') ?? undefined,
    lastModified: upstream.headers.get('Last-Modified') ?? undefined,
  }

  if (!previewCache) return responseForBrowser(upstream.body, metadata, 'telegram')

  const [browserBody, cacheBody] = upstream.body.tee()
  const cacheWrite = previewCache.put(cacheKey, cacheBody, {
    expirationTtl: PREVIEW_KV_TTL_SECONDS,
    metadata,
  })

  if (waitUntil) waitUntil(cacheWrite)
  else await cacheWrite

  return responseForBrowser(browserBody, metadata, 'telegram')
}
