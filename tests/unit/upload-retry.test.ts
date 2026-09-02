import { describe, expect, it } from 'vitest'
import {
  ACTIVE_UPLOAD_RETRY_MAX_SECONDS,
  ACTIVE_UPLOAD_RETRY_MIN_SECONDS,
  activeUploadRetryAfterSeconds,
  botUploadLeaseMs,
} from '../../src/worker/domain/upload-retry'

describe('iOS/background upload retry lease policy', () => {
  it('keeps ordinary photo uploads reclaimable after a three minute stale lease', () => {
    expect(botUploadLeaseMs(4 * 1024 * 1024)).toBe(3 * 60 * 1000)
  })

  it('allows slower large Bot uploads more time without exceeding ten minutes', () => {
    expect(botUploadLeaseMs(20 * 1024 * 1024)).toBe(380_000)
    expect(botUploadLeaseMs(200 * 1024 * 1024)).toBe(10 * 60 * 1000)
  })

  it('backs an active lease off instead of returning a one-second retry loop', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    const leaseMs = botUploadLeaseMs(4 * 1024 * 1024)
    expect(activeUploadRetryAfterSeconds('2026-09-02T11:59:59.000Z', leaseMs, now)).toBe(ACTIVE_UPLOAD_RETRY_MAX_SECONDS)
    expect(activeUploadRetryAfterSeconds('2026-09-02T11:57:02.000Z', leaseMs, now)).toBe(ACTIVE_UPLOAD_RETRY_MIN_SECONDS)
  })
})
