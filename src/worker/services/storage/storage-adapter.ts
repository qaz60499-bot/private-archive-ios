import type { MediaType, StoredFile } from '../../domain/types'

export interface StoreOriginalInput {
  body: ReadableStream<Uint8Array>
  fileName: string
  mimeType: string
  mediaType: MediaType
  sizeBytes: number
}

export interface StorePreviewInput {
  body: ReadableStream<Uint8Array>
  fileName: string
  mimeType: string
}

export interface StorageAdapter {
  storeOriginal(input: StoreOriginalInput): Promise<StoredFile>
  storePreview(input: StorePreviewInput): Promise<StoredFile>
  copyMessage(fromChatId: string, messageId: number): Promise<{ messageId: number }>
  fetchFile(fileId: string, init?: RequestInit): Promise<Response>
}

export interface EncryptionAdapter {
  wrap(input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>>
}

export class NoopEncryptionAdapter implements EncryptionAdapter {
  async wrap(input: ReadableStream<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
    return input
  }
}

