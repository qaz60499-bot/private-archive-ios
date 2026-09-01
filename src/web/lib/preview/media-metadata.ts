import * as exifr from 'exifr'
import type { MediaType } from '../../types'
import { extractFileMetadata, type ExtractedMetadata } from './file-metadata'

export interface PreparedMedia {
  file: File
  preview?: Blob
  metadata: {
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
    logicalPath?: string
    metadata?: ExtractedMetadata
  }
}

function logicalPathForFile(file: File): string | undefined {
  const relative = file.webkitRelativePath?.replaceAll('\\', '/')
  if (!relative || !relative.includes('/')) return undefined
  const directory = relative.split('/').slice(0, -1).filter(Boolean).join('/')
  return directory ? `/${directory}` : undefined
}

function extensionOf(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar.gz'
  const dot = lower.lastIndexOf('.')
  return dot > 0 ? lower.slice(dot + 1) : ''
}

const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'heif', 'avif', 'bmp', 'tif', 'tiff'])
const VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])

function mediaTypeForFile(file: File): MediaType {
  const extension = extensionOf(file.name)
  if (file.type.startsWith('image/') || IMAGE_EXTENSIONS.has(extension)) return 'photo'
  if (file.type.startsWith('video/') || VIDEO_EXTENSIONS.has(extension)) return 'video'
  return 'file'
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.78): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PREVIEW_ENCODING_FAILED')), type, quality))
}

function scaledSize(width: number, height: number, maxEdge = 960): [number, number] {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

async function imageMetadata(file: File): Promise<Record<string, unknown> | undefined> {
  // Parse the complete safe EXIF/IPTC/XMP surface instead of a narrow pick list.
  // Exifr skips heavyweight MakerNote/UserComment by default, while the broad parse
  // still catches files whose writers left standard dates under their raw numeric
  // EXIF tag ids (for example 36867 / 36868). GPS is resolved separately because
  // exifr.gps() is more tolerant of camera-specific GPS IFD layouts.
  const [metadataResult, gpsResult] = await Promise.allSettled([
    exifr.parse(file) as Promise<Record<string, unknown> | undefined>,
    exifr.gps(file) as Promise<{ latitude?: number; longitude?: number } | undefined>,
  ])
  const metadata = metadataResult.status === 'fulfilled' ? metadataResult.value : undefined
  const gps = gpsResult.status === 'fulfilled' ? gpsResult.value : undefined
  if (!metadata && !gps) return undefined
  return { ...(metadata ?? {}), ...(gps ?? {}) }
}

function isoDate(value: unknown, offset?: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString()
  if (typeof value !== 'string' || !value.trim()) return undefined
  const trimmed = value.trim()
  const parsed = Date.parse(trimmed)
  if (!Number.isNaN(parsed)) return new Date(parsed).toISOString()
  const exif = trimmed.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/)
  if (!exif) return undefined
  const [, year, month, day, hour, minute, second, fraction = ''] = exif
  const normalizedOffset = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset.trim()) ? offset.trim() : ''
  if (normalizedOffset) {
    const milliseconds = fraction ? `.${fraction.slice(0, 3).padEnd(3, '0')}` : ''
    const withOffset = `${year}-${month}-${day}T${hour}:${minute}:${second}${milliseconds}${normalizedOffset}`
    const withOffsetParsed = Date.parse(withOffset)
    if (!Number.isNaN(withOffsetParsed)) return new Date(withOffsetParsed).toISOString()
  }
  const local = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number((fraction + '000').slice(0, 3)))
  return Number.isNaN(local.getTime()) ? undefined : local.toISOString()
}

function gpsDateTime(exif: Record<string, unknown> | undefined): string | undefined {
  const date = metadataString(exif?.GPSDateStamp)
  const time = metadataString(exif?.GPSTimeStamp)
  if (!date || !time) return undefined
  const normalizedDate = date.replace(/:/g, '-')
  const parsed = Date.parse(`${normalizedDate}T${time}Z`)
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString()
}

function metadataString(value: unknown, max = 160): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function compactPhotoMetadata(exif: Record<string, unknown> | undefined, file: File): ExtractedMetadata {
  const metadata: ExtractedMetadata = { imageFormat: extensionOf(file.name) || file.type || 'unknown' }
  const textFields: Array<[string, string]> = [
    ['cameraMake', 'Make'], ['cameraModel', 'Model'], ['lensMake', 'LensMake'], ['lensModel', 'LensModel'], ['software', 'Software'],
    ['city', 'City'], ['sublocation', 'Sublocation'], ['state', 'State'], ['country', 'Country'], ['countryCode', 'CountryCode'], ['contentLocation', 'ContentLocationName'],
    ['gpsDateStamp', 'GPSDateStamp'], ['gpsTimeStamp', 'GPSTimeStamp'], ['offsetTimeOriginal', 'OffsetTimeOriginal'], ['subSecTimeOriginal', 'SubSecTimeOriginal'],
  ]
  for (const [target, source] of textFields) {
    const value = metadataString(exif?.[source])
    if (value !== undefined) metadata[target] = value
  }
  const numberFields: Array<[string, string]> = [
    ['orientation', 'Orientation'], ['iso', 'ISO'], ['fNumber', 'FNumber'], ['exposureTime', 'ExposureTime'], ['focalLength', 'FocalLength'],
    ['exposureBiasValue', 'ExposureBiasValue'], ['gpsAltitude', 'GPSAltitude'], ['gpsAltitudeRef', 'GPSAltitudeRef'], ['gpsHorizontalError', 'GPSHPositioningError'],
  ]
  for (const [target, source] of numberFields) {
    const value = metadataNumber(exif?.[source])
    if (value !== undefined) metadata[target] = value
  }
  const originalAt = isoDate(exif?.DateTimeOriginal ?? exif?.['36867'], exif?.OffsetTimeOriginal)
  const createdAt = isoDate(exif?.CreateDate ?? exif?.['36868'], exif?.OffsetTimeOriginal)
  const modifiedAt = isoDate(exif?.ModifyDate)
  if (originalAt) metadata.exifOriginalAt = originalAt
  if (createdAt) metadata.exifCreatedAt = createdAt
  if (modifiedAt) metadata.exifModifiedAt = modifiedAt
  const gpsAt = gpsDateTime(exif)
  if (gpsAt) metadata.gpsCapturedAt = gpsAt
  return metadata
}

async function decodeImage(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; close: () => void }> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
      const width = bitmap.width
      const height = bitmap.height
      if (width > 0 && height > 0) return { source: bitmap, width, height, close: () => bitmap.close() }
      bitmap.close()
    } catch {
      // Mobile Safari and some HEIC/large-image paths can reject createImageBitmap even when <img> can decode the file.
    }
  }

  const objectUrl = URL.createObjectURL(file)
  const image = new Image()
  image.decoding = 'async'
  try {
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error('IMAGE_DECODE_FAILED'))
      image.src = objectUrl
    })
    if (!image.naturalWidth || !image.naturalHeight) throw new Error('IMAGE_DECODE_FAILED')
    return { source: image, width: image.naturalWidth, height: image.naturalHeight, close: () => URL.revokeObjectURL(objectUrl) }
  } catch (error) {
    URL.revokeObjectURL(objectUrl)
    throw error
  }
}

async function prepareImage(file: File): Promise<PreparedMedia> {
  const exif = await imageMetadata(file)
  const takenAt = isoDate(exif?.DateTimeOriginal ?? exif?.['36867'], exif?.OffsetTimeOriginal)
    ?? isoDate(exif?.CreateDate ?? exif?.['36868'], exif?.OffsetTimeOriginal)
    ?? gpsDateTime(exif)
  let preview: Blob | undefined
  let decodedWidth = typeof exif?.ImageWidth === 'number' ? exif.ImageWidth : undefined
  let decodedHeight = typeof exif?.ImageHeight === 'number' ? exif.ImageHeight : undefined

  try {
    const decoded = await decodeImage(file)
    decodedWidth = decoded.width
    decodedHeight = decoded.height
    try {
      const [width, height] = scaledSize(decoded.width, decoded.height)
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      if (context) {
        context.drawImage(decoded.source, 0, 0, width, height)
        preview = await canvasBlob(canvas)
      }
    } finally {
      decoded.close()
    }
  } catch {
    // Preview generation must never block the original upload. This is important for HEIC and memory-constrained mobile browsers.
  }

  return {
    file,
    preview,
    metadata: {
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      mediaType: 'photo',
      width: decodedWidth,
      height: decodedHeight,
      takenAt,
      fileCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
      latitude: typeof exif?.latitude === 'number' ? exif.latitude : undefined,
      longitude: typeof exif?.longitude === 'number' ? exif.longitude : undefined,
      logicalPath: logicalPathForFile(file),
      metadata: compactPhotoMetadata(exif, file),
    },
  }
}

async function prepareVideo(file: File): Promise<PreparedMedia> {
  const video = document.createElement('video')
  video.muted = true
  video.preload = 'metadata'
  video.playsInline = true
  const objectUrl = URL.createObjectURL(file)
  try {
    await new Promise<void>((resolve, reject) => {
      video.onloadedmetadata = () => resolve()
      video.onerror = () => reject(new Error('VIDEO_METADATA_FAILED'))
      video.src = objectUrl
    })
    const duration = Number.isFinite(video.duration) ? video.duration : 0
    if (duration > 0) {
      await new Promise<void>((resolve) => {
        video.onseeked = () => resolve()
        video.currentTime = Math.min(duration * 0.25, Math.max(0, duration - 0.1))
      })
    }
    const sourceWidth = video.videoWidth || 1280
    const sourceHeight = video.videoHeight || 720
    const [width, height] = scaledSize(sourceWidth, sourceHeight)
    let preview: Blob | undefined
    try {
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const context = canvas.getContext('2d', { alpha: false })
      if (context) {
        context.drawImage(video, 0, 0, width, height)
        preview = await canvasBlob(canvas)
      }
    } catch {
      preview = undefined
    }
    return {
      file,
      preview,
      metadata: {
        originalName: file.name,
        mimeType: file.type || 'video/mp4',
        sizeBytes: file.size,
        mediaType: 'video',
        width: sourceWidth,
        height: sourceHeight,
        durationMs: Math.round(duration * 1000),
        fileCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
        logicalPath: logicalPathForFile(file),
        metadata: { videoFormat: extensionOf(file.name) || file.type || 'unknown' },
      },
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function prepareMedia(file: File): Promise<PreparedMedia> {
  const mediaType = mediaTypeForFile(file)
  if (mediaType === 'photo') return prepareImage(file)
  if (mediaType === 'video') return prepareVideo(file)
  const metadata = await extractFileMetadata(file)
  return {
    file,
    metadata: {
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      mediaType: 'file',
      fileCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
      logicalPath: logicalPathForFile(file),
      metadata,
    },
  }
}
