import type { StoredFile, TelegramFileShape, TelegramMessage } from '../../domain/types'
import type { Env } from '../../env'
import { createStreamingMultipart } from '../storage/multipart'
import type { StorageAdapter, StoreOriginalInput, StorePreviewInput } from '../storage/storage-adapter'

interface TelegramResponse<T> {
  ok: boolean
  result?: T
  description?: string
  parameters?: { retry_after?: number }
}

export class TelegramApiError extends Error {
  constructor(public readonly status: number, public readonly method: string, public readonly retryAfterSeconds?: number, description?: string) {
    super(`TELEGRAM_${method.toUpperCase()}_FAILED:${description ?? status}`)
  }
}

const TELEGRAM_REQUEST_TIMEOUT_MS = 180_000

async function telegramFetch(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TELEGRAM_REQUEST_TIMEOUT_MS)
  try {
    return await fetch(url, { ...init, signal: controller.signal })
  } catch (error) {
    if (controller.signal.aborted) throw new TelegramApiError(504, 'timeout', undefined, 'request timeout')
    throw error
  } finally {
    clearTimeout(timer)
  }
}

function telegramUrl(chatId: string, messageId: number): string | null {
  if (!chatId.startsWith('-100')) return null
  return `https://t.me/c/${chatId.slice(4)}/${messageId}`
}

function extractStoredFile(message: TelegramMessage, chatId: string): StoredFile {
  const richFile = message.document ?? message.video
  let file: TelegramFileShape | undefined = richFile
  if (!file && message.photo?.length) file = message.photo.at(-1)
  if (!file) throw new Error('TELEGRAM_RESPONSE_WITHOUT_FILE')
  return {
    backend: 'telegram_bot',
    chatId,
    messageId: message.message_id,
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    telegramUrl: telegramUrl(chatId, message.message_id),
    previewFileId: richFile?.thumbnail?.file_id,
  }
}

export class TelegramStorageAdapter implements StorageAdapter {
  private readonly apiBase: string

  constructor(private readonly token: string, private readonly storageChatId: string) {
    this.apiBase = `https://api.telegram.org/bot${token}`
  }

  private async callJson<T>(method: string, payload: Record<string, unknown>): Promise<T> {
    const response = await telegramFetch(`${this.apiBase}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const data = await response.json<TelegramResponse<T>>()
    if (!response.ok || !data.ok || data.result === undefined) {
      throw new TelegramApiError(response.status, method, data.parameters?.retry_after, data.description)
    }
    return data.result
  }

  private async sendStream(options: {
    method: 'sendDocument' | 'sendVideo' | 'sendPhoto'
    fileField: 'document' | 'video' | 'photo'
    fileName: string
    mimeType: string
    body: ReadableStream<Uint8Array>
    caption?: string
  }): Promise<StoredFile> {
    const multipart = createStreamingMultipart({
      fields: {
        chat_id: this.storageChatId,
        disable_content_type_detection: 'false',
        ...(options.caption ? { caption: options.caption } : {}),
      },
      fileField: options.fileField,
      fileName: options.fileName,
      mimeType: options.mimeType,
      body: options.body,
    })
    const response = await telegramFetch(`${this.apiBase}/${options.method}`, {
      method: 'POST',
      headers: { 'Content-Type': multipart.contentType },
      body: multipart.body,
    })
    const data = await response.json<TelegramResponse<TelegramMessage>>()
    if (!response.ok || !data.ok || !data.result) {
      throw new TelegramApiError(response.status, options.method, data.parameters?.retry_after, data.description)
    }
    return extractStoredFile(data.result, this.storageChatId)
  }

  async storeOriginal(input: StoreOriginalInput): Promise<StoredFile> {
    const asPlayableVideo = input.mediaType === 'video' && input.mimeType === 'video/mp4'
    return this.sendStream({
      method: asPlayableVideo ? 'sendVideo' : 'sendDocument',
      fileField: asPlayableVideo ? 'video' : 'document',
      fileName: input.fileName,
      mimeType: input.mimeType,
      body: input.body,
      caption: input.manifest,
    })
  }

  async storePreview(input: StorePreviewInput): Promise<StoredFile> {
    return this.sendStream({
      method: 'sendPhoto',
      fileField: 'photo',
      fileName: input.fileName,
      mimeType: input.mimeType,
      body: input.body,
    })
  }

  async copyMessage(fromChatId: string, messageId: number): Promise<{ messageId: number }> {
    const result = await this.callJson<{ message_id: number }>('copyMessage', {
      chat_id: this.storageChatId,
      from_chat_id: fromChatId,
      message_id: messageId,
    })
    return { messageId: result.message_id }
  }

  async deleteMessage(messageId: number): Promise<boolean> {
    try {
      return await this.callJson<boolean>('deleteMessage', { chat_id: this.storageChatId, message_id: messageId })
    } catch (error) {
      if (error instanceof TelegramApiError && error.status === 400 && /message to delete not found/i.test(error.message)) return false
      throw error
    }
  }

  async fetchFile(fileId: string, init?: RequestInit): Promise<Response> {
    const file = await this.callJson<{ file_path?: string }>('getFile', { file_id: fileId })
    if (!file.file_path) throw new Error('TELEGRAM_FILE_PATH_MISSING')
    return fetch(`https://api.telegram.org/file/bot${this.token}/${file.file_path}`, init)
  }
}

export function requireTelegramConfig(env: Env, storageChatIdOverride?: string | null): { token: string; storageChatId: string } {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')
  const storageChatId = storageChatIdOverride ?? env.TELEGRAM_STORAGE_CHAT_ID
  if (!storageChatId) throw new Error('TELEGRAM_STORAGE_CHAT_ID_NOT_CONFIGURED')
  return { token: env.TELEGRAM_BOT_TOKEN, storageChatId }
}
