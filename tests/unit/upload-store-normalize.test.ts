import { describe, expect, it } from 'vitest'
import { normalizeLocalUpload, originalLocalFileLastModified } from '../../src/web/lib/offline/job-model'

describe('local upload file metadata', () => {
  it('preserves the original file lastModified time after OPFS or IndexedDB persistence', () => {
    const original = '2024-05-06T07:08:09.000Z'
    expect(originalLocalFileLastModified({
      createdAt: '2026-08-13T01:39:24.000Z',
      metadata: { fileCreatedAt: original },
    })).toBe(Date.parse(original))
  })

  it('falls back to the queue creation time for legacy jobs without fileCreatedAt', () => {
    const createdAt = '2026-08-13T01:39:24.000Z'
    expect(originalLocalFileLastModified({ createdAt, metadata: {} })).toBe(Date.parse(createdAt))
  })
})

describe('IndexedDB v1 upload compatibility', () => {
  it('normalizes an interrupted v1 uploading job without discarding its payload or remote identity', () => {
    const blob = new Blob(['payload'])
    const normalized = normalizeLocalUpload({
      id: 'legacy', fileName: 'legacy.jpg', mimeType: 'image/jpeg', sizeBytes: blob.size, mediaType: 'photo',
      status: 'uploading', progress: 40, attempts: 1, createdAt: '2026-08-11T00:00:00.000Z', updatedAt: '2026-08-11T00:00:00.000Z',
      remoteAssetId: 'remote-a', uploadToken: 'token-a', fileBlob: blob,
      metadata: { originalName: 'legacy.jpg', mediaType: 'photo', contentHash: 'abc' },
    })
    expect(normalized).toMatchObject({
      schemaVersion: 2, batchId: 'legacy-legacy', status: 'retrying', prepareStatus: 'ready', controlState: 'active',
      remoteAssetId: 'remote-a', uploadToken: 'token-a', fileBlob: blob,
    })
  })
})
