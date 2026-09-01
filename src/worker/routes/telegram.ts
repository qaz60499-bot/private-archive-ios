import { Hono, type Context } from 'hono'
import { createTelegramAsset, getStorageObjectStateByFileUniqueId } from '../db/assets-repository'
import {
  getTelegramRuntimeConfig,
  getTelegramWebhookState,
  listTelegramDiscoveredChats,
  saveTelegramDiscoveredChat,
  saveTelegramRuntimeConfig,
  saveTelegramWebhookState,
} from '../db/settings-repository'
import {
  LEGACY_TELEGRAM_SOURCE_ID,
  bindTelegramSource,
  createTelegramSource,
  disconnectTelegramSource,
  getTelegramSource,
  listTelegramSourceDiscoveredChats,
  listTelegramSources,
  recordTelegramSourceError,
  resolveTelegramSourceConfig,
  resolveTelegramSourceToken,
  resolveTelegramWebhookSecret,
  saveTelegramSourceDiscoveredChat,
  setTelegramSourceEnabled,
  touchTelegramSourceSync,
  type TelegramSourceType,
} from '../db/telegram-sources-repository'
import type { MediaType, TelegramUpdate } from '../domain/types'
import type { Env } from '../env'
import { hashToken } from '../lib/crypto'
import { getTelegramUserGroupRuntime, updateTelegramUserGroupRuntime } from '../db/user-group-storage-repository'
import { requireOwner, verifyWebhookSecret } from '../lib/security'
import { readBoundedJsonObject } from '../lib/request-json'
import { createStorageAdapterFromConfig } from '../services/storage/factory'
import { parseTelegramSourceUpdate, parseTelegramUpdate, privateChannelMessageUrl } from '../services/telegram/normalize-update'
import {
  configureTelegramWebhook,
  configureTelegramWebhookWithToken,
  deleteTelegramWebhookWithToken,
  getTelegramWebhookInfo,
  getTelegramWebhookInfoWithToken,
} from '../services/telegram/webhook'

export const telegramRoutes = new Hono<{ Bindings: Env }>()

interface TelegramDiscoveryResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

const MAX_TELEGRAM_WEBHOOK_JSON_BYTES = 1024 * 1024

async function readTelegramWebhookUpdate(request: Request): Promise<TelegramUpdate> {
  return await readBoundedJsonObject(request, MAX_TELEGRAM_WEBHOOK_JSON_BYTES) as unknown as TelegramUpdate
}

function webhookBodyError(error: unknown): { code: 'REQUEST_BODY_INVALID' | 'REQUEST_BODY_TOO_LARGE'; status: 400 | 413 } {
  return error instanceof Error && error.message === 'REQUEST_BODY_TOO_LARGE'
    ? { code: 'REQUEST_BODY_TOO_LARGE', status: 413 }
    : { code: 'REQUEST_BODY_INVALID', status: 400 }
}

async function telegramJson<T>(token: string, method: string): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`)
  const body = await response.json<TelegramDiscoveryResponse<T>>()
  if (!response.ok || !body.ok || body.result === undefined) {
    throw new Error(`TELEGRAM_${method.toUpperCase().replaceAll(/[^A-Z0-9]+/g, '_')}_FAILED:${body.description ?? response.status}`)
  }
  return body.result
}

function sourceWebhookUrl(env: Env, sourceId: string): string | null {
  if (!env.TELEGRAM_WEBHOOK_URL) return null
  try {
    const url = new URL(env.TELEGRAM_WEBHOOK_URL)
    url.pathname = `/api/telegram/webhook/${encodeURIComponent(sourceId)}`
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

function sourceTypeFromChat(chatType: string): TelegramSourceType | null {
  if (chatType === 'private') return 'private_chat'
  if (chatType === 'channel') return 'channel'
  if (chatType === 'group' || chatType === 'supergroup') return 'group'
  return null
}

const WEBHOOK_UPDATE_CLAIM_PREFIX = 'processing|'
const WEBHOOK_UPDATE_CLAIM_STALE_MS = 5 * 60_000

type WebhookUpdateClaim =
  | { state: 'claimed'; token: string; messageId: number | null }
  | { state: 'processing' }
  | { state: 'processed' }

function webhookClaimToken(startedAt = Date.now()): string {
  return `${WEBHOOK_UPDATE_CLAIM_PREFIX}${startedAt}|${crypto.randomUUID()}`
}

function webhookClaimStartedAt(value: string): number | null {
  if (!value.startsWith(WEBHOOK_UPDATE_CLAIM_PREFIX)) return null
  const separator = value.indexOf('|', WEBHOOK_UPDATE_CLAIM_PREFIX.length)
  if (separator < 0) return 0
  const startedAt = Number(value.slice(WEBHOOK_UPDATE_CLAIM_PREFIX.length, separator))
  return Number.isFinite(startedAt) ? startedAt : 0
}

async function claimSourceUpdate(db: D1Database, sourceId: string, updateId: number): Promise<WebhookUpdateClaim> {
  const token = webhookClaimToken()
  const inserted = await db.prepare(`INSERT OR IGNORE INTO telegram_source_updates (source_id, update_id, message_id, processed_at)
    VALUES (?, ?, NULL, ?)`).bind(sourceId, updateId, token).run()
  if (inserted.meta.changes > 0) return { state: 'claimed', token, messageId: null }

  const existing = await db.prepare(`SELECT message_id, processed_at FROM telegram_source_updates WHERE source_id = ? AND update_id = ?`)
    .bind(sourceId, updateId).first<{ message_id: number | null; processed_at: string }>()
  if (!existing) return { state: 'processing' }
  const startedAt = webhookClaimStartedAt(existing.processed_at)
  if (startedAt === null) return { state: 'processed' }
  if (Date.now() - startedAt < WEBHOOK_UPDATE_CLAIM_STALE_MS) return { state: 'processing' }

  const stolen = await db.prepare(`UPDATE telegram_source_updates SET processed_at = ?
    WHERE source_id = ? AND update_id = ? AND processed_at = ?`)
    .bind(token, sourceId, updateId, existing.processed_at).run()
  return stolen.meta.changes > 0
    ? { state: 'claimed', token, messageId: existing.message_id }
    : { state: 'processing' }
}

async function setSourceClaimMessage(db: D1Database, sourceId: string, updateId: number, claimToken: string, messageId: number): Promise<void> {
  const updated = await db.prepare(`UPDATE telegram_source_updates SET message_id = ?
    WHERE source_id = ? AND update_id = ? AND processed_at = ?`).bind(messageId, sourceId, updateId, claimToken).run()
  if (updated.meta.changes === 0) throw new Error('TELEGRAM_UPDATE_CLAIM_LOST')
}

async function finishSourceUpdate(db: D1Database, sourceId: string, updateId: number, claimToken: string, messageId?: number): Promise<void> {
  const updated = await db.prepare(`UPDATE telegram_source_updates SET message_id = COALESCE(?, message_id), processed_at = ?
    WHERE source_id = ? AND update_id = ? AND processed_at = ?`)
    .bind(messageId ?? null, new Date().toISOString(), sourceId, updateId, claimToken).run()
  if (updated.meta.changes === 0) throw new Error('TELEGRAM_UPDATE_CLAIM_LOST')
}

async function retrySourceUpdate(db: D1Database, sourceId: string, updateId: number, claimToken: string): Promise<void> {
  await db.prepare(`UPDATE telegram_source_updates SET processed_at = ?
    WHERE source_id = ? AND update_id = ? AND processed_at = ?`)
    .bind(webhookClaimToken(0), sourceId, updateId, claimToken).run()
}

async function claimLegacyUpdate(db: D1Database, updateId: number): Promise<WebhookUpdateClaim> {
  const token = webhookClaimToken()
  const inserted = await db.prepare(`INSERT OR IGNORE INTO telegram_updates (update_id, message_id, processed_at) VALUES (?, NULL, ?)`)
    .bind(updateId, token).run()
  if (inserted.meta.changes > 0) return { state: 'claimed', token, messageId: null }

  const existing = await db.prepare(`SELECT message_id, processed_at FROM telegram_updates WHERE update_id = ?`)
    .bind(updateId).first<{ message_id: number | null; processed_at: string }>()
  if (!existing) return { state: 'processing' }
  const startedAt = webhookClaimStartedAt(existing.processed_at)
  if (startedAt === null) return { state: 'processed' }
  if (Date.now() - startedAt < WEBHOOK_UPDATE_CLAIM_STALE_MS) return { state: 'processing' }

  const stolen = await db.prepare(`UPDATE telegram_updates SET processed_at = ? WHERE update_id = ? AND processed_at = ?`)
    .bind(token, updateId, existing.processed_at).run()
  return stolen.meta.changes > 0
    ? { state: 'claimed', token, messageId: existing.message_id }
    : { state: 'processing' }
}

async function setLegacyClaimMessage(db: D1Database, updateId: number, claimToken: string, messageId: number): Promise<void> {
  const updated = await db.prepare(`UPDATE telegram_updates SET message_id = ? WHERE update_id = ? AND processed_at = ?`)
    .bind(messageId, updateId, claimToken).run()
  if (updated.meta.changes === 0) throw new Error('TELEGRAM_UPDATE_CLAIM_LOST')
}

async function finishLegacyUpdate(db: D1Database, updateId: number, claimToken: string, messageId?: number): Promise<void> {
  const updated = await db.prepare(`UPDATE telegram_updates SET message_id = COALESCE(?, message_id), processed_at = ?
    WHERE update_id = ? AND processed_at = ?`).bind(messageId ?? null, new Date().toISOString(), updateId, claimToken).run()
  if (updated.meta.changes === 0) throw new Error('TELEGRAM_UPDATE_CLAIM_LOST')
}

async function retryLegacyUpdate(db: D1Database, updateId: number, claimToken: string): Promise<void> {
  await db.prepare(`UPDATE telegram_updates SET processed_at = ? WHERE update_id = ? AND processed_at = ?`)
    .bind(webhookClaimToken(0), updateId, claimToken).run()
}

telegramRoutes.get('/sources', requireOwner, async (context) => {
  return context.json({ items: await listTelegramSources(context.env.DB, context.env) })
})

telegramRoutes.post('/sources', requireOwner, async (context) => {
  const body = await context.req.json<{ displayName?: unknown; botToken?: unknown }>()
  const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : ''
  const botToken = typeof body.botToken === 'string' ? body.botToken.trim() : ''
  if (!displayName || displayName.length > 80) return context.json({ error: 'TELEGRAM_SOURCE_NAME_INVALID' }, 400)
  if (!botToken || botToken.length < 20 || botToken.length > 256) return context.json({ error: 'TELEGRAM_BOT_TOKEN_INVALID' }, 400)
  if (!context.env.MASTER_ENCRYPTION_KEY) return context.json({ error: 'MASTER_ENCRYPTION_KEY_NOT_CONFIGURED' }, 503)

  try {
    const bot = context.env.MOCK_TELEGRAM === 'true'
      ? { id: (await hashToken(botToken)).slice(0, 16), username: `mock_${(await hashToken(botToken)).slice(0, 8)}`, first_name: 'Mock Source Bot' }
      : await telegramJson<{ id: number; username?: string; first_name?: string }>(botToken, 'getMe')
    const sourceId = crypto.randomUUID()
    const item = await createTelegramSource(context.env.DB, context.env, {
      id: sourceId,
      displayName,
      botUserId: String(bot.id),
      botUsername: bot.username ?? null,
      botToken,
    })

    const webhookUrl = sourceWebhookUrl(context.env, sourceId)
    if (webhookUrl && context.env.MOCK_TELEGRAM !== 'true') {
      try {
        const secret = await resolveTelegramWebhookSecret(context.env.DB, context.env, sourceId)
        if (!secret) throw new Error('TELEGRAM_SOURCE_WEBHOOK_SECRET_MISSING')
        await configureTelegramWebhookWithToken(botToken, secret, webhookUrl)
      } catch (error) {
        await recordTelegramSourceError(context.env.DB, sourceId, error instanceof Error ? error.message : 'TELEGRAM_WEBHOOK_CONFIGURE_FAILED')
      }
    }
    const current = (await listTelegramSources(context.env.DB, context.env)).find((source) => source.id === sourceId) ?? item
    return context.json({ item: current, webhookConfigured: Boolean(webhookUrl) }, 201)
  } catch (error) {
    const message = error instanceof Error ? error.message : 'TELEGRAM_SOURCE_CREATE_FAILED'
    if (/UNIQUE constraint failed/i.test(message)) return context.json({ error: 'TELEGRAM_BOT_ALREADY_CONFIGURED' }, 409)
    const publicCode = message.startsWith('TELEGRAM_') ? message.split(':', 1)[0] : 'TELEGRAM_SOURCE_CREATE_FAILED'
    return context.json({ error: publicCode }, 502)
  }
})

telegramRoutes.get('/sources/:id/discover', requireOwner, async (context) => {
  const source = await getTelegramSource(context.env.DB, context.req.param('id') ?? '')
  if (!source) return context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
  const chats = await listTelegramSourceDiscoveredChats(context.env.DB, source.id)
  return context.json({
    source: {
      id: source.id,
      displayName: source.display_name,
      botUsername: source.bot_username,
      connectionStatus: source.connection_status,
    },
    chats,
  })
})

telegramRoutes.post('/sources/:id/bind', requireOwner, async (context) => {
  const sourceId = context.req.param('id') ?? ''
  const body = await context.req.json<{ chatId?: unknown }>()
  const chatId = typeof body.chatId === 'string' ? body.chatId.trim() : ''
  if (!/^-?\d+$/.test(chatId)) return context.json({ error: 'TELEGRAM_CHAT_ID_INVALID' }, 400)
  const source = await getTelegramSource(context.env.DB, sourceId)
  if (!source) return context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
  try {
    let chat: { id: number | string; type: string; title?: string; username?: string; first_name?: string }
    if (context.env.MOCK_TELEGRAM === 'true') {
      chat = { id: chatId, type: chatId.startsWith('-100') ? 'channel' : chatId.startsWith('-') ? 'group' : 'private', title: 'Mock Chat' }
    } else {
      const token = await resolveTelegramSourceToken(context.env.DB, context.env, sourceId)
      chat = await telegramJson<typeof chat>(token, `getChat?chat_id=${encodeURIComponent(chatId)}`)
    }
    const sourceType = sourceTypeFromChat(chat.type)
    if (!sourceType) return context.json({ error: 'TELEGRAM_CHAT_TYPE_UNSUPPORTED' }, 400)
    await saveTelegramSourceDiscoveredChat(context.env.DB, sourceId, {
      id: String(chat.id), type: chat.type, title: chat.title ?? null, username: chat.username ?? null, firstName: chat.first_name ?? null,
    })
    const updated = await bindTelegramSource(context.env.DB, sourceId, { chatId: String(chat.id), chatType: chat.type, sourceType })
    if (!updated) return context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
    const item = (await listTelegramSources(context.env.DB, context.env)).find((entry) => entry.id === sourceId)
    return context.json({ ok: true, item })
  } catch (error) {
    await recordTelegramSourceError(context.env.DB, sourceId, error instanceof Error ? error.message : 'TELEGRAM_SOURCE_BIND_FAILED')
    return context.json({ error: 'TELEGRAM_SOURCE_BIND_FAILED' }, 502)
  }
})

telegramRoutes.post('/sources/:id/enabled', requireOwner, async (context) => {
  const body = await context.req.json<{ enabled?: unknown }>()
  if (typeof body.enabled !== 'boolean') return context.json({ error: 'TELEGRAM_SOURCE_ENABLED_INVALID' }, 400)
  const updated = await setTelegramSourceEnabled(context.env.DB, context.req.param('id') ?? '', body.enabled)
  return updated ? context.json({ ok: true, enabled: body.enabled }) : context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
})

telegramRoutes.post('/sources/:id/disconnect', requireOwner, async (context) => {
  const sourceId = context.req.param('id') ?? ''
  if (sourceId === LEGACY_TELEGRAM_SOURCE_ID) return context.json({ error: 'LEGACY_SOURCE_CANNOT_DISCONNECT' }, 409)
  const source = await getTelegramSource(context.env.DB, sourceId)
  if (!source) return context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
  if (context.env.MOCK_TELEGRAM !== 'true') {
    try {
      const token = await resolveTelegramSourceToken(context.env.DB, context.env, sourceId)
      await deleteTelegramWebhookWithToken(token)
    } catch {
      // Disconnect remains safe even if Telegram is temporarily unavailable; Worker rejects future ingest.
    }
  }
  const disconnected = await disconnectTelegramSource(context.env.DB, sourceId)
  return disconnected ? context.json({ ok: true, telegramFilesDeleted: false }) : context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
})

telegramRoutes.post('/sources/:id/webhook/configure', requireOwner, async (context) => {
  const sourceId = context.req.param('id') ?? ''
  const webhookUrl = sourceWebhookUrl(context.env, sourceId)
  if (!webhookUrl) return context.json({ error: 'TELEGRAM_WEBHOOK_URL_NOT_CONFIGURED' }, 503)
  try {
    const token = await resolveTelegramSourceToken(context.env.DB, context.env, sourceId)
    const secret = await resolveTelegramWebhookSecret(context.env.DB, context.env, sourceId)
    if (!secret) return context.json({ error: 'TELEGRAM_SOURCE_WEBHOOK_SECRET_NOT_CONFIGURED' }, 503)
    if (context.env.MOCK_TELEGRAM === 'true') return context.json({ ok: true, webhook: { url: webhookUrl }, expectedUrl: webhookUrl })
    const info = await configureTelegramWebhookWithToken(token, secret, webhookUrl)
    return context.json({ ok: true, webhook: info, expectedUrl: webhookUrl })
  } catch (error) {
    await recordTelegramSourceError(context.env.DB, sourceId, error instanceof Error ? error.message : 'TELEGRAM_WEBHOOK_CONFIGURE_FAILED')
    return context.json({ error: 'TELEGRAM_WEBHOOK_CONFIGURE_FAILED' }, 502)
  }
})

telegramRoutes.get('/sources/:id/webhook/status', requireOwner, async (context) => {
  const sourceId = context.req.param('id') ?? ''
  try {
    const token = await resolveTelegramSourceToken(context.env.DB, context.env, sourceId)
    const expectedUrl = sourceWebhookUrl(context.env, sourceId)
    if (context.env.MOCK_TELEGRAM === 'true') return context.json({ webhook: { url: expectedUrl ?? '' }, expectedUrl })
    return context.json({ webhook: await getTelegramWebhookInfoWithToken(token), expectedUrl })
  } catch {
    return context.json({ error: 'TELEGRAM_WEBHOOK_STATUS_FAILED' }, 502)
  }
})

// Legacy owner/source discovery remains available so the existing production source can
// be managed without rotating the current Worker secrets during migration.
telegramRoutes.get('/discover', requireOwner, async (context) => {
  const token = context.env.TELEGRAM_BOT_TOKEN
  if (!token && context.env.MOCK_TELEGRAM !== 'true') return context.json({ error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' }, 503)
  try {
    const botPromise = context.env.MOCK_TELEGRAM === 'true'
      ? Promise.resolve({ id: 0, username: 'mock_archive_bot', first_name: 'Mock Archive Bot' })
      : telegramJson<{ id: number; username?: string; first_name?: string }>(token!, 'getMe')
    const [bot, chats] = await Promise.all([botPromise, listTelegramDiscoveredChats(context.env.DB)])
    return context.json({ bot: { id: String(bot.id), username: bot.username ?? null, firstName: bot.first_name ?? null }, chats })
  } catch {
    return context.json({ error: 'TELEGRAM_DISCOVERY_FAILED' }, 502)
  }
})

telegramRoutes.post('/configure', requireOwner, async (context) => {
  const body = await context.req.json<{ chatId?: unknown; role?: unknown }>()
  if (typeof body.chatId !== 'string' || !/^-?\d+$/.test(body.chatId)) return context.json({ error: 'TELEGRAM_CHAT_ID_INVALID' }, 400)
  if (!['owner', 'storage', 'both'].includes(String(body.role))) return context.json({ error: 'TELEGRAM_CONFIG_ROLE_INVALID' }, 400)
  const role = String(body.role)
  await saveTelegramRuntimeConfig(context.env.DB, {
    ownerUserId: role === 'owner' || role === 'both' ? body.chatId : undefined,
    storageChatId: role === 'storage' || role === 'both' ? body.chatId : undefined,
  })
  const config = await getTelegramRuntimeConfig(context.env.DB, context.env)
  return context.json({ ok: true, ownerUserId: config.ownerUserId, storageChatId: config.storageChatId })
})

telegramRoutes.post('/webhook/configure', requireOwner, async (context) => {
  const webhookUrl = context.env.TELEGRAM_WEBHOOK_URL
  if (!webhookUrl) return context.json({ error: 'TELEGRAM_WEBHOOK_URL_NOT_CONFIGURED' }, 503)
  try {
    const info = await configureTelegramWebhook(context.env, webhookUrl)
    await saveTelegramWebhookState(context.env.DB, { url: info.url, status: info.url === webhookUrl ? 'active' : 'mismatch' })
    return context.json({ ok: true, webhook: info })
  } catch {
    return context.json({ error: 'TELEGRAM_WEBHOOK_CONFIGURE_FAILED' }, 502)
  }
})

telegramRoutes.get('/webhook/status', requireOwner, async (context) => {
  try {
    const [remote, saved] = await Promise.all([getTelegramWebhookInfo(context.env), getTelegramWebhookState(context.env.DB)])
    return context.json({ webhook: remote, saved, expectedUrl: context.env.TELEGRAM_WEBHOOK_URL ?? null })
  } catch {
    return context.json({ error: 'TELEGRAM_WEBHOOK_STATUS_FAILED' }, 502)
  }
})

telegramRoutes.post('/user-group/runtime', requireOwner, async (context) => {
  const body = await context.req.json<{
    connectionStatus?: unknown
    storageChatId?: unknown
    storageChatTitle?: unknown
    lastSyncAt?: unknown
    lastError?: unknown
    lastAckMessageId?: unknown
  }>()
  const connectionStatus = String(body.connectionStatus ?? '')
  if (!['disconnected', 'auth_required', 'connected', 'syncing', 'error'].includes(connectionStatus)) {
    return context.json({ error: 'INVALID_TELEGRAM_USER_GROUP_STATUS' }, 400)
  }
  const storageChatId = body.storageChatId === null || body.storageChatId === undefined ? null : String(body.storageChatId).trim()
  const storageChatTitle = body.storageChatTitle === null || body.storageChatTitle === undefined ? null : String(body.storageChatTitle).trim()
  if (storageChatId !== null && !/^-?\d{1,24}$/.test(storageChatId)) return context.json({ error: 'TELEGRAM_CHAT_ID_INVALID' }, 400)
  if (['connected', 'syncing'].includes(connectionStatus)) {
    if (!storageChatId) return context.json({ error: 'TELEGRAM_STORAGE_CHAT_NOT_RESOLVED' }, 409)
    if (storageChatTitle !== 'ai') return context.json({ error: 'TELEGRAM_STORAGE_CHAT_TITLE_MISMATCH' }, 409)
  }
  const lastAckMessageId = body.lastAckMessageId === null || body.lastAckMessageId === undefined ? null : Number(body.lastAckMessageId)
  if (lastAckMessageId !== null && (!Number.isSafeInteger(lastAckMessageId) || lastAckMessageId < 0)) {
    return context.json({ error: 'INVALID_TELEGRAM_CHECKPOINT' }, 400)
  }
  const lastSyncAt = body.lastSyncAt === null || body.lastSyncAt === undefined ? null : String(body.lastSyncAt)
  if (lastSyncAt !== null && Number.isNaN(Date.parse(lastSyncAt))) return context.json({ error: 'INVALID_TELEGRAM_SYNC_TIME' }, 400)
  const lastError = body.lastError === null || body.lastError === undefined ? null : String(body.lastError).slice(0, 320)
  const runtime = await updateTelegramUserGroupRuntime(context.env.DB, {
    connectionStatus: connectionStatus as 'disconnected' | 'auth_required' | 'connected' | 'syncing' | 'error',
    storageChatId,
    storageChatTitle,
    lastSyncAt,
    lastError,
    lastAckMessageId,
  })
  return context.json({ ok: true, runtime })
})

const MAX_USER_GROUP_IMPORT_JSON_BYTES = 256 * 1024

telegramRoutes.post('/user-group/import', requireOwner, async (context) => {
  let body: Record<string, unknown>
  try {
    body = await readBoundedJsonObject(context.req.raw, MAX_USER_GROUP_IMPORT_JSON_BYTES)
  } catch (error) {
    const code = error instanceof Error ? error.message : 'REQUEST_BODY_INVALID'
    return context.json({ error: code === 'REQUEST_BODY_TOO_LARGE' ? code : 'REQUEST_BODY_INVALID' }, code === 'REQUEST_BODY_TOO_LARGE' ? 413 : 400)
  }
  if (!Array.isArray(body.items) || body.items.length < 1 || body.items.length > 100) {
    return context.json({ error: 'INVALID_TELEGRAM_IMPORT_BATCH' }, 400)
  }
  const runtime = await getTelegramUserGroupRuntime(context.env.DB)
  if (!runtime.storageChatId || runtime.storageChatTitle !== 'ai') {
    return context.json({ error: 'TELEGRAM_STORAGE_CHAT_NOT_RESOLVED' }, 409)
  }

  let created = 0
  let duplicate = 0
  let maxMessageId = runtime.lastAckMessageId ?? 0
  const results: Array<{ messageId: number; created: boolean; assetId?: string; error?: string }> = []
  for (const raw of body.items) {
    if (!raw || typeof raw !== 'object') return context.json({ error: 'INVALID_TELEGRAM_IMPORT_ITEM' }, 400)
    const item = raw as Record<string, unknown>
    const chatId = String(item.chatId ?? '').trim()
    const messageId = Number(item.messageId)
    const fileName = String(item.fileName ?? '').trim()
    const mimeType = String(item.mimeType ?? 'application/octet-stream').trim().toLowerCase()
    const sizeBytes = Number(item.sizeBytes)
    const mediaType = String(item.mediaType ?? 'file')
    const mediaId = item.mediaId === null || item.mediaId === undefined ? null : String(item.mediaId).trim()
    const takenAt = String(item.takenAt ?? '')
    if (chatId !== runtime.storageChatId || !Number.isSafeInteger(messageId) || messageId <= 0 || messageId > 2_147_483_647) {
      return context.json({ error: 'TELEGRAM_IMPORT_MESSAGE_ID_INVALID' }, 400)
    }
    if (!fileName || fileName.length > 255 || mimeType.length > 160 || !Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      return context.json({ error: 'TELEGRAM_IMPORT_FILE_INVALID' }, 400)
    }
    if (!['photo', 'video', 'file'].includes(mediaType)) return context.json({ error: 'TELEGRAM_IMPORT_MEDIA_TYPE_INVALID' }, 400)
    if (mediaId !== null && (!mediaId || mediaId.length > 160)) return context.json({ error: 'TELEGRAM_IMPORT_MEDIA_ID_INVALID' }, 400)
    if (Number.isNaN(Date.parse(takenAt))) return context.json({ error: 'TELEGRAM_IMPORT_DATE_INVALID' }, 400)

    try {
      const result = await createTelegramAsset(context.env.DB, {
        id: crypto.randomUUID(),
        sourceId: LEGACY_TELEGRAM_SOURCE_ID,
        source: 'telegram',
        storageBackend: 'telegram_user_group',
        importOrigin: 'telegram_user_group',
        telegramMediaId: mediaId,
        mediaType: mediaType as MediaType,
        mimeType,
        originalName: fileName,
        sizeBytes,
        width: typeof item.width === 'number' && Number.isFinite(item.width) ? item.width : undefined,
        height: typeof item.height === 'number' && Number.isFinite(item.height) ? item.height : undefined,
        durationMs: typeof item.durationMs === 'number' && Number.isFinite(item.durationMs) ? item.durationMs : undefined,
        takenAt: new Date(takenAt).toISOString(),
        chatId,
        messageId,
        fileId: `mtproto-message:${messageId}`,
        fileUniqueId: `mtproto-message:${chatId}:${messageId}`,
        status: 'ready',
        telegramUrl: null,
      })
      if (result.created) created += 1
      else duplicate += 1
      maxMessageId = Math.max(maxMessageId, messageId)
      results.push({ messageId, created: result.created, assetId: result.id })
    } catch {
      results.push({ messageId, created: false, error: 'TELEGRAM_IMPORT_FAILED' })
    }
  }
  const failed = results.filter((item) => item.error).length
  if (!failed) {
    await updateTelegramUserGroupRuntime(context.env.DB, {
      connectionStatus: 'connected',
      lastSyncAt: new Date().toISOString(),
      lastError: null,
      lastAckMessageId: maxMessageId,
    })
  }
  return context.json({ ok: failed === 0, created, duplicate, failed, results }, failed ? 207 : 200)
})

async function handleSourceWebhook(context: Context<{ Bindings: Env }>, sourceId: string) {
  const source = await getTelegramSource(context.env.DB, sourceId)
  if (!source) return context.json({ error: 'TELEGRAM_SOURCE_NOT_FOUND' }, 404)
  const expectedSecret = context.env.MOCK_TELEGRAM === 'true' ? 'local-webhook-secret' : await resolveTelegramWebhookSecret(context.env.DB, context.env, sourceId)
  if (!verifyWebhookSecret(context.req.header('X-Telegram-Bot-Api-Secret-Token'), expectedSecret ?? undefined)) {
    return context.json({ error: 'WEBHOOK_SECRET_INVALID' }, 401)
  }
  if (source.enabled !== 1) return context.json({ ok: true, ignored: 'TELEGRAM_SOURCE_DISABLED' }, 200)

  let update: TelegramUpdate
  try {
    update = await readTelegramWebhookUpdate(context.req.raw)
  } catch (error) {
    const bodyError = webhookBodyError(error)
    return context.json({ error: bodyError.code }, bodyError.status)
  }
  if (!Number.isSafeInteger(update.update_id)) return context.json({ error: 'UPDATE_ID_INVALID' }, 400)
  const message = update.message ?? update.channel_post
  if (message?.chat && Number.isSafeInteger(message.chat.id) && message.chat.type) {
    await saveTelegramSourceDiscoveredChat(context.env.DB, sourceId, {
      id: String(message.chat.id), type: message.chat.type, title: message.chat.title ?? null,
      username: message.chat.username ?? null, firstName: message.chat.first_name ?? null,
    })
  }

  const claim = await claimSourceUpdate(context.env.DB, sourceId, update.update_id)
  if (claim.state === 'processed') return context.json({ ok: true, duplicate: true })
  if (claim.state === 'processing') {
    context.header('Retry-After', '1')
    return context.json({ error: 'TELEGRAM_UPDATE_IN_PROGRESS', recoverable: true }, 409)
  }

  try {
    if (!source.chat_id) {
      await finishSourceUpdate(context.env.DB, sourceId, update.update_id, claim.token, message?.message_id)
      return context.json({ ok: true, discovered: Boolean(message?.chat), ignored: 'TELEGRAM_SOURCE_CHAT_NOT_CONFIGURED' })
    }

    const parsed = parseTelegramSourceUpdate(update, source.chat_id)
    if (parsed.kind === 'forbidden') {
      await finishSourceUpdate(context.env.DB, sourceId, update.update_id, claim.token, message?.message_id)
      return context.json({ error: parsed.reason }, 403)
    }
    if (parsed.kind === 'ignored') {
      await finishSourceUpdate(context.env.DB, sourceId, update.update_id, claim.token)
      return context.json({ ok: true, ignored: parsed.reason })
    }
    const sourceMessage = parsed.asset.message
    await setSourceClaimMessage(context.env.DB, sourceId, update.update_id, claim.token, sourceMessage.message_id)
    const storageObjectState = await getStorageObjectStateByFileUniqueId(context.env.DB, parsed.asset.fileUniqueId, sourceId)
    if (storageObjectState?.deleteState === 'deleting' || storageObjectState?.deleteState === 'delete_failed') {
      await retrySourceUpdate(context.env.DB, sourceId, update.update_id, claim.token)
      context.header('Retry-After', '1')
      return context.json({ error: 'STORAGE_OBJECT_DELETE_IN_PROGRESS', recoverable: true }, 409)
    }
    const status = parsed.asset.limited ? 'limited' : parsed.asset.previewFileId ? 'queued' : 'ready'
    const result = await createTelegramAsset(context.env.DB, {
      id: crypto.randomUUID(), sourceId, source: context.env.MOCK_TELEGRAM === 'true' ? 'mock' : 'telegram',
      mediaType: parsed.asset.mediaType, mimeType: parsed.asset.mimeType, originalName: parsed.asset.originalName,
      sizeBytes: parsed.asset.sizeBytes, width: parsed.asset.width, height: parsed.asset.height, durationMs: parsed.asset.durationMs,
      takenAt: new Date(sourceMessage.date * 1000).toISOString(), chatId: source.chat_id, messageId: sourceMessage.message_id,
      fileId: parsed.asset.fileId, fileUniqueId: parsed.asset.fileUniqueId, previewFileId: parsed.asset.previewFileId,
      status, telegramUrl: privateChannelMessageUrl(source.chat_id, sourceMessage.message_id),
    })
    await touchTelegramSourceSync(context.env.DB, sourceId)
    if (status === 'queued') {
      await context.env.ANALYSIS_QUEUE.send({ assetId: result.id, previewFileId: parsed.asset.previewFileId, jobType: 'analyze' })
    }
    await finishSourceUpdate(context.env.DB, sourceId, update.update_id, claim.token, sourceMessage.message_id)
    return context.json({ ok: true, created: result.created, assetId: result.id }, result.created ? 201 : 200)
  } catch (error) {
    await retrySourceUpdate(context.env.DB, sourceId, update.update_id, claim.token).catch(() => undefined)
    throw error
  }
}

telegramRoutes.post('/webhook/:sourceId', async (context) => handleSourceWebhook(context, context.req.param('sourceId') ?? ''))

telegramRoutes.post('/webhook', async (context) => {
  const expectedSecret = context.env.MOCK_TELEGRAM === 'true' ? 'local-webhook-secret' : context.env.TELEGRAM_WEBHOOK_SECRET
  if (!verifyWebhookSecret(context.req.header('X-Telegram-Bot-Api-Secret-Token'), expectedSecret)) {
    return context.json({ error: 'WEBHOOK_SECRET_INVALID' }, 401)
  }
  let update: TelegramUpdate
  try {
    update = await readTelegramWebhookUpdate(context.req.raw)
  } catch (error) {
    const bodyError = webhookBodyError(error)
    return context.json({ error: bodyError.code }, bodyError.status)
  }
  if (!Number.isSafeInteger(update.update_id)) return context.json({ error: 'UPDATE_ID_INVALID' }, 400)
  const discoveryMessage = update.message ?? update.channel_post
  if (discoveryMessage?.chat && Number.isSafeInteger(discoveryMessage.chat.id) && discoveryMessage.chat.type) {
    await saveTelegramDiscoveredChat(context.env.DB, {
      id: String(discoveryMessage.chat.id), type: discoveryMessage.chat.type, title: discoveryMessage.chat.title ?? null,
      username: discoveryMessage.chat.username ?? null, firstName: discoveryMessage.chat.first_name ?? null,
    })
  }

  const claim = await claimLegacyUpdate(context.env.DB, update.update_id)
  if (claim.state === 'processed') return context.json({ ok: true, duplicate: true })
  if (claim.state === 'processing') {
    context.header('Retry-After', '1')
    return context.json({ error: 'TELEGRAM_UPDATE_IN_PROGRESS', recoverable: true }, 409)
  }

  try {
    const runtimeConfig = await getTelegramRuntimeConfig(context.env.DB, context.env)
    const ownerUserId = context.env.MOCK_TELEGRAM === 'true' ? '10001' : runtimeConfig.ownerUserId
    const storageChatId = context.env.MOCK_TELEGRAM === 'true' ? '-1000000000000' : runtimeConfig.storageChatId
    if (!ownerUserId || !storageChatId) {
      await finishLegacyUpdate(context.env.DB, update.update_id, claim.token, discoveryMessage?.message_id)
      return context.json({ ok: true, discovered: Boolean(discoveryMessage?.chat), ignored: 'TELEGRAM_OWNER_OR_STORAGE_NOT_CONFIGURED' })
    }

    const parsed = parseTelegramUpdate(update, ownerUserId, storageChatId)
    if (parsed.kind === 'forbidden') {
      await finishLegacyUpdate(context.env.DB, update.update_id, claim.token, discoveryMessage?.message_id)
      return context.json({ error: parsed.reason }, 403)
    }
    if (parsed.kind === 'ignored') {
      await finishLegacyUpdate(context.env.DB, update.update_id, claim.token)
      return context.json({ ok: true, ignored: parsed.reason })
    }

    const sourceMessage = parsed.asset.message
    const storageObjectState = await getStorageObjectStateByFileUniqueId(context.env.DB, parsed.asset.fileUniqueId, LEGACY_TELEGRAM_SOURCE_ID)
    if (storageObjectState?.deleteState === 'deleting' || storageObjectState?.deleteState === 'delete_failed') {
      await retryLegacyUpdate(context.env.DB, update.update_id, claim.token)
      context.header('Retry-After', '1')
      return context.json({ error: 'STORAGE_OBJECT_DELETE_IN_PROGRESS', recoverable: true }, 409)
    }

    const storageConfig = context.env.MOCK_TELEGRAM === 'true'
      ? { token: 'mock', storageChatId }
      : await resolveTelegramSourceConfig(context.env.DB, context.env, LEGACY_TELEGRAM_SOURCE_ID)
    const storage = parsed.needsCopy ? createStorageAdapterFromConfig(context.env, storageConfig) : null
    let storageMessageId = claim.messageId ?? sourceMessage.message_id

    // Persist the copied Telegram message id in the atomic update claim before any D1
    // asset/queue work. If a later step fails, Telegram's retry reclaims this update
    // and reuses the same external message instead of creating another orphan copy.
    if (claim.messageId === null && parsed.needsCopy && storage && storageObjectState?.deleteState !== 'active') {
      storageMessageId = (await storage.copyMessage(String(sourceMessage.chat.id), sourceMessage.message_id)).messageId
    }
    await setLegacyClaimMessage(context.env.DB, update.update_id, claim.token, storageMessageId)

    const status = parsed.asset.limited ? 'limited' : parsed.asset.previewFileId ? 'queued' : 'ready'
    const result = await createTelegramAsset(context.env.DB, {
      id: crypto.randomUUID(), sourceId: LEGACY_TELEGRAM_SOURCE_ID, source: context.env.MOCK_TELEGRAM === 'true' ? 'mock' : 'telegram',
      mediaType: parsed.asset.mediaType, mimeType: parsed.asset.mimeType, originalName: parsed.asset.originalName,
      sizeBytes: parsed.asset.sizeBytes, width: parsed.asset.width, height: parsed.asset.height, durationMs: parsed.asset.durationMs,
      takenAt: new Date(sourceMessage.date * 1000).toISOString(), chatId: storageChatId, messageId: storageMessageId,
      fileId: parsed.asset.fileId, fileUniqueId: parsed.asset.fileUniqueId, previewFileId: parsed.asset.previewFileId,
      status, telegramUrl: privateChannelMessageUrl(storageChatId, storageMessageId),
    })
    if (status === 'queued') {
      await context.env.ANALYSIS_QUEUE.send({ assetId: result.id, previewFileId: parsed.asset.previewFileId, jobType: 'analyze' })
    }
    await finishLegacyUpdate(context.env.DB, update.update_id, claim.token, storageMessageId)
    return context.json({ ok: true, created: result.created, assetId: result.id }, result.created ? 201 : 200)
  } catch (error) {
    await retryLegacyUpdate(context.env.DB, update.update_id, claim.token).catch(() => undefined)
    if (error instanceof Error && error.message === 'STORAGE_OBJECT_DELETE_IN_PROGRESS') {
      context.header('Retry-After', '1')
      return context.json({ error: 'STORAGE_OBJECT_DELETE_IN_PROGRESS', recoverable: true }, 409)
    }
    throw error
  }
})
