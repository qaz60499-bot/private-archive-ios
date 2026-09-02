const MIN_BOT_UPLOAD_LEASE_MS = 3 * 60 * 1000
const MAX_BOT_UPLOAD_LEASE_MS = 10 * 60 * 1000
const BOT_UPLOAD_BYTES_PER_SECOND_FLOOR = 64 * 1024
const BOT_UPLOAD_LEASE_GRACE_MS = 60 * 1000

export const ACTIVE_UPLOAD_RETRY_MIN_SECONDS = 5
export const ACTIVE_UPLOAD_RETRY_MAX_SECONDS = 20

export function botUploadLeaseMs(sizeBytes: number): number {
  const sizeAware = Math.ceil(Math.max(0, sizeBytes) / BOT_UPLOAD_BYTES_PER_SECOND_FLOOR) * 1000 + BOT_UPLOAD_LEASE_GRACE_MS
  return Math.max(MIN_BOT_UPLOAD_LEASE_MS, Math.min(MAX_BOT_UPLOAD_LEASE_MS, sizeAware))
}

export function activeUploadRetryAfterSeconds(updatedAt: string | null | undefined, leaseMs: number, nowMs = Date.now()): number {
  const updatedMs = updatedAt ? Date.parse(updatedAt) : Number.NaN
  const remainingMs = Number.isFinite(updatedMs) ? Math.max(0, updatedMs + leaseMs - nowMs) : leaseMs
  return Math.min(
    ACTIVE_UPLOAD_RETRY_MAX_SECONDS,
    Math.max(ACTIVE_UPLOAD_RETRY_MIN_SECONDS, Math.ceil(remainingMs / 1000)),
  )
}
