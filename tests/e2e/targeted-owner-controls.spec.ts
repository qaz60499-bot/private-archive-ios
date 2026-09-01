import { createHash } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

const ownerPassword = 'OwnerControls!2026'
const memberPassword = 'MemberControls!2026'
const BOT_LIMIT = 20 * 1024 * 1024

function sessionToken(setCookie: string | undefined): string {
  const match = setCookie?.match(/(?:^|;\s*)pa_account=([^;]+)/)
  if (!match?.[1]) throw new Error('pa_account cookie missing')
  return decodeURIComponent(match[1])
}

async function loginApi(username: string, password: string, ip: string): Promise<APIRequestContext> {
  const anonymous = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8799', extraHTTPHeaders: { 'X-Forwarded-For': ip } })
  const login = await anonymous.post('/api/auth/login', { data: { username, password } })
  expect(login.status()).toBe(200)
  const token = sessionToken(login.headers()['set-cookie'])
  await anonymous.dispose()
  return playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: `pa_account=${encodeURIComponent(token)}`, 'X-Forwarded-For': ip },
  })
}

async function uploadOwnerAsset(request: APIRequestContext, input: { name: string; sourceId?: string }) {
  const bytes = Buffer.from(`targeted-owner-controls:${input.name}:${Date.now()}:${Math.random()}`)
  const reserve = await request.post('/api/assets/reserve', {
    data: {
      originalName: input.name,
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      mediaType: 'photo',
      contentHash: createHash('sha256').update(bytes).digest('hex'),
      storageBackend: 'telegram_bot',
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  const content = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: bytes,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(content.status()).toBe(201)
  return reservation.assetId
}

test('targeted Telegram source, Owner permission matrix and Bot 20MB boundary remain enforced', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'targeted owner-control contract only needs one browser project')

  const bootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'owner-controls', displayName: 'Owner Controls', password: ownerPassword },
  })
  expect(bootstrap.status()).toBe(201)

  // Telegram source creation: validate, encrypt/store, never echo the token, reject duplicate bot identity.
  const token = '123456789:targeted-owner-controls-token-abcdefghijklmnopqrstuvwxyz'
  expect((await page.request.post('/api/telegram/sources', { data: { displayName: 'Bad Token', botToken: 'short' } })).status()).toBe(400)
  const sourceCreate = await page.request.post('/api/telegram/sources', {
    data: { displayName: 'Targeted Family Bot', botToken: token },
  })
  expect(sourceCreate.status()).toBe(201)
  const sourceBody = await sourceCreate.json() as { item: { id: string; displayName: string; tokenConfigured: boolean; connectionStatus: string } }
  expect(sourceBody.item).toMatchObject({ displayName: 'Targeted Family Bot', tokenConfigured: true, connectionStatus: 'verified' })
  expect(JSON.stringify(sourceBody)).not.toContain(token)
  const sourceId = sourceBody.item.id

  const sourceList = await page.request.get('/api/telegram/sources')
  expect(sourceList.status()).toBe(200)
  expect(JSON.stringify(await sourceList.json())).not.toContain(token)

  const duplicateSource = await page.request.post('/api/telegram/sources', {
    data: { displayName: 'Duplicate Bot', botToken: token },
  })
  expect(duplicateSource.status()).toBe(409)
  await expect(duplicateSource.json()).resolves.toMatchObject({ error: 'TELEGRAM_BOT_ALREADY_CONFIGURED' })

  expect((await page.request.post(`/api/telegram/sources/${sourceId}/bind`, { data: { chatId: 'not-a-chat' } })).status()).toBe(400)
  const bind = await page.request.post(`/api/telegram/sources/${sourceId}/bind`, { data: { chatId: '-1002000000777' } })
  expect(bind.status()).toBe(200)
  await expect(bind.json()).resolves.toMatchObject({ ok: true, item: { id: sourceId, connectionStatus: 'bound', chatId: '-1002000000777' } })

  const disable = await page.request.post(`/api/telegram/sources/${sourceId}/enabled`, { data: { enabled: false } })
  expect(disable.status()).toBe(200)
  const disabledList = await page.request.get('/api/telegram/sources')
  const disabledSource = ((await disabledList.json()) as { items: Array<{ id: string; enabled: boolean; connectionStatus: string }> }).items.find((item) => item.id === sourceId)
  expect(disabledSource).toMatchObject({ enabled: false, connectionStatus: 'disabled' })
  expect((await page.request.post(`/api/telegram/sources/${sourceId}/enabled`, { data: { enabled: true } })).status()).toBe(200)
  expect((await page.request.post('/api/telegram/user-group/runtime', {
    data: {
      connectionStatus: 'connected', storageChatId: '-1002000000888', storageChatTitle: 'ai',
      lastError: 'owner-only-runtime-detail', lastAckMessageId: 778899,
    },
  })).status()).toBe(200)

  // Bot mode is intentionally bounded at 20 MiB: exact boundary accepted, +1 byte rejected before body upload.
  const atLimit = await page.request.post('/api/assets/reserve', {
    data: { originalName: 'exactly-20mb.bin', mimeType: 'application/octet-stream', sizeBytes: BOT_LIMIT, mediaType: 'file', storageBackend: 'telegram_bot' },
  })
  expect(atLimit.status()).toBe(201)
  const overLimit = await page.request.post('/api/assets/reserve', {
    data: { originalName: 'over-20mb.bin', mimeType: 'application/octet-stream', sizeBytes: BOT_LIMIT + 1, mediaType: 'file', storageBackend: 'telegram_bot' },
  })
  expect(overLimit.status()).toBe(413)
  await expect(overLimit.json()).resolves.toMatchObject({ error: 'FILE_TOO_LARGE' })

  const legacyAsset = await uploadOwnerAsset(page.request, { name: 'legacy-visible.jpg' })
  const sourceAsset = await uploadOwnerAsset(page.request, { name: 'source-visible.jpg', sourceId })
  const fullDeleteAsset = await uploadOwnerAsset(page.request, { name: 'full-delete.jpg' })
  const hashProbeBytes = Buffer.from(`owner-private-hash-probe:${Date.now()}:${Math.random()}`)
  const hashProbe = createHash('sha256').update(hashProbeBytes).digest('hex')
  const hashProbeReserve = await page.request.post('/api/assets/reserve', {
    data: {
      originalName: 'owner-private-hash-probe.jpg', mimeType: 'image/jpeg', sizeBytes: hashProbeBytes.byteLength,
      mediaType: 'photo', contentHash: hashProbe, storageBackend: 'telegram_bot',
    },
  })
  expect(hashProbeReserve.status()).toBe(201)
  const hashProbeReservation = await hashProbeReserve.json() as { assetId: string; uploadToken: string }
  expect((await page.request.put(`/api/assets/${hashProbeReservation.assetId}/content`, {
    data: hashProbeBytes,
    headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(hashProbeBytes.byteLength), 'X-Upload-Token': hashProbeReservation.uploadToken,
    },
  })).status()).toBe(201)

  const members = new Map<string, { id: string; username: string }>()
  for (const [label, preset] of [['viewer', 'VIEWER'], ['uploader', 'UPLOAD_ONLY'], ['full', 'FULL']] as const) {
    const username = `controls-${label}`
    const created = await page.request.post('/api/auth/users', {
      data: { username, displayName: `Controls ${label}`, password: memberPassword, accessPreset: preset },
    })
    expect(created.status()).toBe(201)
    const body = await created.json() as { user: { id: string; username: string; accessPreset: string } }
    expect(body.user.accessPreset).toBe(preset)
    members.set(label, { id: body.user.id, username: body.user.username })
  }

  const viewer = await loginApi(members.get('viewer')!.username, memberPassword, '203.0.113.71')
  expect((await viewer.get('/api/assets?limit=60')).status()).toBe(200)
  expect((await viewer.get(`/api/assets/${legacyAsset}`)).status()).toBe(200)
  expect((await viewer.get(`/api/assets/${legacyAsset}/media`)).status()).toBe(403)
  const viewerSettings = await viewer.get('/api/settings/status')
  expect(viewerSettings.status()).toBe(200)
  const viewerSettingsBody = await viewerSettings.json() as { storage?: { userGroup?: { storageChatId: string | null; lastError: string | null; lastAckMessageId: number | null } } }
  expect(viewerSettingsBody.storage?.userGroup).toMatchObject({ storageChatId: null, lastError: null, lastAckMessageId: null })
  expect(JSON.stringify(viewerSettingsBody)).not.toContain('owner-only-runtime-detail')
  expect((await viewer.post('/api/assets/reserve', {
    data: { originalName: 'viewer-cannot-upload.jpg', mimeType: 'image/jpeg', sizeBytes: 3, mediaType: 'photo', storageBackend: 'telegram_bot' },
  })).status()).toBe(403)
  expect((await viewer.patch(`/api/assets/${legacyAsset}`, { data: { favorite: true } })).status()).toBe(403)
  expect((await viewer.delete(`/api/assets/${legacyAsset}`)).status()).toBe(403)
  for (const path of ['/api/auth/users', '/api/telegram/sources', '/api/access/shares', '/api/recovery/integrity']) {
    expect((await viewer.get(path)).status(), `VIEWER must not enter Owner plane: ${path}`).toBe(403)
  }
  await viewer.dispose()

  const uploader = await loginApi(members.get('uploader')!.username, memberPassword, '203.0.113.72')
  const uploaderList = await uploader.get('/api/assets?limit=60')
  expect(uploaderList.status()).toBe(200)
  expect(((await uploaderList.json()) as { items: unknown[] }).items).toHaveLength(0)
  expect((await uploader.get(`/api/assets/${legacyAsset}`)).status()).toBe(404)
  expect((await uploader.post('/api/assets/reserve', {
    data: {
      originalName: 'uploader-allowed.jpg', mimeType: 'image/jpeg', sizeBytes: 3, mediaType: 'photo', storageBackend: 'telegram_bot',
      contentHash: createHash('sha256').update('upl').digest('hex'),
    },
  })).status()).toBe(201)
  const hashProbeAttempt = await uploader.post('/api/assets/reserve', {
    data: {
      originalName: 'hash-probe.jpg', mimeType: 'image/jpeg', sizeBytes: hashProbeBytes.byteLength,
      mediaType: 'photo', storageBackend: 'telegram_bot', contentHash: hashProbe,
    },
  })
  expect(hashProbeAttempt.status()).toBe(201)
  const hashProbeAttemptBody = await hashProbeAttempt.json() as { duplicate: boolean; duplicateOfAssetId?: string }
  expect(hashProbeAttemptBody.duplicate).toBe(false)
  expect(hashProbeAttemptBody.duplicateOfAssetId).toBeUndefined()
  const userGroupDenied = await uploader.post('/api/assets/reserve', {
    data: { originalName: 'member-group-upload.jpg', mimeType: 'image/jpeg', sizeBytes: 3, mediaType: 'photo', storageBackend: 'telegram_user_group' },
  })
  expect(userGroupDenied.status()).toBe(403)
  await expect(userGroupDenied.json()).resolves.toMatchObject({ error: 'APP_USER_GROUP_STORAGE_OWNER_REQUIRED' })
  expect((await uploader.patch(`/api/assets/${legacyAsset}`, { data: { favorite: true } })).status()).toBe(403)
  expect((await uploader.delete(`/api/assets/${legacyAsset}`)).status()).toBe(403)
  await uploader.dispose()

  const full = await loginApi(members.get('full')!.username, memberPassword, '203.0.113.73')
  expect((await full.get(`/api/assets/${legacyAsset}`)).status()).toBe(200)
  // Mock Telegram serves a deterministic placeholder after the ACL gate; FULL must reach it.
  expect((await full.get(`/api/assets/${legacyAsset}/media`)).status()).toBe(200)
  expect((await full.post('/api/assets/reserve', {
    data: {
      originalName: 'full-upload.jpg', mimeType: 'image/jpeg', sizeBytes: 4, mediaType: 'photo', storageBackend: 'telegram_bot',
      contentHash: createHash('sha256').update('full').digest('hex'),
    },
  })).status()).toBe(201)
  expect((await full.patch(`/api/assets/${legacyAsset}`, { data: { favorite: true } })).status()).toBe(200)
  expect((await full.delete(`/api/assets/${fullDeleteAsset}`)).status()).toBe(200)
  await full.dispose()

  // Custom source scope: only the selected Telegram source is visible; workspace download does not widen read scope.
  const scopedCreate = await page.request.post('/api/auth/users', {
    data: { username: 'controls-scoped', displayName: 'Controls Scoped', password: memberPassword, accessPreset: 'VIEWER' },
  })
  expect(scopedCreate.status()).toBe(201)
  const scoped = (await scopedCreate.json()) as { user: { id: string; username: string } }
  const scopedAccess = await page.request.put(`/api/auth/users/${scoped.user.id}/access`, {
    data: { grants: [
      { scopeType: 'source', scopeId: sourceId, permission: 'read' },
      { scopeType: 'workspace', scopeId: 'personal', permission: 'download' },
    ] },
  })
  expect(scopedAccess.status()).toBe(200)
  await expect(scopedAccess.json()).resolves.toMatchObject({ user: { accessPreset: 'SCOPED' } })
  const scopedApi = await loginApi(scoped.user.username, memberPassword, '203.0.113.74')
  const scopedList = await scopedApi.get('/api/assets?limit=60')
  expect(scopedList.status()).toBe(200)
  const scopedIds = ((await scopedList.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)
  expect(scopedIds).toContain(sourceAsset)
  expect(scopedIds).not.toContain(legacyAsset)
  expect((await scopedApi.get(`/api/assets/${sourceAsset}`)).status()).toBe(200)
  expect((await scopedApi.get(`/api/assets/${legacyAsset}`)).status()).toBe(404)
  expect((await scopedApi.get(`/api/assets/${legacyAsset}/media`)).status()).toBe(403)
  await scopedApi.dispose()

  // Owner UI exposes the controls, token is password-type, and the raw token never appears in rendered settings.
  await page.goto('/settings?app=personal-desktop')
  await expect(page.getByRole('heading', { name: '应用账号' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Telegram 来源' })).toBeVisible()
  await expect(page.getByLabel('Bot Token')).toHaveAttribute('type', 'password')
  const initialPreset = page.getByLabel('初始权限')
  await expect(initialPreset.locator('option[value="VIEWER"]')).toHaveText('只读 · 可看全部')
  await expect(initialPreset.locator('option[value="UPLOAD_ONLY"]')).toHaveText('仅上传 · 不可浏览')

  const uiToken = '987654321:ui-targeted-token-abcdefghijklmnopqrstuvwxyz012345'
  await page.getByLabel('显示名称').last().fill('UI Added Bot')
  await page.getByLabel('Bot Token').fill(uiToken)
  await page.getByRole('button', { name: '添加来源' }).click()
  await expect(page.locator('#settings-sources').getByText('UI Added Bot')).toBeVisible()
  await expect(page.getByLabel('Bot Token')).toHaveValue('')
  await expect(page.locator('body')).not.toContainText(uiToken)
  await expect(page.locator('body')).not.toContainText(token)

  const viewerCard = page.locator('.account-admin-card').filter({ hasText: 'Controls viewer' })
  await viewerCard.locator('details').evaluate((element: HTMLDetailsElement) => { element.open = true })
  await expect(viewerCard.getByRole('button', { name: '只读' })).toHaveClass(/active/)
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes(`/api/auth/users/${members.get('viewer')!.id}/access`) && response.status() === 200),
    viewerCard.getByRole('button', { name: '完整成员' }).click(),
  ])
  await expect(viewerCard.locator('summary small')).toHaveText('完整成员')
  const usersAfterFull = await page.request.get('/api/auth/users')
  const viewerAfterFull = ((await usersAfterFull.json()) as { items: Array<{ id: string; accessPreset: string }> }).items.find((item) => item.id === members.get('viewer')!.id)
  expect(viewerAfterFull?.accessPreset).toBe('FULL')

  await viewerCard.locator('details').evaluate((element: HTMLDetailsElement) => { element.open = true })
  await Promise.all([
    page.waitForResponse((response) => response.request().method() === 'PUT' && response.url().includes(`/api/auth/users/${members.get('viewer')!.id}/access`) && response.status() === 200),
    viewerCard.getByRole('button', { name: '只读' }).click(),
  ])
  await expect(viewerCard.locator('summary small')).toHaveText('只读全部')
  const usersAfterViewer = await page.request.get('/api/auth/users')
  const viewerAfterViewer = ((await usersAfterViewer.json()) as { items: Array<{ id: string; accessPreset: string }> }).items.find((item) => item.id === members.get('viewer')!.id)
  expect(viewerAfterViewer?.accessPreset).toBe('VIEWER')

  // Defense in depth: a VIEWER must not even see Owner administration sections in the UI.
  await page.getByRole('button', { name: '当前账号 Owner Controls' }).click()
  await page.getByRole('menuitem', { name: '切换账号' }).click()
  await expect(page.getByRole('heading', { name: '登录私人档案' })).toBeVisible()
  await page.getByLabel('用户名').fill(members.get('viewer')!.username)
  await page.getByLabel('密码').fill(memberPassword)
  await expect(page.getByLabel('用户名')).toHaveValue(members.get('viewer')!.username)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('button', { name: '当前账号 Controls viewer' })).toBeVisible()
  await page.goto('/settings?app=personal-desktop')
  await expect(page.getByRole('heading', { name: '应用账号' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Telegram 双存储' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Telegram 来源' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '共享与访问' })).toHaveCount(0)
  await expect(page.getByRole('heading', { name: '连接', exact: true })).toBeVisible()
})
