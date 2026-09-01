import type { AssetRow } from '../../domain/types'

const PREFIX = 'PA1:'
const MAX_MANIFEST_CHARS = 900

export interface StorageManifest {
  v: 1
  a: string
  h?: string
  n: string
  m: string
  s: number
  c: string
  p?: string
  t: string
  u: string
}

export function createStorageManifest(asset: AssetRow): string {
  const manifest: StorageManifest = {
    v: 1,
    a: asset.id,
    ...(asset.content_hash ? { h: asset.content_hash } : {}),
    n: asset.original_name.slice(0, 180),
    m: asset.mime_type.slice(0, 120),
    s: asset.size_bytes,
    c: asset.file_category,
    ...(asset.logical_path && asset.logical_path !== '/' ? { p: asset.logical_path.slice(0, 180) } : {}),
    t: asset.taken_at,
    u: asset.uploaded_at,
  }
  let encoded = `${PREFIX}${JSON.stringify(manifest)}`
  if (encoded.length <= MAX_MANIFEST_CHARS) return encoded
  delete manifest.p
  manifest.n = manifest.n.slice(0, 80)
  encoded = `${PREFIX}${JSON.stringify(manifest)}`
  return encoded.slice(0, MAX_MANIFEST_CHARS)
}

export function parseStorageManifest(caption: string | undefined | null): StorageManifest | null {
  if (!caption?.startsWith(PREFIX) || caption.length > 1200) return null
  try {
    const parsed = JSON.parse(caption.slice(PREFIX.length)) as Partial<StorageManifest>
    if (parsed.v !== 1 || typeof parsed.a !== 'string' || typeof parsed.n !== 'string' || typeof parsed.m !== 'string') return null
    if (typeof parsed.s !== 'number' || !Number.isSafeInteger(parsed.s) || parsed.s < 0) return null
    if (typeof parsed.c !== 'string' || typeof parsed.t !== 'string' || typeof parsed.u !== 'string') return null
    if (parsed.h !== undefined && (typeof parsed.h !== 'string' || !/^[a-f0-9]{64}$/i.test(parsed.h))) return null
    return parsed as StorageManifest
  } catch {
    return null
  }
}
