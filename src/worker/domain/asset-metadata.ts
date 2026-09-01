import type { MediaType } from './types'

export type FileCategory = 'documents' | 'spreadsheets' | 'images' | 'archives' | 'video' | 'audio' | 'code' | 'other'

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
  md: 'text/markdown',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xlsm: 'application/vnd.ms-excel.sheet.macroEnabled.12',
  csv: 'text/csv',
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  rar: 'application/vnd.rar',
  tar: 'application/x-tar',
  'tar.gz': 'application/gzip',
  tgz: 'application/gzip',
  gz: 'application/gzip',
  json: 'application/json',
  xml: 'application/xml',
  yaml: 'application/yaml',
  yml: 'application/yaml',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  mp4: 'video/mp4',
  webm: 'video/webm',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
}

const DOCUMENT_EXTENSIONS = new Set(['pdf', 'doc', 'docx', 'txt', 'md', 'rtf', 'odt'])
const SPREADSHEET_EXTENSIONS = new Set(['xls', 'xlsx', 'xlsm', 'csv', 'ods'])
const ARCHIVE_EXTENSIONS = new Set(['zip', '7z', 'rar', 'tar', 'tar.gz', 'tgz', 'gz'])
const AUDIO_EXTENSIONS = new Set(['mp3', 'wav', 'm4a', 'flac', 'aac', 'ogg'])
const CODE_EXTENSIONS = new Set(['json', 'xml', 'yaml', 'yml', 'js', 'ts', 'tsx', 'jsx', 'py', 'go', 'rs', 'java', 'c', 'cpp', 'h', 'css', 'html', 'sql', 'toml'])

export function inferExtension(fileName: string): string {
  const lower = fileName.trim().toLowerCase()
  if (lower.endsWith('.tar.gz')) return 'tar.gz'
  const separator = lower.lastIndexOf('.')
  if (separator <= 0 || separator === lower.length - 1) return ''
  const extension = lower.slice(separator + 1)
  return /^[a-z0-9][a-z0-9+_-]{0,15}$/.test(extension) ? extension : ''
}

export function normalizeMimeType(fileName: string, mimeType: string | undefined | null): string {
  const normalized = mimeType?.trim().toLowerCase()
  if (normalized && normalized !== 'application/octet-stream') return normalized.slice(0, 160)
  const extension = inferExtension(fileName)
  return MIME_BY_EXTENSION[extension] ?? (normalized || 'application/octet-stream')
}

export function classifyFileCategory(fileName: string, mimeType: string, mediaType: MediaType): FileCategory {
  const extension = inferExtension(fileName)
  const normalizedMime = normalizeMimeType(fileName, mimeType)
  if (mediaType === 'photo' || normalizedMime.startsWith('image/')) return 'images'
  if (mediaType === 'video' || normalizedMime.startsWith('video/')) return 'video'
  if (normalizedMime.startsWith('audio/') || AUDIO_EXTENSIONS.has(extension)) return 'audio'
  if (SPREADSHEET_EXTENSIONS.has(extension)) return 'spreadsheets'
  if (DOCUMENT_EXTENSIONS.has(extension)) return 'documents'
  if (ARCHIVE_EXTENSIONS.has(extension)) return 'archives'
  if (CODE_EXTENSIONS.has(extension) || normalizedMime.includes('json') || normalizedMime.includes('xml')) return 'code'
  return 'other'
}

export function sanitizeLogicalPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '/'
  const normalized = value.replaceAll('\\', '/').replace(/\/+/g, '/').trim()
  if (normalized.includes('\0')) return '/'
  const parts = normalized.split('/').filter(Boolean).filter((part) => part !== '.' && part !== '..')
  const safe = parts.map((part) => part.replace(/[<>:"|?*]/g, '').split('').filter((char) => char.charCodeAt(0) >= 32).join('').trim()).filter(Boolean).slice(0, 32)
  const path = `/${safe.join('/')}`
  return path.length <= 512 ? path : path.slice(0, 512)
}

export function sanitizeMetadata(value: unknown): Record<string, string | number | boolean | string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const source = value as Record<string, unknown>
  const output: Record<string, string | number | boolean | string[]> = {}
  for (const [rawKey, rawValue] of Object.entries(source).slice(0, 40)) {
    const key = rawKey.trim().replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 64)
    if (!key) continue
    if (typeof rawValue === 'string') output[key] = rawValue.slice(0, 1000)
    else if (typeof rawValue === 'number' && Number.isFinite(rawValue)) output[key] = rawValue
    else if (typeof rawValue === 'boolean') output[key] = rawValue
    else if (Array.isArray(rawValue)) output[key] = rawValue.filter((item): item is string => typeof item === 'string').slice(0, 100).map((item) => item.slice(0, 200))
  }
  return Object.keys(output).length ? output : undefined
}
