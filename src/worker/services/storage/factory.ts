import type { StorageBackend } from '../../domain/types'
import type { Env } from '../../env'
import { isMockMode } from '../../env'
import { TelegramStorageAdapter, requireTelegramConfig } from '../telegram/telegram-client'
import { MockStorageAdapter } from './mock-storage-adapter'
import type { StorageAdapter } from './storage-adapter'

export function createStorageAdapter(env: Env, storageChatIdOverride?: string | null, mockBackend: StorageBackend = 'telegram_bot'): StorageAdapter {
  if (isMockMode(env)) return new MockStorageAdapter(mockBackend)
  const config = requireTelegramConfig(env, storageChatIdOverride)
  return new TelegramStorageAdapter(config.token, config.storageChatId)
}

export function createStorageAdapterFromConfig(env: Env, config: { token: string; storageChatId: string }, mockBackend: StorageBackend = 'telegram_bot'): StorageAdapter {
  if (isMockMode(env)) return new MockStorageAdapter(mockBackend)
  return new TelegramStorageAdapter(config.token, config.storageChatId)
}

