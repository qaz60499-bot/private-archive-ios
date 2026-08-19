export interface AnalysisMessage {
  assetId: string
  previewFileId?: string
  jobType: 'analyze' | 'resolve-place' | 'normalize-tags'
}

export interface AiBinding {
  run(model: string, input: Record<string, unknown>): Promise<unknown>
}

export interface Env {
  DB: D1Database
  PREVIEW_CACHE?: KVNamespace
  ANALYSIS_QUEUE: Queue<AnalysisMessage>
  AI: AiBinding
  ASSETS: Fetcher
  MOCK_TELEGRAM?: string
  ALLOWED_ORIGIN?: string
  OWNER_EMAIL?: string
  POLICY_AUD?: string
  TEAM_DOMAIN?: string
  TELEGRAM_BOT_TOKEN?: string
  TELEGRAM_STORAGE_CHAT_ID?: string
  TELEGRAM_OWNER_USER_ID?: string
  TELEGRAM_WEBHOOK_SECRET?: string
  TELEGRAM_WEBHOOK_URL?: string
}

export function isMockMode(env: Env): boolean {
  return env.MOCK_TELEGRAM === 'true'
}
