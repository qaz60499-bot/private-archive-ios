import * as exifr from 'exifr'
import type { MediaType } from '../../types'

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
  }
}

function canvasBlob(canvas: HTMLCanvasElement, type = 'image/jpeg', quality = 0.78): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('PREVIEW_ENCODING_FAILED')), type, quality))
}

function scaledSize(width: number, height: number, maxEdge = 960): [number, number] {
  const scale = Math.min(1, maxEdge / Math.max(width, height))
  return [Math.max(1, Math.round(width * scale)), Math.max(1, Math.round(height * scale))]
}

async function imageMetadata(file: File): Promise<Record<string, unknown> | undefined> {
  try {
    return await exifr.parse(file, ['DateTimeOriginal', 'CreateDate', 'latitude', 'longitude', 'Model', 'Orientation', 'ImageWidth', 'ImageHeight']) as Record<string, unknown>
  } catch {
    return undefined
  }
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
  const rawDate = exif?.DateTimeOriginal ?? exif?.CreateDate
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
      takenAt: rawDate instanceof Date ? rawDate.toISOString() : typeof rawDate === 'string' ? rawDate : undefined,
      fileCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
      latitude: typeof exif?.latitude === 'number' ? exif.latitude : undefined,
      longitude: typeof exif?.longitude === 'number' ? exif.longitude : undefined,
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
      },
    }
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}

export async function prepareMedia(file: File): Promise<PreparedMedia> {
  if (file.type.startsWith('image/')) return prepareImage(file)
  if (file.type.startsWith('video/')) return prepareVideo(file)
  return {
    file,
    metadata: {
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
      mediaType: 'file',
      fileCreatedAt: file.lastModified ? new Date(file.lastModified).toISOString() : undefined,
    },
  }
}
