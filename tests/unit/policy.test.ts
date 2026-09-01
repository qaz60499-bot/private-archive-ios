import { describe, expect, it } from 'vitest'
import {
  MAX_UPLOAD_BYTES,
  TELEGRAM_GET_FILE_LIMIT,
  getSizeTier,
  inferMediaType,
  normalizeTags,
  selectTakenAt,
  validateReserveInput,
} from '../../src/worker/domain/policy'

describe('storage size policy', () => {
  it('keeps new Bot writes inside the recoverable 20 MB boundary', () => {
    expect(MAX_UPLOAD_BYTES).toBe(TELEGRAM_GET_FILE_LIMIT)
    expect(getSizeTier(TELEGRAM_GET_FILE_LIMIT, 'telegram_bot')).toBe('full')
    expect(getSizeTier(TELEGRAM_GET_FILE_LIMIT + 1, 'telegram_bot')).toBe('rejected')
  })

  it('does not apply the Bot getFile boundary to User Group storage', () => {
    expect(getSizeTier(TELEGRAM_GET_FILE_LIMIT + 1, 'telegram_user_group')).toBe('full')
    expect(getSizeTier(100 * 1024 * 1024, 'telegram_user_group')).toBe('full')
  })
})

describe('reserve input validation', () => {
  it('infers media type and normalizes the file name', () => {
    const result = validateReserveInput({
      originalName: '  photo.jpg  ',
      mimeType: 'image/jpeg',
      sizeBytes: 1234,
    })
    expect(result.originalName).toBe('photo.jpg')
    expect(result.mediaType).toBe('photo')
  })

  it('rejects files larger than the Telegram Bot upload contract', () => {
    expect(() => validateReserveInput({
      originalName: 'too-large.zip',
      mimeType: 'application/zip',
      sizeBytes: MAX_UPLOAD_BYTES + 1,
      storageBackend: 'telegram_bot',
    })).toThrow('FILE_TOO_LARGE')
  })

  it('accepts only normalized SHA-256 content hashes', () => {
    const hash = 'A'.repeat(64)
    expect(validateReserveInput({ originalName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100, contentHash: hash }).contentHash).toBe('a'.repeat(64))
    expect(() => validateReserveInput({ originalName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100, contentHash: 'not-a-hash' })).toThrow('INVALID_CONTENT_HASH')
  })

  it('rejects control characters in file names and MIME headers', () => {
    expect(() => validateReserveInput({ originalName: 'photo\n.jpg', mimeType: 'image/jpeg', sizeBytes: 100 })).toThrow('INVALID_FILE_NAME')
    expect(() => validateReserveInput({ originalName: 'photo.jpg', mimeType: 'image/jpeg\r\nX-Test: injected', sizeBytes: 100 })).toThrow('INVALID_MIME_TYPE')
  })

  it('classifies common MIME types deterministically', () => {
    expect(inferMediaType('image/webp')).toBe('photo')
    expect(inferMediaType('video/mp4')).toBe('video')
    expect(inferMediaType('application/pdf')).toBe('file')
  })

  it('derives media type on the server instead of trusting a spoofed client category', () => {
    expect(validateReserveInput({ originalName: 'page.html', mimeType: 'text/html', sizeBytes: 100, mediaType: 'photo' }).mediaType).toBe('file')
    expect(validateReserveInput({ originalName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100, mediaType: 'file' }).mediaType).toBe('photo')
  })

  it('rejects invalid dimensions, duration, and GPS ranges', () => {
    const base = { originalName: 'photo.jpg', mimeType: 'image/jpeg', sizeBytes: 100 }
    expect(() => validateReserveInput({ ...base, width: 0 })).toThrow('INVALID_WIDTH')
    expect(() => validateReserveInput({ ...base, height: -1 })).toThrow('INVALID_HEIGHT')
    expect(() => validateReserveInput({ ...base, durationMs: -1 })).toThrow('INVALID_DURATIONMS')
    expect(() => validateReserveInput({ ...base, latitude: 91 })).toThrow('INVALID_LATITUDE')
    expect(() => validateReserveInput({ ...base, longitude: -181 })).toThrow('INVALID_LONGITUDE')
  })
})

describe('metadata precedence and tags', () => {
  it('prefers EXIF time over file, Telegram, and upload timestamps', () => {
    expect(selectTakenAt({
      exifTakenAt: '2026-01-02T03:04:05Z',
      fileCreatedAt: '2026-02-02T03:04:05Z',
      telegramDate: '2026-03-02T03:04:05Z',
      uploadedAt: '2026-04-02T03:04:05Z',
    })).toBe('2026-01-02T03:04:05.000Z')
  })

  it('drops unknown tags, deduplicates, and falls back to other', () => {
    expect(normalizeTags(['People', 'people', 'city', 'not-allowed'])).toEqual(['people', 'city'])
    expect(normalizeTags(['not-allowed'])).toEqual(['other'])
    expect(normalizeTags(null)).toEqual(['other'])
  })
})
