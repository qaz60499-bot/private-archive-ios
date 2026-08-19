import { Hono } from 'hono'
import { createTelegramAsset } from '../db/assets-repository'
import {
  getTelegramRuntimeConfig,
  getTelegramWebhookState,
  listTelegramDiscoveredChats,
  saveTelegramDiscoveredChat,
  saveTelegramRuntimeConfig,
  saveTelegramWebhookState,
} from '../db/settings-repository'
import type { TelegramUpdate } from '../domain/types'
import type { Env } from '../env'
import { requireOwner, verifyWebhookSecret } from '../lib/security'
import { createStorageAdapter } from '../services/storage/factory'
import { parseTelegramUpdate, privateChannelMessageUrl } from '../services/telegram/normalize-update'
import { configureTelegramWebhook, getTelegramWebhookInfo } from '../services/telegram/webhook'

export const telegramRoutes = new Hono<{ Bindings: Env }>()

interface TelegramDiscoveryResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

async function telegramJson<T>(token: string, method: string): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`)
  const body = await response.json<TelegramDiscoveryResponse<T>>()
  if (!response.ok || !body.ok || body.result === undefined) {
    throw new Error(`TELEGRAM_${method.toUpperCase()}_FAILED:${body.description ?? response.status}`)
  }
  return body.result
}

telegramRoutes.get('/discover', requireOwner, async (context) => {
  const token = context.env.TELEGRAM_BOT_TOKEN
  if (!token && context.env.MOCK_TELEGRAM !== 'true') return context.json({ error: 'TELEGRAM_BOT_TOKEN_NOT_CONFIGURED' }, 503)

  try {
    const botPromise = context.env.MOCK_TELEGRAM === 'true'
      ? Promise.resolve({ id: 0, username: 'mock_archive_bot', first_name: 'Mock Archive Bot' })
      : telegramJson<{ id: number; username?: string; first_name?: string }>(token!, 'getMe')
    const [bot, chats] = await Promise.all([
      botPromise,
      listTelegramDiscoveredChats(context.env.DB),
    ])

    return context.json({
      bot: { id: String(bot.id), username: bot.username ?? null, firstName: bot.first_name ?? null },
      chats,
    })
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'TELEGRAM_DISCOVERY_FAILED' }, 502)
  }
})

telegramRoutes.post('/configure', requireOwner, async (context) => {
  const body = await context.req.json<{ chatId?: unknown; role?: unknown }>()
  if (typeof body.chatId !== 'string' || !/^-?\d+$/.test(body.chatId)) {
    return context.json({ error: 'TELEGRAM_CHAT_ID_INVALID' }, 400)
  }
  if (!['owner', 'storage', 'both'].includes(String(body.role))) {
    return context.json({ error: 'TELEGRAM_CONFIG_ROLE_INVALID' }, 400)
  }
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
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'TELEGRAM_WEBHOOK_CONFIGURE_FAILED' }, 502)
  }
})

telegramRoutes.get('/webhook/status', requireOwner, async (context) => {
  try {
    const [remote, saved] = await Promise.all([
      getTelegramWebhookInfo(context.env),
      getTelegramWebhookState(context.env.DB),
    ])
    return context.json({ webhook: remote, saved, expectedUrl: context.env.TELEGRAM_WEBHOOK_URL ?? null })
  } catch (error) {
    return context.json({ error: error instanceof Error ? error.message : 'TELEGRAM_WEBHOOK_STATUS_FAILED' }, 502)
  }
})

async function alreadyProcessed(db: D1Database, updateId: number): Promise<boolean> {
  return Boolean(await db.prepare(`SELECT update_id FROM telegram_updates WHERE update_id = ?`).bind(updateId).first())
}

async function rememberUpdate(db: D1Database, updateId: number, messageId?: number): Promise<void> {
  await db.prepare(`INSERT INTO telegram_updates (update_id, message_id, processed_at) VALUES (?, ?, ?)
    ON CONFLICT(update_id) DO NOTHING`).bind(updateId, messageId ?? null, new Date().toISOString()).run()
}

telegramRoutes.post('/webhook', async (context) => {
  const expectedSecret = context.env.MOCK_TELEGRAM === 'true' ? 'local-webhook-secret' : context.env.TELEGRAM_WEBHOOK_SECRET
  if (!verifyWebhookSecret(context.req.header('X-Telegram-Bot-Api-Secret-Token'), expectedSecret)) {
    return context.json({ error: 'WEBHOOK_SECRET_INVALID' }, 401)
  }

  const update = await context.req.json<TelegramUpdate>()
  if (!Number.isSafeInteger(update.update_id)) return context.json({ error: 'UPDATE_ID_INVALID' }, 400)

  const discoveryMessage = update.message ?? update.channel_post
  if (discoveryMessage?.chat && Number.isSafeInteger(discoveryMessage.chat.id) && discoveryMessage.chat.type) {
    await saveTelegramDiscoveredChat(context.env.DB, {
      id: String(discoveryMessage.chat.id),
      type: discoveryMessage.chat.type,
      title: discoveryMessage.chat.title ?? null,
      username: discoveryMessage.chat.username ?? null,
      firstName: discoveryMessage.chat.first_name ?? null,
    })
  }

  if (await alreadyProcessed(context.env.DB, update.update_id)) return context.json({ ok: true, duplicate: true })

  const runtimeConfig = await getTelegramRuntimeConfig(context.env.DB, context.env)
  const ownerUserId = context.env.MOCK_TELEGRAM === 'true' ? '10001' : runtimeConfig.ownerUserId
  const storageChatId = context.env.MOCK_TELEGRAM === 'true' ? '-1000000000000' : runtimeConfig.storageChatId
  if (!ownerUserId || !storageChatId) {
    await rememberUpdate(context.env.DB, update.update_id, discoveryMessage?.message_id)
    return context.json({ ok: true, discovered: Boolean(discoveryMessage?.chat), ignored: 'TELEGRAM_OWNER_OR_STORAGE_NOT_CONFIGURED' })
  }

  const parsed = parseTelegramUpdate(update, ownerUserId, storageChatId)
  if (parsed.kind === 'forbidden') return context.json({ error: parsed.reason }, 403)
  if (parsed.kind === 'ignored') {
    await rememberUpdate(context.env.DB, update.update_id)
    return context.json({ ok: true, ignored: parsed.reason })
  }

  const sourceMessage = parsed.asset.message
  let storageMessageId = sourceMessage.message_id
  if (parsed.needsCopy) {
    storageMessageId = (await createStorageAdapter(context.env, storageChatId).copyMessage(String(sourceMessage.chat.id), sourceMessage.message_id)).messageId
  }
  const status = parsed.asset.limited ? 'limited' : parsed.asset.previewFileId ? 'queued' : 'ready'
  const result = await createTelegramAsset(context.env.DB, {
    id: crypto.randomUUID(),
    source: context.env.MOCK_TELEGRAM === 'true' ? 'mock' : 'telegram',
    mediaType: parsed.asset.mediaType,
    mimeType: parsed.asset.mimeType,
    originalName: parsed.asset.originalName,
    sizeBytes: parsed.asset.sizeBytes,
    width: parsed.asset.width,
    height: parsed.asset.height,
    durationMs: parsed.asset.durationMs,
    takenAt: new Date(sourceMessage.date * 1000).toISOString(),
    chatId: storageChatId,
    messageId: storageMessageId,
    fileId: parsed.asset.fileId,
    fileUniqueId: parsed.asset.fileUniqueId,
    previewFileId: parsed.asset.previewFileId,
    status,
    telegramUrl: privateChannelMessageUrl(storageChatId, storageMessageId),
  })
  await rememberUpdate(context.env.DB, update.update_id, sourceMessage.message_id)
  if (result.created && status === 'queued') {
    await context.env.ANALYSIS_QUEUE.send({ assetId: result.id, previewFileId: parsed.asset.previewFileId, jobType: 'analyze' })
  }
  return context.json({ ok: true, created: result.created, assetId: result.id }, result.created ? 201 : 200)
})

