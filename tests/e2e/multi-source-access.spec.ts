import { expect, test } from '@playwright/test'

function tokenFromShareUrl(url: string): string {
  const parsed = new URL(url)
  const match = parsed.hash.match(/^#\/share\/(.+)$/)
  if (!match) throw new Error('share token missing from URL fragment')
  return decodeURIComponent(match[1])
}

async function seedBase(page: import('@playwright/test').Page) {
  const response = await page.request.post('/api/dev/seed')
  expect(response.ok()).toBeTruthy()
  const assets = await page.request.get('/api/assets?limit=60')
  expect(assets.ok()).toBeTruthy()
  return (await assets.json() as { items: Array<{ id: string; sourceId: string }> }).items
}

async function createSourceAsset(page: import('@playwright/test').Page) {
  const sourceResponse = await page.request.post('/api/telegram/sources', {
    data: { displayName: 'Family Source', botToken: '123456789:mock-family-source-token-abcdefghijklmnopqrstuvwxyz' },
  })
  expect(sourceResponse.status()).toBe(201)
  const sourceBody = await sourceResponse.json() as { item: { id: string; tokenConfigured: boolean } }
  expect(sourceBody.item.tokenConfigured).toBe(true)
  const sourceId = sourceBody.item.id

  const bind = await page.request.post(`/api/telegram/sources/${sourceId}/bind`, { data: { chatId: '-1002000000001' } })
  expect(bind.ok()).toBeTruthy()

  const update = {
    update_id: 900001,
    channel_post: {
      message_id: 701,
      date: Math.floor(Date.now() / 1000),
      chat: { id: -1002000000001, type: 'channel', title: 'Family Archive' },
      document: {
        file_id: 'family-file-id',
        file_unique_id: 'seed-unique-0',
        file_name: 'family-note.pdf',
        mime_type: 'application/pdf',
        file_size: 1024,
      },
    },
  }
  const webhook = await page.request.post(`/api/telegram/webhook/${sourceId}`, {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
    data: update,
  })
  expect(webhook.status()).toBe(201)
  const webhookBody = await webhook.json() as { assetId: string }
  return { sourceId, assetId: webhookBody.assetId }
}

test('multi-source storage identity and source-scoped share are enforced server-side', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'API security matrix only needs one browser project')

  const legacyAssets = await seedBase(page)
  expect(legacyAssets.length).toBeGreaterThan(0)
  const legacyAsset = legacyAssets[0]
  expect(legacyAsset.sourceId).toBe('telegram-legacy')

  const { sourceId, assetId } = await createSourceAsset(page)

  const ownerSources = await page.request.get('/api/telegram/sources')
  const sourceJson = await ownerSources.json() as { items: Array<Record<string, unknown>> }
  const family = sourceJson.items.find((item) => item.id === sourceId)
  expect(family).toMatchObject({ id: sourceId, enabled: true, tokenConfigured: true, assetCount: 1 })
  expect(JSON.stringify(sourceJson)).not.toContain('mock-family-source-token')
  expect(JSON.stringify(sourceJson)).not.toContain('token_ciphertext')
  expect(JSON.stringify(sourceJson)).not.toContain('token_iv')

  const ownerAssets = await page.request.get('/api/assets?limit=60')
  const ownerAssetJson = await ownerAssets.json() as { items: Array<{ id: string; sourceId: string }> }
  expect(ownerAssetJson.items.some((item) => item.id === assetId && item.sourceId === sourceId)).toBe(true)
  expect(ownerAssetJson.items.some((item) => item.sourceId === 'telegram-legacy')).toBe(true)

  const shareCreate = await page.request.post('/api/access/shares', {
    data: { name: 'Family viewer', scopeType: 'source', scopeId: sourceId, allowDownload: false, expiresInDays: 7 },
  })
  expect(shareCreate.status()).toBe(201)
  const shareCreateBody = await shareCreate.json() as { item: { id: string }; url: string }
  const rawToken = tokenFromShareUrl(shareCreateBody.url)

  const listBeforeExchange = await page.request.get('/api/access/shares')
  const listText = await listBeforeExchange.text()
  expect(listText).not.toContain(rawToken)
  expect(listText).not.toContain('token_hash')

  const exchange = await page.request.post('/api/share/exchange', { data: { token: rawToken } })
  expect(exchange.ok()).toBeTruthy()
  expect(exchange.headers()['set-cookie']).toContain('HttpOnly')
  expect(exchange.headers()['set-cookie']).toContain('SameSite=Lax')

  const disable = await page.request.post(`/api/telegram/sources/${sourceId}/enabled`, { data: { enabled: false } })
  expect(disable.ok()).toBeTruthy()
  const disabledWebhook = await page.request.post(`/api/telegram/webhook/${sourceId}`, {
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
    data: {
      update_id: 900002,
      channel_post: {
        message_id: 702,
        date: Math.floor(Date.now() / 1000),
        chat: { id: -1002000000001, type: 'channel', title: 'Family Archive' },
        document: { file_id: 'blocked-file-id', file_unique_id: 'blocked-unique-id', file_name: 'blocked.pdf', mime_type: 'application/pdf', file_size: 512 },
      },
    },
  })
  expect(disabledWebhook.ok()).toBeTruthy()
  expect((await disabledWebhook.json() as { ignored: string }).ignored).toBe('TELEGRAM_SOURCE_DISABLED')
  const existingStillReadable = await page.request.get(`/api/assets/${assetId}/preview`)
  expect(existingStillReadable.ok()).toBeTruthy()

  const sharedAssets = await page.request.get('/api/share/assets?limit=60')
  expect(sharedAssets.ok()).toBeTruthy()
  const sharedJson = await sharedAssets.json() as { items: Array<{ id: string; sourceId: string; downloadSupported: boolean; originalAvailableInApp: boolean; mediaUrl: string | null }> }
  expect(sharedJson.items.map((item) => item.id)).toEqual([assetId])
  // Shared principals must not learn the owner's internal Telegram source identifier.
  expect(sharedJson.items[0].sourceId).toBe('shared')
  expect(sharedJson.items[0].downloadSupported).toBe(false)
  expect(sharedJson.items[0].originalAvailableInApp).toBe(false)
  expect(sharedJson.items[0].mediaUrl).toBeNull()

  const search = await page.request.get('/api/share/assets?q=family&limit=60')
  expect((await search.json() as { items: Array<{ id: string }> }).items.map((item) => item.id)).toEqual([assetId])

  const allowedDetail = await page.request.get(`/api/share/assets/${assetId}`)
  expect(allowedDetail.ok()).toBeTruthy()
  const deniedDetail = await page.request.get(`/api/share/assets/${legacyAsset.id}`)
  expect(deniedDetail.status()).toBe(404)
  const deniedPreview = await page.request.get(`/api/share/assets/${legacyAsset.id}/preview`)
  expect(deniedPreview.status()).toBe(404)
  const deniedMedia = await page.request.get(`/api/share/assets/${legacyAsset.id}/media`)
  expect(deniedMedia.status()).toBe(404)
  const deniedMediaForReadableAsset = await page.request.get(`/api/share/assets/${assetId}/media`)
  expect(deniedMediaForReadableAsset.status()).toBe(404)
  const deniedDownload = await page.request.get(`/api/share/assets/${assetId}/download`)
  expect(deniedDownload.status()).toBe(404)

  const timeline = await page.request.get('/api/share/timeline/months')
  const timelineJson = await timeline.json() as { items: Array<{ asset_count: number }> }
  expect(timelineJson.items.reduce((sum, item) => sum + Number(item.asset_count), 0)).toBe(1)

  const revoke = await page.request.post(`/api/access/shares/${shareCreateBody.item.id}/revoke`, { data: {} })
  expect(revoke.ok()).toBeTruthy()
  const afterRevoke = await page.request.get('/api/share/assets?limit=60')
  expect(afterRevoke.status()).toBe(401)
})

test('download grant permits only the granted asset and rotation invalidates prior sessions', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'API security matrix only needs one browser project')

  const legacyAssets = await seedBase(page)
  const target = legacyAssets[0]
  const other = legacyAssets[1]

  const create = await page.request.post('/api/access/shares', {
    data: { name: 'Single asset download', scopeType: 'asset', scopeId: target.id, allowDownload: true, expiresInDays: 1 },
  })
  const created = await create.json() as { item: { id: string }; url: string }
  const token = tokenFromShareUrl(created.url)
  expect((await page.request.post('/api/share/exchange', { data: { token } })).ok()).toBeTruthy()

  const allowed = await page.request.get(`/api/share/assets/${target.id}/download`)
  expect(allowed.ok()).toBeTruthy()
  const otherDenied = await page.request.get(`/api/share/assets/${other.id}`)
  expect(otherDenied.status()).toBe(404)

  const rotate = await page.request.post(`/api/access/shares/${created.item.id}/rotate`, { data: {} })
  expect(rotate.ok()).toBeTruthy()
  const oldSession = await page.request.get('/api/share/assets')
  expect(oldSession.status()).toBe(401)
  const rotatedBody = await rotate.json() as { url: string }
  const newToken = tokenFromShareUrl(rotatedBody.url)
  expect(newToken).not.toBe(token)
  expect((await page.request.post('/api/share/exchange', { data: { token: newToken } })).ok()).toBeTruthy()
  expect((await page.request.get(`/api/share/assets/${target.id}`)).ok()).toBeTruthy()
})

test('shared surface is usable at mobile width without owner shell', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile-specific shared surface check')

  const legacyAssets = await seedBase(page)
  const target = legacyAssets[0]
  const create = await page.request.post('/api/access/shares', {
    data: { name: 'Mobile shared archive', scopeType: 'asset', scopeId: target.id, allowDownload: false, expiresInDays: 7 },
  })
  const created = await create.json() as { url: string }
  const token = tokenFromShareUrl(created.url)
  await page.goto(`/?app=shared#/share/${encodeURIComponent(token)}`)
  await expect(page.getByRole('heading', { name: 'Mobile shared archive' })).toBeVisible()
  await expect(page.locator('.share-page')).toBeVisible()
  await expect(page.locator('.app-shell')).toHaveCount(0)
  await expect(page.locator('.mobile-nav-dock')).toHaveCount(0)
  await expect(page.locator('.share-grid')).toBeVisible()
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)
  expect(horizontalOverflow).toBe(false)
})
