import { createHash } from 'node:crypto'
import { expect, test, type APIRequestContext } from '@playwright/test'

async function uploadFile(request: APIRequestContext, input: { name: string; mime: string; bytes: Buffer; metadata?: Record<string, unknown> }) {
  const contentHash = createHash('sha256').update(input.bytes).digest('hex')
  const reserve = await request.post('/api/assets/reserve', {
    data: {
      originalName: input.name,
      mimeType: input.mime,
      sizeBytes: input.bytes.byteLength,
      mediaType: input.mime.startsWith('image/') ? 'photo' : input.mime.startsWith('video/') ? 'video' : 'file',
      contentHash,
      metadata: input.metadata,
      logicalPath: '/项目/2026',
      storageBackend: 'telegram_bot',
    },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken?: string; duplicate: boolean; duplicateOfAssetId?: string; reusedStorage?: boolean }
  if (!reservation.duplicate) {
    expect(reservation.uploadToken).toBeTruthy()
    const upload = await request.put(`/api/assets/${reservation.assetId}/content`, {
      data: input.bytes,
      headers: {
        'Content-Type': input.mime,
        'Content-Length': String(input.bytes.byteLength),
        'X-Upload-Token': reservation.uploadToken as string,
      },
    })
    expect(upload.status()).toBe(201)
  }
  return { ...reservation, contentHash }
}

test('Files classification, metadata, tags, archive and compound search share one asset index', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'API platform contract only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const bytes = Buffer.from(`xlsx-metadata-${suffix}`)
  const uploaded = await uploadFile(request, {
    name: `报价表-${suffix}.xlsx`,
    mime: 'application/octet-stream',
    bytes,
    metadata: { workbookType: 'xlsx', sheetCount: 2, sheetNames: ['报价', '明细'] },
  })

  const immediateSearch = await request.get(`/api/assets?q=${encodeURIComponent(`报价表-${suffix}`)}`)
  expect(immediateSearch.ok()).toBeTruthy()
  const immediateResult = await immediateSearch.json() as { items: Array<{ id: string }> }
  expect(immediateResult.items.some((item) => item.id === uploaded.assetId)).toBeTruthy()

  const patch = await request.patch(`/api/assets/${uploaded.assetId}`, { data: { favorite: true, archived: true, logicalPath: '/客户/合同', originalName: `合同报价-${suffix}.xlsx` } })
  expect(patch.ok()).toBeTruthy()
  const tags = await request.put(`/api/assets/${uploaded.assetId}/tags`, { data: { tags: ['合同', '报价'] } })
  expect(tags.ok()).toBeTruthy()

  const shortSearch = await request.get(`/api/assets?archived=true&q=${encodeURIComponent('合同')}`)
  expect(shortSearch.ok()).toBeTruthy()
  const shortResult = await shortSearch.json() as { items: Array<{ id: string }> }
  expect(shortResult.items.some((item) => item.id === uploaded.assetId)).toBeTruthy()

  const detail = await request.get(`/api/assets/${uploaded.assetId}`)
  expect(detail.ok()).toBeTruthy()
  await expect(detail.json()).resolves.toMatchObject({
    asset: {
      extension: 'xlsx',
      fileCategory: 'spreadsheets',
      favorite: true,
      archived: true,
      logicalPath: '/客户/合同',
      metadata: { workbookType: 'xlsx', sheetCount: 2, sheetNames: ['报价', '明细'] },
    },
  })

  const takenAfter = new Date(Date.now() - 60_000).toISOString()
  const takenBefore = new Date(Date.now() + 60_000).toISOString()
  const filtered = await request.get(`/api/assets?archived=true&fileCategory=spreadsheets&extension=xlsx&tag=${encodeURIComponent('合同')}&q=${encodeURIComponent(`合同报价-${suffix}`)}&takenAfter=${encodeURIComponent(takenAfter)}&takenBefore=${encodeURIComponent(takenBefore)}&minSizeBytes=${bytes.byteLength}&maxSizeBytes=${bytes.byteLength}`)
  expect(filtered.ok()).toBeTruthy()
  const result = await filtered.json() as { items: Array<{ id: string }> }
  expect(result.items.some((item) => item.id === uploaded.assetId)).toBeTruthy()
})

test('physical dedup preserves independent logical assets and shared-object purge safety', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'storage reference safety only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const bytes = Buffer.from(`shared-storage-${suffix}`)
  const first = await uploadFile(request, { name: `first-${suffix}.pdf`, mime: 'application/pdf', bytes })
  const duplicate = await request.post('/api/assets/reserve', {
    data: {
      originalName: `second-${suffix}.pdf`,
      mimeType: 'application/pdf',
      sizeBytes: bytes.byteLength,
      mediaType: 'file',
      contentHash: first.contentHash,
      storageBackend: 'telegram_bot',
    },
  })
  expect(duplicate.status()).toBe(201)
  const second = await duplicate.json() as { assetId: string; duplicate: boolean; duplicateOfAssetId: string; reusedStorage: boolean }
  expect(second.assetId).not.toBe(first.assetId)
  expect(second).toMatchObject({ duplicate: true, duplicateOfAssetId: first.assetId, reusedStorage: true })

  expect((await request.delete(`/api/assets/${first.assetId}`)).ok()).toBeTruthy()
  const firstPurge = await request.delete(`/api/assets/${first.assetId}/purge`)
  expect(firstPurge.ok()).toBeTruthy()
  await expect(firstPurge.json()).resolves.toMatchObject({ telegramDeleted: false, sharedObjectPreserved: true })
  expect((await request.get(`/api/assets/${second.assetId}`)).ok()).toBeTruthy()

  expect((await request.delete(`/api/assets/${second.assetId}`)).ok()).toBeTruthy()
  const secondPurge = await request.delete(`/api/assets/${second.assetId}/purge`)
  expect(secondPurge.ok()).toBeTruthy()
  await expect(secondPurge.json()).resolves.toMatchObject({ sharedObjectPreserved: false })
})

test('user-group receipts are bound to the configured storage chat and purge finalize cannot skip prepare', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'bridge security contract only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const storageChatId = '-1000000000000'
  const runtime = await request.post('/api/telegram/user-group/runtime', {
    data: { connectionStatus: 'connected', storageChatId, storageChatTitle: 'ai', lastAckMessageId: 0 },
  })
  expect(runtime.ok()).toBeTruthy()

  const bytes = Buffer.from(`user-group-security-${suffix}`)
  const contentHash = createHash('sha256').update(bytes).digest('hex')
  const reserve = await request.post('/api/assets/reserve', {
    data: {
      originalName: `secure-${suffix}.jpg`, mimeType: 'image/jpeg', sizeBytes: bytes.byteLength,
      mediaType: 'photo', contentHash, storageBackend: 'telegram_user_group',
    },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }

  const forged = await request.post(`/api/assets/${reservation.assetId}/user-group-commit`, {
    data: { chatId: '-1009999999999', messageId: 91_001, sizeBytes: bytes.byteLength },
    headers: { 'X-Upload-Token': reservation.uploadToken },
  })
  expect(forged.status()).toBe(403)
  await expect(forged.json()).resolves.toMatchObject({ error: 'TELEGRAM_STORAGE_CHAT_MISMATCH' })

  const committed = await request.post(`/api/assets/${reservation.assetId}/user-group-commit`, {
    data: { chatId: storageChatId, messageId: 91_002, sizeBytes: bytes.byteLength },
    headers: { 'X-Upload-Token': reservation.uploadToken },
  })
  expect(committed.status()).toBe(201)
  expect((await request.delete(`/api/assets/${reservation.assetId}`)).ok()).toBeTruthy()

  const prematureFinalize = await request.post(`/api/assets/${reservation.assetId}/user-group-purge-finalize`, { data: {} })
  expect(prematureFinalize.status()).toBe(409)
  await expect(prematureFinalize.json()).resolves.toMatchObject({ error: 'PURGE_NOT_PREPARED' })

  const prepared = await request.post(`/api/assets/${reservation.assetId}/user-group-purge-prepare`, { data: {} })
  expect(prepared.ok()).toBeTruthy()
  await expect(prepared.json()).resolves.toMatchObject({ action: 'delete_telegram' })
  const finalized = await request.post(`/api/assets/${reservation.assetId}/user-group-purge-finalize`, { data: {} })
  expect(finalized.ok()).toBeTruthy()
})

test('trash restore, usage, activity and recovery endpoints remain coherent', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'platform API checks only need one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const asset = await uploadFile(request, { name: `restore-${suffix}.pdf`, mime: 'application/pdf', bytes: Buffer.from(`restore-${suffix}`) })

  expect((await request.delete(`/api/assets/${asset.assetId}`)).ok()).toBeTruthy()
  const trash = await request.get('/api/assets?status=trashed&limit=60')
  expect(trash.ok()).toBeTruthy()
  expect(((await trash.json()) as { items: Array<{ id: string }> }).items.some((item) => item.id === asset.assetId)).toBeTruthy()
  expect((await request.post(`/api/assets/${asset.assetId}/restore`, { data: {} })).ok()).toBeTruthy()

  const [usage, activity, integrity, searchDryRun] = await Promise.all([
    request.get('/api/usage'), request.get('/api/activity?limit=100'), request.get('/api/recovery/integrity'), request.post('/api/recovery/search-rebuild', { data: { dryRun: true } }),
  ])
  expect(usage.ok()).toBeTruthy()
  expect(activity.ok()).toBeTruthy()
  expect(integrity.ok()).toBeTruthy()
  expect(searchDryRun.ok()).toBeTruthy()
  await expect(searchDryRun.json()).resolves.toMatchObject({ ok: true, dryRun: true })
  const searchRebuild = await request.post('/api/recovery/search-rebuild', { data: { dryRun: false } })
  expect(searchRebuild.ok()).toBeTruthy()
  await expect(searchRebuild.json()).resolves.toMatchObject({ ok: true, dryRun: false, missingAfter: 0 })
  const activityItems = (await activity.json()) as { items: Array<{ action: string; assetId: string | null }> }
  expect(activityItems.items.some((item) => item.assetId === asset.assetId && item.action === 'RESTORE')).toBeTruthy()
})

test('settings exposes platform state and applies trash retention to existing trashed assets', async ({ page, request }, testInfo) => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const asset = await uploadFile(request, { name: `retention-${suffix}.pdf`, mime: 'application/pdf', bytes: Buffer.from(`retention-${suffix}`) })
  expect((await request.delete(`/api/assets/${asset.assetId}`)).ok()).toBeTruthy()

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '你的档案' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '回收站保留' })).toBeVisible()
  await page.getByText('高级与诊断', { exact: true }).click()
  await expect(page.locator('#settings-advanced').getByText('Bot Token', { exact: true })).toBeVisible()
  await expect(page.getByText('Cloudflare Access', { exact: true }).last()).toBeVisible()

  for (const [label, expectedDays] of [['7 天', 7], ['90 天', 90], ['永久保留', null], ['30 天', 30]] as const) {
    const button = page.getByRole('button', { name: label })
    await button.click()
    await expect(button).toHaveClass(/active/)
    const policy = await request.get('/api/trash-policy')
    expect(policy.ok()).toBeTruthy()
    expect((await policy.json() as { retentionDays: number | null }).retentionDays).toBe(expectedDays)
    const detail = await request.get(`/api/assets/${asset.assetId}`)
    expect(detail.ok()).toBeTruthy()
    const trashed = (await detail.json() as { asset: { deletedAt: string | null; purgeAt: string | null } }).asset
    if (expectedDays === null) {
      expect(trashed.purgeAt).toBeNull()
    } else {
      expect(trashed.deletedAt).toBeTruthy()
      const deltaDays = (Date.parse(trashed.purgeAt as string) - Date.parse(trashed.deletedAt as string)) / 86_400_000
      expect(Math.abs(deltaDays - expectedDays)).toBeLessThan(0.01)
    }
  }

  if (testInfo.project.name === 'desktop') {
    const webhook = await request.post('/api/telegram/webhook', {
      data: {
        update_id: Date.now() * 10 + Math.floor(Math.random() * 10),
        message: {
          message_id: 88_765,
          date: Math.floor(Date.now() / 1000),
          chat: { id: 10001, type: 'private', username: 'settings-owner', first_name: 'Owner' },
          from: { id: 10001, is_bot: false },
          text: '/start',
        },
      },
      headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
    })
    expect(webhook.ok()).toBeTruthy()
    await page.getByRole('button', { name: '刷新 Telegram' }).click()
    await expect(page.getByText('10001', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: '设为本人 + 存储' }).click()
    await expect.poll(async () => {
      const response = await request.get('/api/settings/status')
      const status = await response.json() as { telegram: { ownerConfigured: boolean; storageChatConfigured: boolean } }
      return status.telegram.ownerConfigured && status.telegram.storageChatConfigured
    }).toBe(true)
  }
})

test('trash shows source and metadata and opens a read-only viewer when preview is unavailable', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'trash detail flow only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const name = `trash-ledger-${suffix}.pdf`
  const asset = await uploadFile(request, { name, mime: 'application/pdf', bytes: Buffer.from(`trash-ledger-${suffix}`) })
  expect((await request.delete(`/api/assets/${asset.assetId}`)).ok()).toBeTruthy()

  await page.goto('/trash')
  const card = page.locator('.trash-card').filter({ hasText: name })
  await expect(card).toBeVisible()
  await expect(card.getByText('网页导入', { exact: true }).first()).toBeVisible()
  await expect(card.getByText('删除时间', { exact: true })).toBeVisible()
  await expect(card.getByText('导入时间', { exact: true })).toBeVisible()
  await expect(card.getByText('预览不可用', { exact: true })).toBeVisible()
  await card.getByRole('button', { name: `查看 ${name}` }).click()

  const viewer = page.getByRole('dialog', { name: `查看 ${name}` })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByText('网页导入', { exact: true })).toBeVisible()
  await expect(viewer.getByText('此项目位于回收站。')).toBeVisible()
  await expect(viewer.getByRole('button', { name: '移入回收站' })).toHaveCount(0)
  await viewer.getByRole('button', { name: '关闭' }).click()
})

test('settings distinguishes worker failure from Access expiry and retry performs a new fetch', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'settings error semantics only need one browser project')
  let attempts = 0
  await page.route('**/api/settings/status', async (route) => {
    attempts += 1
    if (attempts === 1) return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'D1_QUERY_FAILED' }) })
    return route.continue()
  })

  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '设置服务暂时不可用' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新验证 Cloudflare Access' })).toHaveCount(0)
  await page.getByRole('button', { name: '重新尝试' }).click()
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible()
  expect(attempts).toBeGreaterThanOrEqual(2)
})

test('settings only offers Cloudflare Access reauthentication for a real 401', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Access error semantics only need one browser project')
  await page.route('**/api/settings/status', async (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'ACCESS_SIGN_IN_REQUIRED' }) }))
  await page.goto('/settings')
  await expect(page.getByRole('heading', { name: '需要重新验证访问权限' })).toBeVisible()
  await expect(page.getByRole('button', { name: '重新验证 Cloudflare Access' })).toBeVisible()
})

test('new product pages are reachable on desktop and mobile more menu', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'desktop') {
    for (const route of ['/recent', '/archive', '/trash', '/activity']) {
      await page.goto(route)
      await expect(page.locator('main')).toBeVisible()
      await expect(page.locator('.page-intro')).toBeVisible()
    }
    return
  }
  await page.goto('/')
  await page.getByRole('button', { name: '更多' }).click()
  const more = page.getByRole('dialog', { name: '更多导航' })
  await expect(more).toBeVisible()
  await more.getByRole('link', { name: /回收站/ }).click()
  await expect(page).toHaveURL(/\/trash$/)
  await expect(page.getByRole('heading', { name: '回收站' })).toBeVisible()
})
