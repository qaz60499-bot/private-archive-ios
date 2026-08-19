export type MediaType = 'photo' | 'video' | 'file'
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
  storage_chat_id: string | null
  storage_message_id: number | null
  storage_file_id: string | null
  storage_file_unique_id: string | null
  preview_message_id: number | null
  preview_file_id: string | null
  source: AssetSource
  media_type: MediaType
  mime_type: string
  original_name: string
  size_bytes: number
  content_hash: string | null
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
  status: AssetStatus
  analysisStatus: AnalysisStatus
  previewUrl: string
  mediaUrl: string | null
  telegramUrl: string | null
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
}

export interface StoredFile {
  chatId: string
  messageId: number
  fileId: string
  fileUniqueId: string
  telegramUrl: string | null
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

export function toPublicAsset(row: AssetRow, tags?: AssetTag[]): PublicAsset {
  const originalAvailableInApp = row.size_bytes <= 20 * 1024 * 1024 && Boolean(row.storage_file_id)
  return {
    id: row.id,
    source: row.source,
    mediaType: row.media_type,
    mimeType: row.mime_type,
    originalName: row.original_name,
    sizeBytes: row.size_bytes,
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
    previewUrl: `/api/assets/${row.id}/preview`,
    mediaUrl: originalAvailableInApp ? `/api/assets/${row.id}/media` : null,
    telegramUrl: row.telegram_url,
    originalAvailableInApp,
    tags,
  }
}

