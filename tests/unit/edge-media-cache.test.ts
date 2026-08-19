import { describe, expect, it, vi } from 'vitest'
import { edgeMediaCacheKey, matchEdgeMedia, storeEdgeMedia } from '../../src/worker/services/storage/edge-media-cache'

function memoryCache() {
  const entries = new Map<string, Response>()
  const cache = {
    match: vi.fn(async (request: RequestInfo | URL) => {
      const key = typeof request === 'string' ? request : request instanceof Request ? request.url : request.toString()
      const response = entries.get(key)
      return response?.clone()
    }),
    put: vi.fn(async (request: RequestInfo | URL, response: Response) => {
      const key = typeof request === 'string' ? request : request instanceof Request ? request.url : request.toString()
      entries.set(key, response.clone())
    }),
  } as unknown as Cache
  return { cache, entries }
}

describe('edge media cache', () => {
  it('uses a stable same-origin key that ignores retry/query parameters', () => {
    const first = edgeMediaCacheKey(new Request('https://photo.example/api/assets/a/preview?retry=1'), 'preview', 'asset-1')
    const second = edgeMediaCacheKey(new Request('https://photo.example/api/assets/a/preview?retry=2'), 'preview', 'asset-1')
    const photo = edgeMediaCacheKey(new Request('https://photo.example/api/assets/a/media'), 'photo', 'asset-1')

    expect(first.url).toBe(second.url)
    expect(first.url).toBe('https://photo.example/__private-archive-edge/v1/preview/asset-1')
    expect(photo.url).toBe('https://photo.example/__private-archive-edge/v1/photo/asset-1')
  })

  it('returns MISS to the client, stores a cacheable edge copy, then returns HIT', async () => {
    const { cache, entries } = memoryCache()
    const key = new Request('https://photo.example/__private-archive-edge/v1/preview/asset-1')
    const waitUntil = vi.fn((promise: Promise<unknown>) => void promise)
    const upstream = new Response('preview-bytes', {
      status: 200,
      headers: { 'Content-Type': 'image/jpeg', 'X-Private-Archive-Preview-Cache': 'kv' },
    })

    const miss = storeEdgeMedia(cache, key, upstream, {
      browserCacheControl: 'private, max-age=60',
      edgeTtlSeconds: 600,
      source: 'kv',
      waitUntil,
    })
    expect(miss.headers.get('X-Private-Archive-Edge-Cache')).toBe('MISS')
    expect(miss.headers.get('X-Private-Archive-Upstream')).toBe('kv')
    expect(miss.headers.get('Cache-Control')).toBe('private, max-age=60')
    expect(await miss.text()).toBe('preview-bytes')
    expect(waitUntil).toHaveBeenCalledTimes(1)

    await vi.waitFor(() => expect(entries.size).toBe(1))
    const stored = [...entries.values()][0]
    expect(stored.headers.get('Cache-Control')).toBe('public, s-maxage=600, immutable')
    expect(stored.headers.get('X-Private-Archive-Origin-Source')).toBe('kv')

    const hit = await matchEdgeMedia(cache, key, 'private, max-age=60')
    expect(hit).toBeTruthy()
    expect(hit?.headers.get('X-Private-Archive-Edge-Cache')).toBe('HIT')
    expect(hit?.headers.get('X-Private-Archive-Upstream')).toBe('edge')
    expect(hit?.headers.get('Cache-Control')).toBe('private, max-age=60')
    expect(await hit?.text()).toBe('preview-bytes')
  })
})
