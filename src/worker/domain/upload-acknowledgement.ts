import type { AssetRow } from './types'

type StoredAsset = Pick<AssetRow, 'id' | 'status' | 'storage_backend' | 'size_bytes' | 'content_hash' | 'storage_file_id' | 'deleted_at' | 'purge_state'>

// Background URLSession can deliver a successful upload response without its JSON
// body. Publish the same durable commit as bounded headers, using the committed row
// already read by the content route. These are never a substitute for authorization,
// token validation, or markStored's exact-lease transaction.
export function storedUploadAcknowledgementHeaders(asset: StoredAsset | null): Record<string, string> {
  if (!asset || asset.storage_backend !== 'telegram_bot' || !asset.storage_file_id
    || asset.deleted_at !== null || asset.purge_state !== 'active'
    || !['stored', 'queued', 'analyzing', 'ready', 'limited'].includes(asset.status)
    || !/^[a-zA-Z0-9_-]{1,128}$/.test(asset.id)
    || !Number.isSafeInteger(asset.size_bytes) || asset.size_bytes <= 0
    || !asset.content_hash || !/^[a-f0-9]{64}$/.test(asset.content_hash)) return {}

  return {
    'X-PA-Upload-Commit': 'v1',
    'X-PA-Asset-Id': asset.id,
    'X-PA-Storage-Backend': asset.storage_backend,
    'X-PA-Size-Bytes': String(asset.size_bytes),
    'X-PA-Content-SHA256': asset.content_hash,
    'X-PA-Asset-Status': asset.status,
  }
}
