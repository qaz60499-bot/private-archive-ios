const SAFE_INLINE_IMAGE_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/heic',
  'image/heif',
])

function baseMimeType(value: string | null | undefined): string {
  return (value ?? '').split(';', 1)[0].trim().toLowerCase()
}

export function isSafeInlineMediaType(value: string | null | undefined): boolean {
  const mimeType = baseMimeType(value)
  return SAFE_INLINE_IMAGE_TYPES.has(mimeType) || mimeType.startsWith('video/') || mimeType.startsWith('audio/')
}

export function applySafeMediaHeaders(headers: Headers, options: {
  fileName: string
  mimeType: string | null | undefined
  download?: boolean
}): Headers {
  const mimeType = baseMimeType(options.mimeType) || 'application/octet-stream'
  const inline = !options.download && isSafeInlineMediaType(mimeType)
  headers.set('Content-Type', inline ? mimeType : 'application/octet-stream')
  headers.set('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(options.fileName)}`)
  headers.set('X-Content-Type-Options', 'nosniff')
  if (!inline) headers.set('Content-Security-Policy', 'sandbox')
  return headers
}
