import { describe, expect, it } from 'vitest'
import { toPublicAsset, type AssetRow } from '../../src/worker/domain/types'

function row(patch: Partial<AssetRow> = {}): AssetRow {
  return {
    id: 'asset-1',
    storage_provider: 'telegram',
    storage_backend: 'telegram_user_group',
    storage_chat_id: '-1001234567890',
    storage_message_id: 42,
    storage_file_id: 'mtproto-message:42',
    storage_file_unique_id: 'mtproto-message:-1001234567890:42',
    telegram_media_id: '123456789',
    import_origin: 'telegram_user_group',
    preview_message_id: null,
    preview_file_id: null,
    source: 'telegram',
    media_type: 'photo',
    mime_type: 'image/jpeg',
    original_name: 'photo.jpg',
    size_bytes: 30 * 1024 * 1024,
    content_hash: null,
    workspace_id: 'personal',
    source_id: 'telegram-legacy',
    storage_object_id: 'obj-1',
    extension: 'jpg',
    file_category: 'images',
    metadata_json: null,
    archived: 0,
    archived_at: null,
    pre_trash_status: null,
    deleted_at: null,
    purge_at: null,
    purge_state: 'active',
    purge_error: null,
    logical_path: '/',
    last_viewed_at: null,
    width: 100,
    height: 100,
    duration_ms: null,
    taken_at: '2026-08-31T00:00:00.000Z',
    uploaded_at: '2026-08-31T00:00:00.000Z',
    latitude: null,
    longitude: null,
    place_id: null,
    primary_category: null,
    category_override: null,
    category_override_at: null,
    person_count: null,
    scene: null,
    favorite: 0,
    status: 'ready',
    analysis_status: 'ready',
    telegram_url: null,
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    ...patch,
  }
}

describe('dual storage public routing', () => {
  it('routes User Group preview and original through the ACL-gated local asset endpoint', () => {
    const asset = toPublicAsset(row())
    expect(asset.storageBackend).toBe('telegram_user_group')
    expect(asset.previewUrl).toBe('/__telegram_storage/asset/asset-1/file?variant=preview')
    expect(asset.mediaUrl).toBe('/__telegram_storage/asset/asset-1/file?variant=original')
    expect(asset.originalAvailableInApp).toBe(true)
    expect(asset.downloadSupported).toBe(true)
    expect(asset).not.toHaveProperty('storageChatId')
    expect(asset).not.toHaveProperty('storageMessageId')
    expect(asset).not.toHaveProperty('telegramMediaId')
  })

  it('keeps legacy Bot media on Worker routes and does not advertise unsafe new Bot writes', () => {
    const asset = toPublicAsset(row({
      storage_backend: 'telegram_bot',
      storage_file_id: 'bot-file',
      storage_file_unique_id: 'bot-unique',
      telegram_media_id: null,
      import_origin: 'telegram_bot',
      preview_file_id: 'bot-preview',
      size_bytes: 30 * 1024 * 1024,
    }))
    expect(asset.previewUrl).toBe('/api/assets/asset-1/preview')
    expect(asset.mediaUrl).toBeNull()
    expect(asset.originalAvailableInApp).toBe(false)
    expect(asset.downloadSupported).toBe(false)
    expect(asset.uploadSupported).toBe(false)
  })

  it('honors application download ACLs for User Group originals', () => {
    const asset = toPublicAsset(row(), undefined, { allowDownload: false })
    expect(asset.previewSupported).toBe(true)
    expect(asset.downloadSupported).toBe(false)
    expect(asset.originalAvailableInApp).toBe(false)
    expect(asset.mediaUrl).toBeNull()
  })

  it('does not advertise an original-file fallback as a preview for Bot assets without download permission', () => {
    const asset = toPublicAsset(row({
      storage_backend: 'telegram_bot',
      storage_file_id: 'bot-original',
      storage_file_unique_id: 'bot-original-unique',
      preview_file_id: null,
      size_bytes: 1024,
    }), undefined, { allowDownload: false })
    expect(asset.previewSupported).toBe(false)
    expect(asset.downloadSupported).toBe(false)
    expect(asset.originalAvailableInApp).toBe(false)
    expect(asset.mediaUrl).toBeNull()
  })
})
