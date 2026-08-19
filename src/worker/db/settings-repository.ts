import type { Env } from '../env'

const TELEGRAM_OWNER_KEY = 'telegram_owner_user_id'
const TELEGRAM_STORAGE_KEY = 'telegram_storage_chat_id'
const TELEGRAM_WEBHOOK_URL_KEY = 'telegram_webhook_url'
const TELEGRAM_WEBHOOK_STATUS_KEY = 'telegram_webhook_status'
const TELEGRAM_DISCOVERED_CHAT_PREFIX = 'telegram_discovered_chat:'

async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare('SELECT value FROM app_settings WHERE key = ?').bind(key).first<{ value: string }>()
  return row?.value ?? null
}

async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  const now = new Date().toISOString()
  await db.prepare(`INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .bind(key, value, now).run()
}

export async function getTelegramRuntimeConfig(db: D1Database, env: Env): Promise<{
  ownerUserId: string | null
  storageChatId: string | null
}> {
  const [ownerSetting, storageSetting] = await Promise.all([
    getSetting(db, TELEGRAM_OWNER_KEY),
    getSetting(db, TELEGRAM_STORAGE_KEY),
  ])
  return {
    ownerUserId: ownerSetting ?? env.TELEGRAM_OWNER_USER_ID ?? null,
    storageChatId: storageSetting ?? env.TELEGRAM_STORAGE_CHAT_ID ?? null,
  }
}

export async function saveTelegramRuntimeConfig(db: D1Database, input: {
  ownerUserId?: string
  storageChatId?: string
}): Promise<void> {
  const writes: Promise<void>[] = []
  if (input.ownerUserId) writes.push(setSetting(db, TELEGRAM_OWNER_KEY, input.ownerUserId))
  if (input.storageChatId) writes.push(setSetting(db, TELEGRAM_STORAGE_KEY, input.storageChatId))
  await Promise.all(writes)
}

export async function saveTelegramWebhookState(db: D1Database, input: {
  url: string
  status: string
}): Promise<void> {
  await Promise.all([
    setSetting(db, TELEGRAM_WEBHOOK_URL_KEY, input.url),
    setSetting(db, TELEGRAM_WEBHOOK_STATUS_KEY, input.status),
  ])
}

export async function getTelegramWebhookState(db: D1Database): Promise<{
  url: string | null
  status: string | null
}> {
  const [url, status] = await Promise.all([
    getSetting(db, TELEGRAM_WEBHOOK_URL_KEY),
    getSetting(db, TELEGRAM_WEBHOOK_STATUS_KEY),
  ])
  return { url, status }
}

export interface TelegramDiscoveredChat {
  id: string
  type: string
  title: string | null
  username: string | null
  firstName: string | null
}

export async function saveTelegramDiscoveredChat(db: D1Database, chat: TelegramDiscoveredChat): Promise<void> {
  await setSetting(db, `${TELEGRAM_DISCOVERED_CHAT_PREFIX}${chat.id}`, JSON.stringify(chat))
}

export async function listTelegramDiscoveredChats(db: D1Database): Promise<TelegramDiscoveredChat[]> {
  const rows = await db.prepare(`SELECT value FROM app_settings
    WHERE key LIKE ?
    ORDER BY updated_at DESC
    LIMIT 50`)
    .bind(`${TELEGRAM_DISCOVERED_CHAT_PREFIX}%`)
    .all<{ value: string }>()

  const chats: TelegramDiscoveredChat[] = []
  for (const row of rows.results ?? []) {
    try {
      const parsed = JSON.parse(row.value) as Partial<TelegramDiscoveredChat>
      if (typeof parsed.id !== 'string' || typeof parsed.type !== 'string') continue
      chats.push({
        id: parsed.id,
        type: parsed.type,
        title: typeof parsed.title === 'string' ? parsed.title : null,
        username: typeof parsed.username === 'string' ? parsed.username : null,
        firstName: typeof parsed.firstName === 'string' ? parsed.firstName : null,
      })
    } catch {
      // Ignore malformed legacy/manual setting values rather than breaking discovery.
    }
  }
  return chats
}
