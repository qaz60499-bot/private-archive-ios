import { describe, expect, it } from 'vitest'
import { applySafeMediaHeaders, isSafeInlineMediaType, resolveOriginalMediaMimeType } from '../../src/worker/lib/media-response'

describe('safe media response headers', () => {
  it('keeps passive media inline', () => {
    expect(isSafeInlineMediaType('image/jpeg')).toBe(true)
    const headers = applySafeMediaHeaders(new Headers(), { fileName: 'photo.jpg', mimeType: 'image/jpeg' })
    expect(headers.get('Content-Type')).toBe('image/jpeg')
    expect(headers.get('Content-Disposition')).toContain('inline')
    expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
  })

  it('corrects legacy video MIME metadata from the original filename', () => {
    expect(resolveOriginalMediaMimeType({ fileName: 'IMG_3349.MOV', upstreamMimeType: 'application/octet-stream', storedMimeType: 'video/mp4' })).toBe('video/quicktime')
    expect(resolveOriginalMediaMimeType({ fileName: 'clip.mp4', upstreamMimeType: 'application/octet-stream', storedMimeType: 'video/quicktime' })).toBe('video/mp4')
  })

  it('forces active content to download without its executable MIME type', () => {
    for (const mimeType of ['text/html', 'image/svg+xml', 'application/xml', 'application/pdf']) {
      expect(isSafeInlineMediaType(mimeType)).toBe(false)
      const headers = applySafeMediaHeaders(new Headers(), { fileName: 'payload.bin', mimeType })
      expect(headers.get('Content-Type')).toBe('application/octet-stream')
      expect(headers.get('Content-Disposition')).toContain('attachment')
      expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
      expect(headers.get('Content-Security-Policy')).toBe('sandbox')
    }
  })
})
