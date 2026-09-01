import { createHash } from 'node:crypto'
import { expect, request as playwrightRequest, test, type APIRequestContext } from '@playwright/test'

const memberPassword = 'SecurityRegression!2026'

function appSessionToken(setCookie: string | undefined): string {
  const match = setCookie?.match(/(?:^|;\s*)pa_account=([^;]+)/)
  if (!match?.[1]) throw new Error('pa_account cookie missing')
  return decodeURIComponent(match[1])
}

function shareSessionToken(setCookie: string | undefined): string {
  const match = setCookie?.match(/(?:^|;\s*)private_archive_share=([^;]+)/)
  if (!match?.[1]) throw new Error('private_archive_share cookie missing')
  return decodeURIComponent(match[1])
}

function tokenFromShareUrl(url: string): string {
  const parsed = new URL(url)
  const match = parsed.hash.match(/^#\/share\/(.+)$/)
  if (!match?.[1]) throw new Error('share token missing')
  return decodeURIComponent(match[1])
}

async function loginMember(username: string, ip: string): Promise<APIRequestContext> {
  const anonymous = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8799', extraHTTPHeaders: { 'X-Forwarded-For': ip } })
  const login = await anonymous.post('/api/auth/login', { data: { username, password: memberPassword } })
  expect(login.status()).toBe(200)
  const token = appSessionToken(login.headers()['set-cookie'])
  await anonymous.dispose()
  return playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: `pa_account=${encodeURIComponent(token)}`, 'X-Forwarded-For': ip },
  })
}

async function seededAssetIds(request: APIRequestContext): Promise<string[]> {
  const seed = await request.post('/api/dev/seed')
  if (!seed.ok()) throw new Error(`seed failed status=${seed.status()} body=${await seed.text()}`)
  const assets = await request.get('/api/assets?limit=60')
  expect(assets.ok()).toBeTruthy()
  return ((await assets.json()) as { items: Array<{ id: string }> }).items.map((item) => item.id)
}

async function uploadOwnerAsset(request: APIRequestContext, bytes: Buffer, name: string): Promise<{ assetId: string; hash: string }> {
  const hash = createHash('sha256').update(bytes).digest('hex')
  const reserve = await request.post('/api/assets/reserve', {
    data: { originalName: name, mimeType: 'application/octet-stream', sizeBytes: bytes.byteLength, mediaType: 'file', contentHash: hash, storageBackend: 'telegram_bot' },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  const upload = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: bytes,
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.byteLength), 'X-Upload-Token': reservation.uploadToken },
  })
  expect(upload.status()).toBe(201)
  return { assetId: reservation.assetId, hash }
}

test('album relationship mutations cannot manufacture broader asset privileges', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'authorization graph regression only needs one browser project')

  const [targetAsset, anchorAsset] = await seededAssetIds(page.request)
  expect(targetAsset).toBeTruthy()
  expect(anchorAsset).toBeTruthy()

  const albumCreate = await page.request.post('/api/albums', { data: { name: 'Security Boundary Album' } })
  expect(albumCreate.status()).toBe(201)
  const albumId = ((await albumCreate.json()) as { album: { id: string } }).album.id

  const escalatorCreate = await page.request.post('/api/auth/users', {
    data: { username: 'security-escalator', displayName: 'Security Escalator', password: memberPassword, accessPreset: 'VIEWER' },
  })
  expect(escalatorCreate.status()).toBe(201)
  const escalatorId = ((await escalatorCreate.json()) as { user: { id: string } }).user.id
  const escalatorGrants = await page.request.put(`/api/auth/users/${escalatorId}/access`, {
    data: { grants: [
      { scopeType: 'asset', scopeId: targetAsset, permission: 'read' },
      { scopeType: 'album', scopeId: albumId, permission: 'read' },
      { scopeType: 'album', scopeId: albumId, permission: 'edit' },
      { scopeType: 'album', scopeId: albumId, permission: 'delete' },
    ] },
  })
  expect(escalatorGrants.status()).toBe(200)

  const escalator = await loginMember('security-escalator', '203.0.113.91')
  expect((await escalator.get(`/api/assets/${targetAsset}`)).status()).toBe(200)
  expect((await escalator.patch(`/api/assets/${targetAsset}`, { data: { favorite: true } })).status()).toBe(403)
  expect((await escalator.delete(`/api/assets/${targetAsset}`)).status()).toBe(403)

  const linkAttempt = await escalator.patch(`/api/albums/${albumId}`, { data: { assetId: targetAsset } })
  expect(linkAttempt.status()).toBe(403)
  await expect(linkAttempt.json()).resolves.toMatchObject({ error: 'ALBUM_LINK_WOULD_EXPAND_ACCESS' })
  expect((await escalator.patch(`/api/assets/${targetAsset}`, { data: { favorite: true } })).status()).toBe(403)
  expect((await escalator.delete(`/api/assets/${targetAsset}`)).status()).toBe(403)
  await escalator.dispose()

  expect((await page.request.patch(`/api/albums/${albumId}`, { data: { assetId: anchorAsset } })).status()).toBe(200)
  const singleAssetEditorCreate = await page.request.post('/api/auth/users', {
    data: { username: 'security-single-editor', displayName: 'Single Asset Editor', password: memberPassword, accessPreset: 'VIEWER' },
  })
  expect(singleAssetEditorCreate.status()).toBe(201)
  const singleEditorId = ((await singleAssetEditorCreate.json()) as { user: { id: string } }).user.id
  expect((await page.request.put(`/api/auth/users/${singleEditorId}/access`, {
    data: { grants: [
      { scopeType: 'asset', scopeId: anchorAsset, permission: 'read' },
      { scopeType: 'asset', scopeId: anchorAsset, permission: 'edit' },
    ] },
  })).status()).toBe(200)

  const singleEditor = await loginMember('security-single-editor', '203.0.113.92')
  expect((await singleEditor.get(`/api/albums/${albumId}`)).status()).toBe(200)
  expect((await singleEditor.patch(`/api/albums/${albumId}`, { data: { name: 'Should Not Rename' } })).status()).toBe(403)
  expect((await singleEditor.delete(`/api/albums/${albumId}`)).status()).toBe(403)
  await singleEditor.dispose()
})

test('upload-only accounts cannot use hash deduplication as a private-file existence oracle', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'dedup privacy regression only needs one browser project')

  const bytes = Buffer.from(`private-dedup-regression:${Date.now()}:${Math.random()}`)
  const ownerAsset = await uploadOwnerAsset(page.request, bytes, 'private-owner-only.bin')
  const memberCreate = await page.request.post('/api/auth/users', {
    data: { username: 'security-upload-only', displayName: 'Security Upload Only', password: memberPassword, accessPreset: 'UPLOAD_ONLY' },
  })
  expect(memberCreate.status()).toBe(201)

  const uploader = await loginMember('security-upload-only', '203.0.113.93')
  const hiddenBefore = await uploader.get(`/api/assets/${ownerAsset.assetId}`)
  expect(hiddenBefore.status()).toBe(404)
  const reserve = await uploader.post('/api/assets/reserve', {
    data: {
      originalName: 'same-private-content.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      mediaType: 'file',
      contentHash: ownerAsset.hash,
      storageBackend: 'telegram_bot',
    },
  })
  expect(reserve.status()).toBe(201)
  const body = await reserve.json() as { duplicate?: boolean; duplicateOfAssetId?: string; uploadToken?: string }
  expect(body.duplicate).toBe(false)
  expect(body.duplicateOfAssetId).toBeUndefined()
  expect(body.uploadToken).toBeTruthy()
  await uploader.dispose()
})

test('shared asset responses do not expose private GPS, EXIF or archive metadata', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'share privacy regression only needs one browser project')

  const bytes = Buffer.from(`share-private-metadata:${Date.now()}:${Math.random()}`)
  const hash = createHash('sha256').update(bytes).digest('hex')
  const reserve = await page.request.post('/api/assets/reserve', {
    data: {
      originalName: 'private-location.jpg',
      mimeType: 'image/jpeg',
      sizeBytes: bytes.byteLength,
      mediaType: 'photo',
      contentHash: hash,
      latitude: 37.7749,
      longitude: -122.4194,
      logicalPath: '/private/family',
      metadata: { cameraSerial: 'PRIVATE-SERIAL', exifNote: '<private>' },
      storageBackend: 'telegram_bot',
    },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  expect((await page.request.put(`/api/assets/${reservation.assetId}/content`, {
    data: bytes,
    headers: {
      'Content-Type': 'image/jpeg',
      'Content-Length': String(bytes.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })).status()).toBe(201)

  const create = await page.request.post('/api/access/shares', {
    data: { name: 'Privacy regression', scopeType: 'asset', scopeId: reservation.assetId, allowDownload: false, expiresInDays: 1 },
  })
  expect(create.status()).toBe(201)
  const shareUrl = ((await create.json()) as { url: string }).url
  const exchange = await page.request.post('/api/share/exchange', { data: { token: tokenFromShareUrl(shareUrl) } })
  expect(exchange.status()).toBe(200)
  const shareToken = shareSessionToken(exchange.headers()['set-cookie'])

  const shared = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: `private_archive_share=${encodeURIComponent(shareToken)}` },
  })
  const detail = await shared.get(`/api/share/assets/${reservation.assetId}`)
  expect(detail.status()).toBe(200)
  const asset = (await detail.json() as { asset: Record<string, unknown> }).asset
  expect(asset).toMatchObject({
    sourceId: 'shared',
    importOrigin: 'shared',
    metadata: null,
    metadataSupported: false,
    logicalPath: '/',
    lastViewedAt: null,
    latitude: null,
    longitude: null,
    placeId: null,
    favorite: false,
    primaryCategory: null,
    aiCategory: null,
    categoryOverride: null,
    personCount: null,
    scene: null,
    uploadSupported: false,
    downloadSupported: false,
    originalAvailableInApp: false,
  })
  expect(asset).not.toHaveProperty('tags')
  await shared.dispose()
})

test('share logout revokes the server session and malformed cookies fail closed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'share-session regression only needs one browser project')

  const [targetAsset] = await seededAssetIds(page.request)
  const create = await page.request.post('/api/access/shares', {
    data: { name: 'Logout regression', scopeType: 'asset', scopeId: targetAsset, allowDownload: false, expiresInDays: 1 },
  })
  expect(create.status()).toBe(201)
  const shareUrl = ((await create.json()) as { url: string }).url
  const exchange = await page.request.post('/api/share/exchange', { data: { token: tokenFromShareUrl(shareUrl) } })
  expect(exchange.status()).toBe(200)
  expect(exchange.headers()['set-cookie']).toContain('Path=/api/share')
  const staleToken = shareSessionToken(exchange.headers()['set-cookie'])
  expect((await page.request.get('/api/share/session')).status()).toBe(200)
  expect((await page.request.post('/api/share/logout')).status()).toBe(200)

  const staleSession = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: `private_archive_share=${encodeURIComponent(staleToken)}` },
  })
  expect((await staleSession.get('/api/share/session')).status()).toBe(401)
  await staleSession.dispose()

  const malformed = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: 'private_archive_share=%' },
  })
  expect((await malformed.get('/api/share/session')).status()).toBe(401)
  await malformed.dispose()
})
