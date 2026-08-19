import { describe, expect, it } from 'vitest'
import { ApiError } from '../../src/web/lib/api'
import { calculateRetryDelay, friendlyUploadError, getUploadSchedulerLimits } from '../../src/web/lib/offline/scheduler-policy'

describe('upload scheduler policy', () => {
  it('uses desktop 3 uploads / 2 prepares and mobile 2 uploads / 1 prepare', async () => {
    expect(getUploadSchedulerLimits(false, false)).toEqual({ prepare: 2, upload: 3, video: 1 })
    expect(getUploadSchedulerLimits(true, false)).toEqual({ prepare: 1, upload: 2, video: 1 })
    expect(getUploadSchedulerLimits(false, true)).toEqual({ prepare: 1, upload: 1, video: 1 })
  })

  it('applies full-jitter exponential backoff and prefers Retry-After', async () => {
    expect(calculateRetryDelay(1, undefined, 0)).toBe(500)
    expect(calculateRetryDelay(4, undefined, 1)).toBe(8_000)
    expect(calculateRetryDelay(9, undefined, 1)).toBe(60_000)
    expect(calculateRetryDelay(2, 17_000, 0)).toBe(17_000)
  })

  it('returns specific Chinese recovery messages for Access, timeout, offline, and 429', async () => {
    expect(friendlyUploadError(new ApiError(401, 'ACCESS_SIGN_IN_REQUIRED'))).toContain('Access 登录已失效')
    expect(friendlyUploadError(new ApiError(0, 'REQUEST_TIMEOUT'))).toContain('请求超时')
    expect(friendlyUploadError(new ApiError(0, 'NETWORK_OFFLINE'))).toContain('网络连接中断')
    expect(friendlyUploadError(new ApiError(429, 'TELEGRAM_RATE_LIMITED', 3_000))).toContain('降低并发')
  })
})
