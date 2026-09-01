import type { FileCategory } from './asset-metadata'

export type MediaType = 'photo' | 'video' | 'file'
export type StorageBackend = 'telegram_user_group' | 'telegram_bot'
export type AssetSource = 'web' | 'telegram' | 'mock'
export type AssetStatus =
  | 'pending_upload'
  | 'stored'
  | 'queued'
  | 'analyzing'
  | 'ready'
  | 'limited'
  | 'failed'
  | 'trashed'

export type AnalysisStatus = 'pending' | 'queued' | 'analyzing' | 'ready' | 'limited' | 'failed' | 'skipped'

export interface AssetRow {
  id: string
  storage_provider: string
  storage_backend: StorageBackend
  storage_chat_id: string | null
  storage_message_id: number | null
  storage_file_id: string | null
  storage_file_unique_id: string | null
  telegram_media_id: string | null
  import_origin: string
  preview_message_id: number | null
  preview_file_id: string | null
  source: AssetSource
  media_type: MediaType
  mime_type: string
  original_name: string
  size_bytes: number
  content_hash: string | null
  workspace_id: string
  source_id: string
  storage_object_id: string | null
  extension: string
  file_category: FileCategory
  metadata_json: string | null
  archived: number
  archived_at: string | null
  pre_trash_status: string | null
  deleted_at: string | null
  purge_at: string | null
  purge_state: 'active' | 'pending' | 'delete_failed'
  purge_error: string | null
  logical_path: string
  last_viewed_at: string | null
  width: number | null
  height: number | null
  duration_ms: number | null
  taken_at: string
  uploaded_at: string
  latitude: number | null
  longitude: number | null
  place_id: string | null
  primary_category: string | null
  category_override: string | null
  category_override_at: string | null
  person_count: number | null
  scene: string | null
  favorite: number
  status: AssetStatus
  analysis_status: AnalysisStatus
  telegram_url: string | null
  created_at: string
  updated_at: string
}

export interface AssetTag {
  slug: string
  name: string
  confidence: number | null
  source: string
}

export interface PublicAsset {
  id: string
  source: AssetSource
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
  status: AssetStatus
  analysisStatus: AnalysisStatus
  previewUrl: string
  mediaUrl: string | null
  originalAvailableInApp: boolean
  tags?: AssetTag[]
}

export interface ReserveAssetInput {
  originalName: string
  mimeType: string
  sizeBytes: number
  mediaType: MediaType
  width?: number
  height?: number
  durationMs?: number
  takenAt?: string
  fileCreatedAt?: string
  latitude?: number
  longitude?: number
  contentHash?: string
  logicalPath?: string
  sourceId?: string
  storageBackend?: StorageBackend
  importOrigin?: string
  metadata?: Record<string, string | number | boolean | string[]>
}

export interface StoredFile {
  backend: StorageBackend
  chatId: string
  messageId: number
  fileId: string
  fileUniqueId: string
  telegramUrl: string | null
  mediaId?: string
  importOrigin?: string
  previewFileId?: string
}

export interface TelegramPhotoSize {
  file_id: string
  file_unique_id: string
  width: number
  height: number
  file_size?: number
}

export interface TelegramFileShape {
  file_id: string
  file_unique_id: string
  file_name?: string
  mime_type?: string
  file_size?: number
  width?: number
  height?: number
  duration?: number
  thumbnail?: TelegramPhotoSize
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number; type: string; username?: string; title?: string; first_name?: string }
  from?: { id: number; is_bot: boolean }
  caption?: string
  photo?: TelegramPhotoSize[]
  video?: TelegramFileShape
  document?: TelegramFileShape
}

export interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  channel_post?: TelegramMessage
}

export interface NormalizedTelegramAsset {
  message: TelegramMessage
  mediaType: MediaType
  fileId: string
  fileUniqueId: string
  previewFileId?: string
  mimeType: string
  originalName: string
  sizeBytes: number
  width?: number
  height?: number
  durationMs?: number
  limited: boolean
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

export function toPublicAsset(row: AssetRow, tags?: AssetTag[], options: { allowDownload?: boolean } = {}): PublicAsset {
  const allowDownload = options.allowDownload !== false
  const originalRetrievableInApp = row.storage_backend === 'telegram_user_group'
    ? Boolean(row.storage_message_id)
    : row.size_bytes <= 20 * 1024 * 1024 && Boolean(row.storage_file_id)
  const originalAvailableInApp = allowDownload && originalRetrievableInApp
  const metadataSupported = row.metadata_json !== null
    || row.media_type === 'photo'
    || row.media_type === 'video'
    || ['pdf', 'xlsx', 'xlsm', 'docx', 'zip', 'csv'].includes(row.extension)
  return {
    id: row.id,
    source: row.source,
    sourceId: row.source_id,
    storageBackend: row.storage_backend,
    importOrigin: row.import_origin,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    originalName: row.original_name,
    sizeBytes: row.size_bytes,
    extension: row.extension,
    fileCategory: row.file_category,
    metadata: row.metadata_json ? safeJson(row.metadata_json) : null,
    archived: row.archived === 1,
    deletedAt: row.deleted_at,
    purgeAt: row.purge_at,
    logicalPath: row.logical_path,
    lastViewedAt: row.last_viewed_at,
    uploadSupported: row.storage_backend === 'telegram_user_group' || row.size_bytes <= 20 * 1024 * 1024,
    downloadSupported: originalAvailableInApp,
    previewSupported: row.storage_backend === 'telegram_user_group'
      ? Boolean(row.storage_message_id) && ['photo', 'video'].includes(row.media_type)
      : Boolean(row.preview_file_id) || (allowDownload && row.media_type === 'photo' && originalRetrievableInApp),
    metadataSupported,
    width: row.width,
    height: row.height,
    durationMs: row.duration_ms,
    takenAt: row.taken_at,
    uploadedAt: row.uploaded_at,
    latitude: row.latitude,
    longitude: row.longitude,
    placeId: row.place_id,
    primaryCategory: row.category_override ?? row.primary_category,
    aiCategory: row.primary_category,
    categoryOverride: row.category_override,
    categorySource: row.category_override ? 'manual' : 'ai',
    personCount: row.person_count,
    scene: row.scene,
    favorite: row.favorite === 1,
    status: row.status,
    analysisStatus: row.analysis_status,
    previewUrl: row.storage_backend === 'telegram_user_group'
      ? `/__telegram_storage/asset/${encodeURIComponent(row.id)}/file?variant=preview`
      : `/api/assets/${row.id}/preview`,
    mediaUrl: originalAvailableInApp
      ? row.storage_backend === 'telegram_user_group'
        ? `/__telegram_storage/asset/${encodeURIComponent(row.id)}/file?variant=original`
        : `/api/assets/${row.id}/media`
      : null,
    originalAvailableInApp,
    tags,
  }
}

