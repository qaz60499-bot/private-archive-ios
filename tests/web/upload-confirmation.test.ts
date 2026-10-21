import { afterEach, describe, expect, it, vi } from 'vitest'
import { api } from '../../src/web/lib/api'

const assetId = 'asset-confirmed'
const receipt = { chatId: '-100123', messageId: 42, sizeBytes: 5 }
const storedStatuses = ['stored', 'queued', 'analyzing', 'ready', 'limited']
const invalidConfirmations: Array<[string, unknown]> = [
  ['empty response', {}],
  ['null response', null],
  ['missing asset', { asset: null }],
  ['different asset id', { asset: { id: 'another-asset', status: 'stored' } }],
  ['reservation is still pending', { asset: { id: assetId, status: 'pending_upload' } }],
  ['upload failed', { asset: { id: assetId, status: 'failed' } }],
  ['asset was trashed', { asset: { id: assetId, status: 'trashed' } }],
  ['response includes an error', { error: 'STORAGE_UPLOAD_FAILED', asset: { id: assetId, status: 'stored' } }],
]

function stubJsonResponse(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(body), {
    status: 201,
    headers: { 'Content-Type': 'application/json' },
  })))
}

const submitters = [
  ['Bot content upload', () => api.uploadContent(assetId, 'token', new Blob(['bytes'], { type: 'application/pdf' }))],
  ['Telegram group receipt', () => api.commitUserGroupUpload(assetId, 'token', receipt)],
] as const

afterEach(() => vi.unstubAllGlobals())

describe.each(submitters)('%s confirmation', (_name, submit) => {
  it.each(storedStatuses)('accepts a matching asset in %s state', async (status) => {
    stubJsonResponse({ asset: { id: assetId, status }, alreadyStored: false, previewAvailable: true })

    const result = await submit()

    expect(result.asset).toMatchObject({ id: assetId, status })
  })

  it.each(invalidConfirmations)('rejects %s without confirming upload', async (_name, body) => {
    stubJsonResponse(body)

    await expect(submit()).rejects.toMatchObject({ status: 502, code: 'UPLOAD_CONFIRMATION_INVALID' })
  })
})
