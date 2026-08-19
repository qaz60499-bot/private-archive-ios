import type { Env } from '../../env'
import { isMockMode } from '../../env'
import { TelegramStorageAdapter, requireTelegramConfig } from '../telegram/telegram-client'
import { MockStorageAdapter } from './mock-storage-adapter'
import type { StorageAdapter } from './storage-adapter'

export function createStorageAdapter(env: Env, storageChatIdOverride?: string | null): StorageAdapter {
  if (isMockMode(env)) return new MockStorageAdapter()
  const config = requireTelegramConfig(env, storageChatIdOverride)
  return new TelegramStorageAdapter(config.token, config.storageChatId)
}

