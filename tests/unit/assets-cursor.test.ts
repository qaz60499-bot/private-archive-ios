import { describe, expect, it } from 'vitest'
import { decodeAssetCursor, encodeAssetCursor } from '../../src/worker/db/assets-repository'

describe('asset cursor', () => {
  it('round-trips the timestamp and id used by the stable sort', () => {
    const cursor = encodeAssetCursor({ taken_at: '2026-08-12T04:05:06.000Z', id: 'asset-123' })
    expect(cursor).toBe('2026-08-12T04:05:06.000Z|asset-123')
    expect(decodeAssetCursor(cursor)).toEqual({ takenAt: '2026-08-12T04:05:06.000Z', id: 'asset-123' })
  })

  it('rejects malformed composite cursors so legacy timestamp cursors can fall back safely', () => {
    expect(decodeAssetCursor('2026-08-12T04:05:06.000Z')).toBeNull()
    expect(decodeAssetCursor('not-a-date|asset-123')).toBeNull()
    expect(decodeAssetCursor('|asset-123')).toBeNull()
  })
})
