import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramApiError, TelegramStorageAdapter } from '../../src/worker/services/telegram/telegram-client'

afterEach(() => vi.unstubAllGlobals())

describe('Telegram storage errors', () => {
  it('preserves Telegram 429 retry_after for the HTTP boundary', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ok: false, description: 'Too Many Requests', parameters: { retry_after: 7 },
    }), { status: 429, headers: { 'Content-Type': 'application/json' } })))
    const adapter = new TelegramStorageAdapter('secret', '-1001')
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close() } })
    await expect(adapter.storeOriginal({ body: stream, fileName: 'a.jpg', mimeType: 'image/jpeg', mediaType: 'photo', sizeBytes: 1 }))
      .rejects.toMatchObject({ status: 429, retryAfterSeconds: 7 } satisfies Partial<TelegramApiError>)
  })
})
