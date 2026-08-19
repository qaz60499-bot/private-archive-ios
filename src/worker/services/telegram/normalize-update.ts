import { TELEGRAM_GET_FILE_LIMIT, inferMediaType } from '../../domain/policy'
import type { NormalizedTelegramAsset, TelegramFileShape, TelegramMessage, TelegramUpdate } from '../../domain/types'

export type ParsedUpdate =
  | { kind: 'ignored'; reason: string }
  | { kind: 'forbidden'; reason: string }
  | { kind: 'asset'; asset: NormalizedTelegramAsset; needsCopy: boolean }

function normalizeFile(message: TelegramMessage): Omit<NormalizedTelegramAsset, 'message'> | null {
  if (message.photo?.length) {
    const sizes = [...message.photo].sort((left, right) => left.width * left.height - right.width * right.height)
    const photo = sizes.at(-1)!
    const preview = [...sizes].reverse().find((candidate) => candidate.width <= 800 && candidate.height <= 800) ?? sizes[0]
    return {
      mediaType: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id,
      previewFileId: preview.file_id,
      mimeType: 'image/jpeg',
      originalName: `telegram-photo-${message.message_id}.jpg`,
      sizeBytes: photo.file_size ?? 0,
      width: photo.width,
      height: photo.height,
      limited: false,
    }
  }

  const file: TelegramFileShape | undefined = message.video ?? message.document
  if (!file) return null
  const mimeType = file.mime_type ?? 'application/octet-stream'
  const mediaType = message.video ? 'video' : inferMediaType(mimeType)
  const previewFileId = file.thumbnail?.file_id ?? (mediaType === 'photo' && (file.file_size ?? 0) <= TELEGRAM_GET_FILE_LIMIT ? file.file_id : undefined)
  return {
    mediaType,
    fileId: file.file_id,
    fileUniqueId: file.file_unique_id,
    previewFileId,
    mimeType,
    originalName: file.file_name ?? `telegram-${mediaType}-${message.message_id}`,
    sizeBytes: file.file_size ?? 0,
    width: file.width ?? file.thumbnail?.width,
    height: file.height ?? file.thumbnail?.height,
    durationMs: file.duration ? file.duration * 1000 : undefined,
    limited: !previewFileId && (file.file_size ?? 0) > TELEGRAM_GET_FILE_LIMIT,
  }
}

export function parseTelegramUpdate(update: TelegramUpdate, ownerUserId: string, storageChatId: string): ParsedUpdate {
  const isChannelPost = Boolean(update.channel_post)
  const message = update.channel_post ?? update.message
  if (!message) return { kind: 'ignored', reason: 'NO_SUPPORTED_MESSAGE' }

  const chatId = String(message.chat.id)
  if (isChannelPost) {
    if (chatId !== storageChatId) return { kind: 'forbidden', reason: 'CHANNEL_NOT_ALLOWED' }
  } else if (!message.from || String(message.from.id) !== ownerUserId) {
    return { kind: 'forbidden', reason: 'OWNER_NOT_ALLOWED' }
  }

  const normalized = normalizeFile(message)
  if (!normalized) return { kind: 'ignored', reason: 'UNSUPPORTED_MEDIA' }
  return {
    kind: 'asset',
    asset: { ...normalized, message },
    needsCopy: !isChannelPost && chatId !== storageChatId,
  }
}

export function privateChannelMessageUrl(chatId: string, messageId: number): string | null {
  return chatId.startsWith('-100') ? `https://t.me/c/${chatId.slice(4)}/${messageId}` : null
}

