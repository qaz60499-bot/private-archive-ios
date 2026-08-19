export type MediaType = 'photo' | 'video' | 'file'

export interface Asset {
  id: string
  source: 'web' | 'telegram' | 'mock'
  mediaType: MediaType
  mimeType: string
  originalName: string
  sizeBytes: number
  width: number | null
  height: number | null
  durationMs: number | null
  takenAt: string
  uploadedAt: string
  latitude: number | null
  longitude: number | null
  placeId: string | null
  primaryCategory: string | null
  aiCategory: string | null
  categoryOverride: string | null
  categorySource: 'manual' | 'ai'
  personCount: number | null
  scene: string | null
  favorite: boolean
  status: string
  analysisStatus: string
  previewUrl: string
  mediaUrl: string | null
  telegramUrl: string | null
  originalAvailableInApp: boolean
  tags?: Array<{ slug: string; name: string; confidence: number | null; source: string }>
}

export interface Album {
  id: string
  name: string
  cover_asset_id: string | null
  asset_count: number
  first_taken_at?: string | null
  latest_taken_at?: string | null
  created_at: string
  updated_at: string
}

export interface DiscoverModule {
  slug: string
  name: string
  description: string
  kind: 'category' | 'media'
  sortOrder: number
  isSystem: boolean
  assetCount: number
  coverAssetId: string | null
}

export interface TelegramDiscovery {
  bot: { id: string; username: string | null; firstName: string | null }
  chats: Array<{
    id: string
    type: string
    title: string | null
    username: string | null
    firstName: string | null
  }>
}

export interface IntegrationStatus {
  mockMode: boolean
  telegram: {
    tokenConfigured: boolean
    ownerConfigured: boolean
    storageChatConfigured: boolean
    webhookSecretConfigured: boolean
  }
  d1: { configured: boolean }
  queue: { configured: boolean }
  ai: { configured: boolean }
  access: {
    configured: boolean
    ownerEmailConfigured: boolean
    audienceConfigured: boolean
    teamDomainConfigured: boolean
  }
  limits: { inAppOriginalBytes: number; maxUploadBytes: number }
  privacy: { cloudflareAccessExpected: boolean; tokenStoredInD1: boolean; endToEndEncrypted: boolean }
}

export type LocalUploadStatus = 'waiting' | 'uploading' | 'paused' | 'retrying' | 'done' | 'failed'
export type LocalUploadPrepareStatus = 'pending' | 'preparing' | 'ready' | 'failed'
export type LocalUploadControlState = 'active' | 'paused' | 'canceled'
export type LocalUploadStage = 'registered' | 'preparing' | 'reserving' | 'preview' | 'original' | 'completed'

export interface LocalUploadJob {
  schemaVersion: 2
  id: string
  batchId: string
  fileName: string
  mimeType: string
  sizeBytes: number
  mediaType: MediaType
  status: LocalUploadStatus
  prepareStatus: LocalUploadPrepareStatus
  controlState: LocalUploadControlState
  stage: LocalUploadStage
  progress: number
  attempts: number
  createdAt: string
  updatedAt: string
  nextAttemptAt?: string
  lastAttemptAt?: string
  retryAfterMs?: number
  error?: string
  remoteAssetId?: string
  uploadToken?: string
  deduplicated?: boolean
  duplicateOfAssetId?: string
  contentHash?: string
  previewUploaded?: boolean
  transientPayload?: boolean
  opfsPath?: string
  fileBlob?: Blob
  previewBlob?: Blob
  metadata: Record<string, string | number | undefined>
}
