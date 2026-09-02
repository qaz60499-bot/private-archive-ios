import { describe, expect, it } from 'vitest'
import { activeUploadRetryAfterSeconds, botUploadLeaseMs } from '../../src/worker/domain/upload-retry'

describe('native iOS background upload recovery policy', () => {
  it('never asks an active upload lease to spin at one-second intervals', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    const retryAfter = activeUploadRetryAfterSeconds('2026-09-02T11:59:59.000Z', botUploadLeaseMs(5 * 1024 * 1024), now)
    expect(retryAfter).toBeGreaterThanOrEqual(5)
  })
})
