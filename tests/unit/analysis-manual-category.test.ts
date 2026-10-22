import { describe, expect, it } from 'vitest'
import { toPublicAsset, type AssetRow } from '../../src/worker/domain/types'

describe('manual analysis categories', () => {
  it('preserves a manual category after the AI category changes', () => {
    const row = {
      id: 'asset-1',
      storage_backend: 'telegram_user_group',
      storage_message_id: 42,
      size_bytes: 1024,
      media_type: 'photo',
      metadata_json: null,
      primary_category: 'people',
      category_override: 'travel',
    } as AssetRow
    expect(toPublicAsset(row).primaryCategory).toBe('travel')
    const asset = toPublicAsset({ ...row, primary_category: 'city' })

    expect(asset.primaryCategory).toBe('travel')
    expect(asset.aiCategory).toBe('city')
    expect(asset.categoryOverride).toBe('travel')
    expect(asset.categorySource).toBe('manual')
  })
})
