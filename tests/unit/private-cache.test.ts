import { describe, expect, it } from 'vitest'
import { clearSensitivePrivateCaches } from '../../src/web/lib/private-cache'

function fakeCacheStorage(names: string[]) {
  const deleted: string[] = []
  return {
    deleted,
    storage: {
      keys: async () => [...names],
      delete: async (name: string) => {
        deleted.push(name)
        return true
      },
    } as unknown as CacheStorage,
  }
}

describe('clearSensitivePrivateCaches', () => {
  it('deletes only private preview runtime cache generations', async () => {
    const fake = fakeCacheStorage([
      'archive-previews-v2',
      'archive-previews-v3',
      'archive-ui-images-v2',
      'workbox-precache-v2-example',
    ])

    await expect(clearSensitivePrivateCaches(fake.storage)).resolves.toBe(2)
    expect(fake.deleted).toEqual(['archive-previews-v2', 'archive-previews-v3'])
  })

  it('is a no-op when CacheStorage is unavailable', async () => {
    await expect(clearSensitivePrivateCaches(undefined)).resolves.toBe(0)
  })
})
