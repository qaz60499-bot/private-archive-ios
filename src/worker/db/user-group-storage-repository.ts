import type { StorageBackend } from '../domain/types'
import { PERSONAL_WORKSPACE_ID } from './assets-repository'

export interface TelegramUserGroupRuntime {
  storageChatId: string | null
  storageChatTitle: string | null
  connectionStatus: 'disconnected' | 'auth_required' | 'connected' | 'syncing' | 'error'
  lastSyncAt: string | null
  lastError: string | null
  lastAckMessageId: number | null
  updatedAt: string
}

export async function getDefaultStorageBackend(db: D1Database): Promise<StorageBackend> {
  const row = await db.prepare(`SELECT value FROM app_settings WHERE key = 'default_storage_backend'`).first<{ value: string }>()
  return row?.value === 'telegram_bot' ? 'telegram_bot' : 'telegram_user_group'
}

export async function setDefaultStorageBackend(db: D1Database, backend: StorageBackend): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES ('default_storage_backend', ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(backend, now).run()
}

export async function getTelegramUserGroupRuntime(db: D1Database): Promise<TelegramUserGroupRuntime> {
  const row = await db.prepare(`SELECT storage_chat_id, storage_chat_title, connection_status, last_sync_at,
      last_error, last_ack_message_id, updated_at
    FROM telegram_user_group_runtime WHERE workspace_id = ?`)
    .bind(PERSONAL_WORKSPACE_ID)
    .first<{
      storage_chat_id: string | null
      storage_chat_title: string | null
      connection_status: TelegramUserGroupRuntime['connectionStatus']
      last_sync_at: string | null
      last_error: string | null
      last_ack_message_id: number | null
      updated_at: string
    }>()
  return row ? {
    storageChatId: row.storage_chat_id,
    storageChatTitle: row.storage_chat_title,
    connectionStatus: row.connection_status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    lastAckMessageId: row.last_ack_message_id,
    updatedAt: row.updated_at,
  } : {
    storageChatId: null,
    storageChatTitle: null,
    connectionStatus: 'disconnected',
    lastSyncAt: null,
    lastError: null,
    lastAckMessageId: null,
    updatedAt: new Date(0).toISOString(),
  }
}

export async function updateTelegramUserGroupRuntime(db: D1Database, patch: {
  storageChatId?: string | null
  storageChatTitle?: string | null
  connectionStatus?: TelegramUserGroupRuntime['connectionStatus']
  lastSyncAt?: string | null
  lastError?: string | null
  lastAckMessageId?: number | null
}): Promise<TelegramUserGroupRuntime> {
  const current = await getTelegramUserGroupRuntime(db)
  const now = new Date().toISOString()
  const next = {
    storageChatId: patch.storageChatId === undefined ? current.storageChatId : patch.storageChatId,
    storageChatTitle: patch.storageChatTitle === undefined ? current.storageChatTitle : patch.storageChatTitle,
    connectionStatus: patch.connectionStatus ?? current.connectionStatus,
    lastSyncAt: patch.lastSyncAt === undefined ? current.lastSyncAt : patch.lastSyncAt,
    lastError: patch.lastError === undefined ? current.lastError : patch.lastError,
    lastAckMessageId: patch.lastAckMessageId === undefined ? current.lastAckMessageId : patch.lastAckMessageId,
  }
  await db.prepare(`INSERT INTO telegram_user_group_runtime (
      workspace_id, storage_chat_id, storage_chat_title, connection_status, last_sync_at, last_error, last_ack_message_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(workspace_id) DO UPDATE SET
      storage_chat_id = excluded.storage_chat_id,
      storage_chat_title = excluded.storage_chat_title,
      connection_status = excluded.connection_status,
      last_sync_at = excluded.last_sync_at,
      last_error = excluded.last_error,
      last_ack_message_id = excluded.last_ack_message_id,
      updated_at = excluded.updated_at`)
    .bind(
      PERSONAL_WORKSPACE_ID, next.storageChatId, next.storageChatTitle, next.connectionStatus,
      next.lastSyncAt, next.lastError, next.lastAckMessageId, now,
    ).run()
  return { ...next, updatedAt: now }
}
