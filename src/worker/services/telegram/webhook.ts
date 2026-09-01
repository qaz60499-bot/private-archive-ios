import type { Env } from '../../env'

interface TelegramApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
}

export interface TelegramWebhookInfo {
  url: string
  has_custom_certificate: boolean
  pending_update_count: number
  last_error_date?: number
  last_error_message?: string
  max_connections?: number
  allowed_updates?: string[]
}

async function telegramCall<T>(token: string, method: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, init)
  const body = await response.json<TelegramApiResponse<T>>()
  if (!response.ok || !body.ok || body.result === undefined) {
    throw new Error(`TELEGRAM_${method.toUpperCase()}_FAILED:${body.description ?? response.status}`)
  }
  return body.result
}

export async function configureTelegramWebhookWithToken(token: string, webhookSecret: string, webhookUrl: string): Promise<TelegramWebhookInfo> {
  const url = new URL(webhookUrl)
  if (url.protocol !== 'https:') throw new Error('TELEGRAM_WEBHOOK_URL_INVALID')
  if (!webhookSecret) throw new Error('TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED')

  await telegramCall<boolean>(token, 'setWebhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: url.toString(),
      secret_token: webhookSecret,
      allowed_updates: ['message', 'channel_post'],
      drop_pending_updates: false,
    }),
  })

  return telegramCall<TelegramWebhookInfo>(token, 'getWebhookInfo')
}

export async function getTelegramWebhookInfoWithToken(token: string): Promise<TelegramWebhookInfo> {
  return telegramCall<TelegramWebhookInfo>(token, 'getWebhookInfo')
}

export async function deleteTelegramWebhookWithToken(token: string): Promise<boolean> {
  return telegramCall<boolean>(token, 'deleteWebhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ drop_pending_updates: false }),
  })
}

export async function configureTelegramWebhook(env: Env, webhookUrl: string): Promise<TelegramWebhookInfo> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')
  if (!env.TELEGRAM_WEBHOOK_SECRET) throw new Error('TELEGRAM_WEBHOOK_SECRET_NOT_CONFIGURED')
  return configureTelegramWebhookWithToken(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET, webhookUrl)
}

export async function getTelegramWebhookInfo(env: Env): Promise<TelegramWebhookInfo> {
  if (!env.TELEGRAM_BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN_NOT_CONFIGURED')
  return getTelegramWebhookInfoWithToken(env.TELEGRAM_BOT_TOKEN)
}
