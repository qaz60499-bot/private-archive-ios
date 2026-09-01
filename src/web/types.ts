export type MediaType = 'photo' | 'video' | 'file'
export type StorageBackend = 'telegram_user_group' | 'telegram_bot'
export type FileCategory = 'documents' | 'spreadsheets' | 'images' | 'archives' | 'video' | 'audio' | 'code' | 'other'

export interface Asset {
  id: string
  source: 'web' | 'telegram' | 'mock'
  sourceId: string
  storageBackend: StorageBackend
  importOrigin: string
  mediaType: MediaType
  mimeType: string
  originalName: string
  sizeBytes: number
  extension: string
  fileCategory: FileCategory
  metadata: Record<string, unknown> | null
  archived: boolean
  deletedAt: string | null
  purgeAt: string | null
  logicalPath: string
  lastViewedAt: string | null
  uploadSupported: boolean
  downloadSupported: boolean
  previewSupported: boolean
  metadataSupported: boolean
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
  originalAvailableInApp: boolean
  tags?: Array<{ slug: string; name: string; confidence: number | null; source: string }>
  albumNames?: string[]
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

export interface TelegramSource {
  id: string
  displayName: string
  botUserId: string | null
  botUsername: string | null
  chatId: string | null
  chatType: string | null
  sourceType: 'private_chat' | 'group' | 'channel' | null
  enabled: boolean
  connectionStatus: 'unconfigured' | 'legacy' | 'verified' | 'bound' | 'disabled' | 'error' | 'disconnected'
  lastSyncAt: string | null
  lastError: string | null
  tokenConfigured: boolean
  assetCount: number
  storageObjectCount: number
  createdAt: string
  updatedAt: string
}

export interface ShareLink {
  id: string
  name: string
  scopeType: 'source' | 'album' | 'asset'
  scopeId: string
  permissions: Array<'read' | 'download'>
  createdAt: string
  expiresAt: string | null
  lastUsedAt: string | null
  revoked: boolean
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

export type AppAccountRole = 'OWNER' | 'MEMBER'
export type AppAccountStatus = 'ACTIVE' | 'DISABLED'
export type AppAccessPreset = 'FULL' | 'VIEWER' | 'UPLOAD_ONLY' | 'SCOPED' | 'CUSTOM'
export type AppPermission = 'read' | 'download' | 'upload' | 'edit' | 'delete'
export type AppAccessScopeType = 'workspace' | 'source' | 'album' | 'asset'

export interface AppAccessGrant {
  scopeType: AppAccessScopeType
  scopeId: string
  permission: AppPermission
}

export interface AppAccount {
  id: string
  username: string
  displayName: string
  role: AppAccountRole
  status: AppAccountStatus
  accessPreset: AppAccessPreset
  grants: AppAccessGrant[]
  lastLoginAt: string | null
  createdAt: string
}

export interface AuthStatus {
  initialized: boolean
  authenticated: boolean
  user: AppAccount | null
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
  workspace?: { id: string; kind: 'personal' | 'company' }
  storage?: {
    defaultStorageBackend: StorageBackend
    userGroup: {
      connectionStatus: 'disconnected' | 'auth_required' | 'connected' | 'syncing' | 'error'
      storageChatId: string | null
      storageChatTitle: string | null
      lastSyncAt: string | null
      lastError: string | null
      lastAckMessageId: number | null
    }
  }
  usage?: UsageSnapshot
  trash?: { retentionDays: number | null }
  limits: { inAppOriginalBytes: number; maxUploadBytes: number; userGroupAccountLimitApplies?: boolean }
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
  principalId?: string
  fileName: string
  mimeType: string
  sizeBytes: number
  mediaType: MediaType
  storageBackend: StorageBackend
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
  previewStored?: boolean
  transientPayload?: boolean
  opfsPath?: string
  fileBlob?: Blob
  previewBlob?: Blob
  metadata: Record<string, unknown>
}

export interface UsageSnapshot {
  workspaceId: string
  fileCount: number
  photoCount: number
  storageBytes: number
  uploadCount: number
  uploadBytes: number
  quotaFiles: number | null
  quotaStorageBytes: number | null
  updatedAt: string
}

export interface ArchiveSummary {
  assetCount: number
  photoCount: number
  albumCount: number
  lastUpdate: string | null
}

export interface ActivityItem {
  id: string
  action: string
  assetId: string | null
  albumId: string | null
  detail: Record<string, unknown> | null
  assetName?: string | null
  assetSource?: string | null
  createdAt: string
}
