import { createHash, randomUUID } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('content commit and idempotent replay return bound proof; invalid capabilities return none', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'server protocol is independent of browser viewport')
  const bytes = Buffer.from(`native-commit-proof:${randomUUID()}`)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const input = {
    originalName: 'native-commit-proof.bin', mimeType: 'application/octet-stream', mediaType: 'file',
    sizeBytes: bytes.length, contentHash: hash, storageBackend: 'telegram_bot', importOrigin: 'ios-background',
  }
  const reserve = await request.post('/api/assets/reserve', { data: input })
  expect(reserve.status()).toBe(201)
  const { assetId, uploadToken } = await reserve.json() as { assetId: string; uploadToken: string }
  const upload = (token: string) => request.put(`/api/assets/${assetId}/content`, {
    data: bytes, headers: { 'Content-Type': input.mimeType, 'Content-Length': String(bytes.length), 'X-Upload-Token': token },
  })

  const rejected = await upload('invalid-capability')
  expect(rejected.status()).toBe(401)
  expect(rejected.headers()['x-pa-upload-commit']).toBeUndefined()

  for (const expectedStatus of [201, 200]) {
    const response = await upload(uploadToken)
    expect(response.status()).toBe(expectedStatus)
    const headers = response.headers()
    expect(headers['x-pa-upload-commit']).toBe('v1')
    expect(headers['x-pa-asset-id']).toBe(assetId)
    expect(headers['x-pa-storage-backend']).toBe('telegram_bot')
    expect(headers['x-pa-size-bytes']).toBe(String(bytes.length))
    expect(headers['x-pa-content-sha256']).toBe(hash)
    expect(['stored', 'queued', 'analyzing', 'ready', 'limited']).toContain(headers['x-pa-asset-status'])
    expect(headers['cache-control']).toBe('private, no-store')
    expect(Object.values(headers)).not.toContain(uploadToken)
    const body = await response.json() as { asset: { id: string; status: string } }
    expect(body.asset.id).toBe(assetId)
    expect(body.asset.status).toBe(headers['x-pa-asset-status'])
  }

  const duplicate = await request.post('/api/assets/reserve', { data: input })
  expect(duplicate.status()).toBe(200)
  await expect(duplicate.json()).resolves.toMatchObject({ assetId, duplicate: true, reusedStorage: true })
})
