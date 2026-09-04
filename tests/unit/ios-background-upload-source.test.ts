// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activeUploadRetryAfterSeconds, botUploadLeaseMs } from '../../src/worker/domain/upload-retry'

const nativeSource = readFileSync(new URL('../../ios/App/App/NativeBackgroundUpload.swift', import.meta.url), 'utf8')

describe('native iOS background upload recovery policy', () => {
  it('never asks an active upload lease to spin at one-second intervals', () => {
    const now = Date.parse('2026-09-02T12:00:00.000Z')
    const retryAfter = activeUploadRetryAfterSeconds('2026-09-02T11:59:59.000Z', botUploadLeaseMs(5 * 1024 * 1024), now)
    expect(retryAfter).toBeGreaterThanOrEqual(5)
  })

  it('balances the debug bulk-import staging background task', () => {
    const start = nativeSource.indexOf('private func runBulkPhotoImportRuntimeSmoke')
    const end = nativeSource.indexOf('#endif', start)
    const block = nativeSource.slice(start, end)
    expect(block).toContain('NativeBackgroundUploadManager.shared.beginStagingProtection()')
    expect(block).toContain('NativeBackgroundUploadManager.shared.endStagingProtection()')
    expect(block.indexOf('endStagingProtection()')).toBeGreaterThan(block.indexOf('PRIVATE_ARCHIVE_BULK_IMPORT_SMOKE_COMPLETED'))
  })
})
