import { describe, expect, it } from 'vitest'
import { storedUploadAcknowledgementHeaders } from '../../src/worker/domain/upload-acknowledgement'

const stored = {
  id: 'committed-asset', status: 'ready' as const, storage_backend: 'telegram_bot' as const,
  size_bytes: 262567, content_hash: 'e83f7b82bd5b17810d6fde0930d023e1c8ede8f0d893dbf9b4dfa352fbd58c9b',
  storage_file_id: 'telegram-original', deleted_at: null, purge_state: 'active' as const,
}

describe('durable upload acknowledgement headers', () => {
  it.each(['stored', 'queued', 'analyzing', 'ready', 'limited'] as const)('binds a %s commit to the existing asset, backend, bytes and SHA256', (status) => {
    expect(storedUploadAcknowledgementHeaders({ ...stored, status })).toEqual({
      'X-PA-Upload-Commit': 'v1', 'X-PA-Asset-Id': stored.id,
      'X-PA-Storage-Backend': 'telegram_bot', 'X-PA-Size-Bytes': '262567',
      'X-PA-Content-SHA256': stored.content_hash, 'X-PA-Asset-Status': status,
    })
  })

  it('emits no proof for missing, uncommitted, deleting, legacy or unsupported rows', () => {
    for (const asset of [
      null, { ...stored, status: 'pending_upload' as const }, { ...stored, status: 'failed' as const },
      { ...stored, status: 'trashed' as const }, { ...stored, storage_file_id: null },
      { ...stored, deleted_at: '2026-10-22T00:00:00Z' }, { ...stored, purge_state: 'pending' as const },
      { ...stored, storage_backend: 'telegram_user_group' as const }, { ...stored, content_hash: null },
      { ...stored, content_hash: 'invalid' }, { ...stored, content_hash: 'a'.repeat(63) },
      { ...stored, size_bytes: 0 }, { ...stored, size_bytes: -1 }, { ...stored, size_bytes: 1.5 },
      { ...stored, size_bytes: Number.MAX_SAFE_INTEGER + 1 }, { ...stored, id: 'invalid\r\nheader' },
    ]) expect(storedUploadAcknowledgementHeaders(asset)).toEqual({})
  })
})
