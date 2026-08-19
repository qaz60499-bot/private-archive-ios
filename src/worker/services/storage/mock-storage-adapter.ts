import type { StoredFile } from '../../domain/types'
import type { StorageAdapter, StoreOriginalInput, StorePreviewInput } from './storage-adapter'

function mockMessageId(): number {
  const value = crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff
  return value || 1
}

function mockStoredFile(prefix: string): StoredFile {
  const id = crypto.randomUUID()
  return {
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
  async storeOriginal(input: StoreOriginalInput): Promise<StoredFile> {
    await drainWithoutBuffering(input.body)
    return mockStoredFile('mock_original')
  }

  async storePreview(input: StorePreviewInput): Promise<StoredFile> {
    await drainWithoutBuffering(input.body)
    return mockStoredFile('mock_preview')
  }

  async copyMessage(_fromChatId: string, _messageId: number): Promise<{ messageId: number }> {
    void _fromChatId
    void _messageId
    return { messageId: mockMessageId() }
  }

  async fetchFile(_fileId: string, _init?: RequestInit): Promise<Response> {
    void _fileId
    void _init
    return new Response(null, { status: 404 })
  }
}
