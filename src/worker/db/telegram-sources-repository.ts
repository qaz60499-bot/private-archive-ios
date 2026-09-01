import type { Env } from '../env'
import { decryptSourceSecret, encryptSourceSecret, createSecretToken } from '../lib/source-secrets'
import { getTelegramRuntimeConfig } from './settings-repository'
import { PERSONAL_WORKSPACE_ID } from './assets-repository'

export const LEGACY_TELEGRAM_SOURCE_ID = 'telegram-legacy'

export type TelegramSourceType = 'private_chat' | 'group' | 'channel'
export type TelegramSourceConnectionStatus = 'unconfigured' | 'legacy' | 'verified' | 'bound' | 'disabled' | 'error' | 'disconnected'

export interface TelegramSourceRow {
  id: string
  workspace_id: string
  display_name: string
  bot_user_id: string | null
  bot_username: string | null
  token_ciphertext: string | null
  token_iv: string | null
  webhook_secret_ciphertext: string | null
  webhook_secret_iv: string | null
  chat_id: string | null
  chat_type: string | null
  source_type: TelegramSourceType | null
  enabled: number
  connection_status: TelegramSourceConnectionStatus
  last_sync_at: string | null
  last_error: string | null
  created_at: string
  updated_at: string
}

export interface PublicTelegramSource {
  id: string
  displayName: string
  botUserId: string | null
  botUsername: string | null
  chatId: string | null
  chatType: string | null
  sourceType: TelegramSourceType | null
  enabled: boolean
  connectionStatus: TelegramSourceConnectionStatus
  lastSyncAt: string | null
  lastError: string | null
  tokenConfigured: boolean
  assetCount: number
  storageObjectCount: number
  createdAt: string
  updatedAt: string
}

function toPublic(row: TelegramSourceRow & { asset_count?: number; storage_object_count?: number }, env?: Env): PublicTelegramSource {
  return {
    id: row.id,
    displayName: row.display_name,
    botUserId: row.bot_user_id,
    botUsername: row.bot_username,
    chatId: row.chat_id,
    chatType: row.chat_type,
    sourceType: row.source_type,
    enabled: row.enabled === 1,
    connectionStatus: row.connection_status,
    lastSyncAt: row.last_sync_at,
    lastError: row.last_error,
    tokenConfigured: Boolean(row.token_ciphertext && row.token_iv) || row.id === LEGACY_TELEGRAM_SOURCE_ID && Boolean(env?.TELEGRAM_BOT_TOKEN),
    assetCount: Number(row.asset_count ?? 0),
    storageObjectCount: Number(row.storage_object_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export async function listTelegramSources(db: D1Database, env?: Env): Promise<PublicTelegramSource[]> {
  const rows = await db.prepare(`SELECT telegram_sources.*,
      (SELECT COUNT(*) FROM assets WHERE assets.workspace_id = telegram_sources.workspace_id AND assets.source_id = telegram_sources.id) AS asset_count,
      (SELECT COUNT(*) FROM storage_objects WHERE storage_objects.workspace_id = telegram_sources.workspace_id AND storage_objects.source_id = telegram_sources.id AND storage_objects.delete_state != 'deleted') AS storage_object_count
    FROM telegram_sources WHERE workspace_id = ? ORDER BY created_at, id`)
    .bind(PERSONAL_WORKSPACE_ID).all<TelegramSourceRow & { asset_count: number; storage_object_count: number }>()
  const legacyRuntime = env ? await getTelegramRuntimeConfig(db, env) : null
  return rows.results.map((row) => {
    const item = toPublic(row, env)
    if (row.id !== LEGACY_TELEGRAM_SOURCE_ID || row.chat_id || !legacyRuntime?.storageChatId) return item
    return { ...item, chatId: legacyRuntime.storageChatId, connectionStatus: item.enabled ? 'legacy' : 'disabled' }
  })
}

export async function getTelegramSource(db: D1Database, id: string): Promise<TelegramSourceRow | null> {
  return db.prepare(`SELECT * FROM telegram_sources WHERE id = ? AND workspace_id = ?`)
    .bind(id, PERSONAL_WORKSPACE_ID).first<TelegramSourceRow>()
}

export async function createTelegramSource(db: D1Database, env: Env, input: {
  id: string
  displayName: string
  botUserId: string
  botUsername?: string | null
  botToken: string
}): Promise<PublicTelegramSource> {
  if (!env.MASTER_ENCRYPTION_KEY) throw new Error('MASTER_ENCRYPTION_KEY_NOT_CONFIGURED')
  const now = new Date().toISOString()
  const webhookSecret = createSecretToken(24)
  const [token, webhook] = await Promise.all([
    encryptSourceSecret(env.MASTER_ENCRYPTION_KEY, input.botToken, `telegram-source:${input.id}:bot-token`),
    encryptSourceSecret(env.MASTER_ENCRYPTION_KEY, webhookSecret, `telegram-source:${input.id}:webhook-secret`),
  ])
  await db.prepare(`INSERT INTO telegram_sources (
      id, workspace_id, display_name, bot_user_id, bot_username, token_ciphertext, token_iv,
      webhook_secret_ciphertext, webhook_secret_iv, enabled, connection_status, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'verified', ?, ?)`)
    .bind(input.id, PERSONAL_WORKSPACE_ID, input.displayName, input.botUserId, input.botUsername ?? null,
      token.ciphertext, token.iv, webhook.ciphertext, webhook.iv, now, now).run()
  const row = await getTelegramSource(db, input.id)
  if (!row) throw new Error('TELEGRAM_SOURCE_CREATE_FAILED')
  return toPublic(row, env)
}

export async function bindTelegramSource(db: D1Database, id: string, input: {
  chatId: string
  chatType: string
  sourceType: TelegramSourceType
}): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE telegram_sources SET chat_id = ?, chat_type = ?, source_type = ?,
      connection_status = CASE WHEN enabled = 1 THEN 'bound' ELSE 'disabled' END,
      last_error = NULL, updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .bind(input.chatId, input.chatType, input.sourceType, now, id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function setTelegramSourceEnabled(db: D1Database, id: string, enabled: boolean): Promise<boolean> {
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE telegram_sources SET enabled = ?,
      connection_status = CASE WHEN ? = 1 THEN CASE WHEN chat_id IS NULL THEN 'verified' ELSE 'bound' END ELSE 'disabled' END,
      updated_at = ? WHERE id = ? AND workspace_id = ?`)
    .bind(enabled ? 1 : 0, enabled ? 1 : 0, now, id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function disconnectTelegramSource(db: D1Database, id: string): Promise<boolean> {
  if (id === LEGACY_TELEGRAM_SOURCE_ID) return false
  const now = new Date().toISOString()
  const result = await db.prepare(`UPDATE telegram_sources SET enabled = 0, token_ciphertext = NULL, token_iv = NULL,
      webhook_secret_ciphertext = NULL, webhook_secret_iv = NULL, connection_status = 'disconnected', updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(now, id, PERSONAL_WORKSPACE_ID).run()
  return result.meta.changes > 0
}

export async function recordTelegramSourceError(db: D1Database, id: string, error: string): Promise<void> {
  await db.prepare(`UPDATE telegram_sources SET last_error = ?, connection_status = 'error', updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(error.slice(0, 240), new Date().toISOString(), id, PERSONAL_WORKSPACE_ID).run()
}

export async function touchTelegramSourceSync(db: D1Database, id: string): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(`UPDATE telegram_sources SET last_sync_at = ?, last_error = NULL,
    connection_status = CASE WHEN enabled = 1 AND chat_id IS NOT NULL THEN 'bound' ELSE connection_status END, updated_at = ?
    WHERE id = ? AND workspace_id = ?`).bind(now, now, id, PERSONAL_WORKSPACE_ID).run()
}

async function decryptField(env: Env, row: TelegramSourceRow, kind: 'bot-token' | 'webhook-secret'): Promise<string | null> {
  if (!env.MASTER_ENCRYPTION_KEY) return null
  const ciphertext = kind === 'bot-token' ? row.token_ciphertext : row.webhook_secret_ciphertext
  const iv = kind === 'bot-token' ? row.token_iv : row.webhook_secret_iv
  if (!ciphertext || !iv) return null
  return decryptSourceSecret(env.MASTER_ENCRYPTION_KEY, { ciphertext, iv }, `telegram-source:${row.id}:${kind}`)
}

export async function resolveTelegramSourceToken(db: D1Database, env: Env, sourceId: string): Promise<string> {
  const row = await getTelegramSource(db, sourceId)
  if (!row) throw new Error('TELEGRAM_SOURCE_NOT_FOUND')
  if (sourceId === LEGACY_TELEGRAM_SOURCE_ID && !row.token_ciphertext) {
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')
    return env.TELEGRAM_BOT_TOKEN
  }
  const token = await decryptField(env, row, 'bot-token')
  if (!token) throw new Error('TELEGRAM_SOURCE_TOKEN_NOT_CONFIGURED')
  return token
}

export async function saveTelegramSourceDiscoveredChat(db: D1Database, sourceId: string, chat: {
  id: string
  type: string
  title?: string | null
  username?: string | null
  firstName?: string | null
}): Promise<void> {
  await db.prepare(`INSERT INTO telegram_source_discovered_chats (
      source_id, chat_id, chat_type, title, username, first_name, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(source_id, chat_id) DO UPDATE SET
      chat_type = excluded.chat_type, title = excluded.title, username = excluded.username,
      first_name = excluded.first_name, last_seen_at = excluded.last_seen_at`)
    .bind(sourceId, chat.id, chat.type, chat.title ?? null, chat.username ?? null, chat.firstName ?? null, new Date().toISOString()).run()
}

export async function listTelegramSourceDiscoveredChats(db: D1Database, sourceId: string): Promise<Array<{
  id: string
  type: string
  title: string | null
  username: string | null
  firstName: string | null
}>> {
  const rows = await db.prepare(`SELECT chat_id, chat_type, title, username, first_name
    FROM telegram_source_discovered_chats WHERE source_id = ? ORDER BY last_seen_at DESC LIMIT 100`)
    .bind(sourceId).all<{ chat_id: string; chat_type: string; title: string | null; username: string | null; first_name: string | null }>()
  return rows.results.map((row) => ({ id: row.chat_id, type: row.chat_type, title: row.title, username: row.username, firstName: row.first_name }))
}

export interface TelegramSourceRuntimeConfig {
  sourceId: string
  token: string
  storageChatId: string
  webhookSecret: string | null
  enabled: boolean
  isLegacy: boolean
}

export async function resolveTelegramSourceConfig(db: D1Database, env: Env, sourceId = LEGACY_TELEGRAM_SOURCE_ID): Promise<TelegramSourceRuntimeConfig> {
  const row = await getTelegramSource(db, sourceId)
  if (!row) throw new Error('TELEGRAM_SOURCE_NOT_FOUND')
  if (sourceId === LEGACY_TELEGRAM_SOURCE_ID && !row.token_ciphertext) {
    const legacy = await getTelegramRuntimeConfig(db, env)
    if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')
    const storageChatId = row.chat_id ?? legacy.storageChatId
    if (!storageChatId) throw new Error('TELEGRAM_STORAGE_CHAT_ID_NOT_CONFIGURED')
    return {
      sourceId,
      token: env.TELEGRAM_BOT_TOKEN,
      storageChatId,
      webhookSecret: env.TELEGRAM_WEBHOOK_SECRET ?? null,
      enabled: row.enabled === 1,
      isLegacy: true,
    }
  }
  const token = await decryptField(env, row, 'bot-token')
  if (!token) throw new Error('TELEGRAM_SOURCE_TOKEN_NOT_CONFIGURED')
  if (!row.chat_id) throw new Error('TELEGRAM_SOURCE_CHAT_NOT_CONFIGURED')
  return {
    sourceId,
    token,
    storageChatId: row.chat_id,
    webhookSecret: await decryptField(env, row, 'webhook-secret'),
    enabled: row.enabled === 1,
    isLegacy: false,
  }
}

export async function resolveTelegramWebhookSecret(db: D1Database, env: Env, sourceId: string): Promise<string | null> {
  const row = await getTelegramSource(db, sourceId)
  if (!row) return null
  if (sourceId === LEGACY_TELEGRAM_SOURCE_ID && !row.webhook_secret_ciphertext) return env.TELEGRAM_WEBHOOK_SECRET ?? null
  return decryptField(env, row, 'webhook-secret')
}
