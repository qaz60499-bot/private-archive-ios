import { afterEach, describe, expect, it, vi } from 'vitest'
import { TelegramApiError, TelegramStorageAdapter } from '../../src/worker/services/telegram/telegram-client'

afterEach(() => vi.unstubAllGlobals())

describe('TelegramStorageAdapter', () => {
  it('reuses the thumbnail returned on the same Telegram document message', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: true,
      result: {
        message_id: 321,
        date: 1_700_000_000,
        chat: { id: -1001234567890, type: 'channel' },
        document: {
          file_id: 'original-file-id',
          file_unique_id: 'original-unique-id',
          file_name: 'photo.jpg',
          mime_type: 'image/jpeg',
          thumbnail: {
            file_id: 'thumbnail-file-id',
            file_unique_id: 'thumbnail-unique-id',
            width: 320,
            height: 240,
          },
        },
      },
    }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
    vi.stubGlobal('fetch', telegramFetch)

    const adapter = new TelegramStorageAdapter('test-token', '-1001234567890')
    const stored = await adapter.storeOriginal({
      body: new Blob(['original']).stream(),
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      mediaType: 'photo',
      sizeBytes: 8,
    })

    expect(stored).toMatchObject({
      chatId: '-1001234567890',
      messageId: 321,
      fileId: 'original-file-id',
      fileUniqueId: 'original-unique-id',
      previewFileId: 'thumbnail-file-id',
    })
    expect(telegramFetch).toHaveBeenCalledTimes(1)
  })

  it('deletes a legacy preview message before a resumed photo upload', async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true, result: true }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }))
    vi.stubGlobal('fetch', telegramFetch)

    const adapter = new TelegramStorageAdapter('test-token', '-1001234567890')
    await expect(adapter.deleteMessage(96)).resolves.toBe(true)
    expect(telegramFetch).toHaveBeenCalledTimes(1)
    expect(String(telegramFetch.mock.calls[0][0])).toContain('/deleteMessage')
    expect(JSON.parse(String((telegramFetch.mock.calls[0][1] as RequestInit).body))).toMatchObject({
      chat_id: '-1001234567890', message_id: 96,
    })
  })

  it('treats an already-missing legacy preview message as deleted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ok: false, description: 'Bad Request: message to delete not found',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })))

    const adapter = new TelegramStorageAdapter('test-token', '-1001234567890')
    await expect(adapter.deleteMessage(96)).resolves.toBe(false)
  })
})

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
