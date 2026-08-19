import { describe, expect, it } from 'vitest'
import type { TelegramUpdate } from '../../src/worker/domain/types'
import { verifyWebhookSecret } from '../../src/worker/lib/security'
import { parseTelegramUpdate, privateChannelMessageUrl } from '../../src/worker/services/telegram/normalize-update'

const ownerId = '12345'
const storageChatId = '-1009876543210'

function messageUpdate(overrides: Record<string, unknown> = {}): TelegramUpdate {
  return {
    update_id: 1,
    message: {
      message_id: 77,
      date: 1_700_000_000,
      chat: { id: 12345, type: 'private' },
      from: { id: 12345, is_bot: false, first_name: 'Owner' },
      document: {
        file_id: 'file-id',
        file_unique_id: 'unique-id',
        file_name: 'notes.pdf',
        mime_type: 'application/pdf',
        file_size: 1024,
      },
      ...overrides,
    },
  } as TelegramUpdate
}

describe('Telegram update source validation', () => {
  it('accepts an owner private message and marks it for copy to storage', () => {
    const result = parseTelegramUpdate(messageUpdate(), ownerId, storageChatId)
    expect(result.kind).toBe('asset')
    if (result.kind === 'asset') {
      expect(result.needsCopy).toBe(true)
      expect(result.asset.originalName).toBe('notes.pdf')
      expect(result.asset.mediaType).toBe('file')
    }
  })

  it('rejects a private message from another user', () => {
    const result = parseTelegramUpdate(messageUpdate({
      from: { id: 999, is_bot: false, first_name: 'Other' },
    }), ownerId, storageChatId)
    expect(result).toEqual({ kind: 'forbidden', reason: 'OWNER_NOT_ALLOWED' })
  })

  it('accepts only the configured storage channel for channel posts', () => {
    const allowed = {
      update_id: 2,
      channel_post: {
        message_id: 10,
        date: 1_700_000_000,
        chat: { id: Number(storageChatId), type: 'channel' },
        photo: [{ file_id: 'p1', file_unique_id: 'u1', width: 320, height: 240, file_size: 1000 }],
      },
    } as TelegramUpdate
    const denied = {
      ...allowed,
      channel_post: { ...allowed.channel_post!, chat: { id: -1001111111111, type: 'channel' } },
    } as TelegramUpdate

    expect(parseTelegramUpdate(allowed, ownerId, storageChatId).kind).toBe('asset')
    expect(parseTelegramUpdate(denied, ownerId, storageChatId)).toEqual({ kind: 'forbidden', reason: 'CHANNEL_NOT_ALLOWED' })
  })
})

describe('Telegram security helpers', () => {
  it('requires both webhook secrets and an exact match', () => {
    expect(verifyWebhookSecret('secret-value', 'secret-value')).toBe(true)
    expect(verifyWebhookSecret('secret-value', 'other-value')).toBe(false)
    expect(verifyWebhookSecret(undefined, 'secret-value')).toBe(false)
  })

  it('builds private-channel message links only for -100 channel ids', () => {
    expect(privateChannelMessageUrl(storageChatId, 88)).toBe('https://t.me/c/9876543210/88')
    expect(privateChannelMessageUrl('12345', 88)).toBeNull()
  })
})
