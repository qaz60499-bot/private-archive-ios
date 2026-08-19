import { describe, expect, it, vi } from 'vitest'
import type { StorageAdapter } from '../../src/worker/services/storage/storage-adapter'
import { fetchPreviewCached } from '../../src/worker/services/storage/preview-cache'

describe('preview cache', () => {
  it('serves a KV hit without calling Telegram storage', async () => {
    const fetchFile = vi.fn()
    const storage = { fetchFile } as unknown as StorageAdapter
    const createStorage = vi.fn(() => storage)
    const cache = {
      getWithMetadata: vi.fn().mockResolvedValue({
        value: new Response('cached-image').body,
        metadata: { contentType: 'image/webp', etag: 'cached-etag' },
      }),
      put: vi.fn(),
    } as unknown as KVNamespace

    const response = await fetchPreviewCached(createStorage, 'file-1', cache)

    expect(await response.text()).toBe('cached-image')
    expect(response.headers.get('Content-Type')).toBe('image/webp')
    expect(response.headers.get('X-Private-Archive-Preview-Cache')).toBe('kv')
    expect(createStorage).not.toHaveBeenCalled()
    expect(fetchFile).not.toHaveBeenCalled()
  })

  it('streams a Telegram miss to the browser and warms KV in waitUntil', async () => {
    const storage = {
      fetchFile: vi.fn().mockResolvedValue(new Response('telegram-image', {
        headers: { 'Content-Type': 'image/jpeg', ETag: 'telegram-etag' },
      })),
    } as unknown as StorageAdapter
    const put = vi.fn().mockResolvedValue(undefined)
    const cache = {
      getWithMetadata: vi.fn().mockResolvedValue({ value: null, metadata: null }),
      put,
    } as unknown as KVNamespace
    const background: Promise<unknown>[] = []

    const response = await fetchPreviewCached(storage, 'file-2', cache, (promise) => background.push(promise))

    expect(await response.text()).toBe('telegram-image')
    expect(response.headers.get('X-Private-Archive-Preview-Cache')).toBe('telegram')
    expect(background).toHaveLength(1)
    expect(put).toHaveBeenCalledOnce()
    expect(String(put.mock.calls[0][0])).toMatch(/^preview:[0-9a-f]{64}$/)
    await Promise.all(background)
  })
})
