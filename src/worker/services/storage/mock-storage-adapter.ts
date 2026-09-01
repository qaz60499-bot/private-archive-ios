import type { StorageBackend, StoredFile } from '../../domain/types'
import type { StorageAdapter, StoreOriginalInput, StorePreviewInput } from './storage-adapter'

function mockMessageId(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
  return value || 1
}

function mockStoredFile(prefix: string, backend: StorageBackend): StoredFile {
  const id = crypto.randomUUID()
  return {
    backend,
    chatId: '-1000000000000',
    messageId: mockMessageId(),
    fileId: `${prefix}_${id}`,
    fileUniqueId: `${prefix}_unique_${id}`,
    telegramUrl: 'https://t.me/c/0000000000/1',
  }
}

async function drainWithoutBuffering(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  while (!(await reader.read()).done) {
    // Mock mode deliberately consumes chunks without accumulating media bytes.
  }
}

export class MockStorageAdapter implements StorageAdapter {
  constructor(private readonly backend: StorageBackend = 'telegram_bot') {}
  async storeOriginal(input: StoreOriginalInput): Promise<StoredFile> {
    await drainWithoutBuffering(input.body)
    return mockStoredFile('mock_original', this.backend)
  }

  async storePreview(input: StorePreviewInput): Promise<StoredFile> {
    await drainWithoutBuffering(input.body)
    return mockStoredFile('mock_preview', this.backend)
  }

  async copyMessage(_fromChatId: string, _messageId: number): Promise<{ messageId: number }> {
    void _fromChatId
    void _messageId
    return { messageId: mockMessageId() }
  }

  async deleteMessage(_messageId: number): Promise<boolean> {
    void _messageId
    return true
  }

  async fetchFile(_fileId: string, _init?: RequestInit): Promise<Response> {
    void _fileId
    void _init
    return new Response(null, { status: 404 })
  }
}
