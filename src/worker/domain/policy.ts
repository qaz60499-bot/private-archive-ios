import type { MediaType, ReserveAssetInput } from './types'

export const TELEGRAM_GET_FILE_LIMIT = 20 * 1024 * 1024
export const MAX_UPLOAD_BYTES = 48 * 1024 * 1024
export const UPLOAD_TOKEN_TTL_MS = 15 * 60 * 1000

export type SizeTier = 'full' | 'preview-only' | 'rejected'

export function getSizeTier(sizeBytes: number): SizeTier {
  if (sizeBytes > MAX_UPLOAD_BYTES) return 'rejected'
  if (sizeBytes > TELEGRAM_GET_FILE_LIMIT) return 'preview-only'
  return 'full'
}

export function inferMediaType(mimeType: string): MediaType {
  if (mimeType.startsWith('image/')) return 'photo'
  if (mimeType.startsWith('video/')) return 'video'
  return 'file'
}

export function validateReserveInput(value: unknown): ReserveAssetInput {
  if (!value || typeof value !== 'object') throw new Error('INVALID_BODY')
  const input = value as Record<string, unknown>
  if (typeof input.originalName !== 'string' || input.originalName.trim().length === 0 || input.originalName.length > 255) {
    throw new Error('INVALID_FILE_NAME')
  }
  if (typeof input.mimeType !== 'string' || input.mimeType.length > 160) throw new Error('INVALID_MIME_TYPE')
  if (typeof input.sizeBytes !== 'number' || !Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) {
    throw new Error('INVALID_FILE_SIZE')
  }
  if (getSizeTier(input.sizeBytes) === 'rejected') throw new Error('FILE_TOO_LARGE')
  const mediaType = input.mediaType ?? inferMediaType(input.mimeType)
  if (!['photo', 'video', 'file'].includes(String(mediaType))) throw new Error('INVALID_MEDIA_TYPE')

  const optionalNumber = (key: string): number | undefined => {
    const candidate = input[key]
    if (candidate === undefined || candidate === null) return undefined
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) throw new Error(`INVALID_${key.toUpperCase()}`)
    return candidate
  }

  const contentHash = typeof input.contentHash === 'string' ? input.contentHash.trim().toLowerCase() : undefined
  if (contentHash !== undefined && !/^[a-f0-9]{64}$/.test(contentHash)) throw new Error('INVALID_CONTENT_HASH')

  const width = optionalNumber('width')
  const height = optionalNumber('height')
  const durationMs = optionalNumber('durationMs')
  const latitude = optionalNumber('latitude')
  const longitude = optionalNumber('longitude')
  if (width !== undefined && width <= 0) throw new Error('INVALID_WIDTH')
  if (height !== undefined && height <= 0) throw new Error('INVALID_HEIGHT')
  if (durationMs !== undefined && durationMs < 0) throw new Error('INVALID_DURATIONMS')
  if (latitude !== undefined && (latitude < -90 || latitude > 90)) throw new Error('INVALID_LATITUDE')
  if (longitude !== undefined && (longitude < -180 || longitude > 180)) throw new Error('INVALID_LONGITUDE')

  return {
    originalName: input.originalName.trim(),
    mimeType: input.mimeType || 'application/octet-stream',
    sizeBytes: input.sizeBytes,
    mediaType: mediaType as MediaType,
    width,
    height,
    durationMs,
    takenAt: typeof input.takenAt === 'string' ? input.takenAt : undefined,
    fileCreatedAt: typeof input.fileCreatedAt === 'string' ? input.fileCreatedAt : undefined,
    latitude,
    longitude,
    contentHash,
  }
}

export function selectTakenAt(input: {
  exifTakenAt?: string | null
  fileCreatedAt?: string | null
  telegramDate?: string | null
  uploadedAt: string
}): string {
  for (const candidate of [input.exifTakenAt, input.fileCreatedAt, input.telegramDate, input.uploadedAt]) {
    if (candidate && !Number.isNaN(Date.parse(candidate))) return new Date(candidate).toISOString()
  }
  return new Date(input.uploadedAt).toISOString()
}

export const ALLOWED_TAGS = new Set([
  'people', 'portrait', 'group', 'landscape', 'nature', 'city', 'street', 'architecture', 'indoor', 'outdoor',
  'night', 'gathering', 'food', 'animal', 'vehicle', 'screenshot', 'document', 'product', 'art', 'travel', 'other',
])

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return ['other']
  const normalized = tags
    .filter((tag): tag is string => typeof tag === 'string')
    .map((tag) => tag.trim().toLowerCase().replace(/[\s_]+/g, '-'))
    .filter((tag) => ALLOWED_TAGS.has(tag))
  return [...new Set(normalized)].slice(0, 8).length ? [...new Set(normalized)].slice(0, 8) : ['other']
}

