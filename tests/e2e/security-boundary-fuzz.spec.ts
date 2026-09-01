import { expect, request as playwrightRequest, test } from '@playwright/test'

const ownerPassword = 'BoundaryOwner!2026'

function sessionToken(setCookie: string | undefined): string {
  const match = setCookie?.match(/(?:^|;\s*)pa_account=([^;]+)/)
  if (!match?.[1]) throw new Error('pa_account cookie missing')
  return decodeURIComponent(match[1])
}

test('security boundary fuzz and controlled brute-force protections fail closed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'security boundary fuzz only needs one isolated browser project')

  const bootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'boundary-owner', displayName: 'Boundary Owner', password: ownerPassword },
  })
  expect(bootstrap.status()).toBe(201)

  // Authentication brute-force boundary: eight failures are recorded; subsequent attempts from
  // the same IP are throttled before password verification. A different IP remains independent.
  const attackerIp = '203.0.113.201'
  const attacker = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { 'X-Forwarded-For': attackerIp },
  })
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const response = await attacker.post('/api/auth/login', {
      data: { username: 'boundary-owner', password: `WrongBoundary!${attempt}` },
    })
    expect(response.status(), `wrong password attempt ${attempt}`).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'LOGIN_INVALID' })
  }
  const throttled = await attacker.post('/api/auth/login', {
    data: { username: 'boundary-owner', password: ownerPassword },
  })
  expect(throttled.status()).toBe(429)
  expect(throttled.headers()['retry-after']).toBe('900')
  await expect(throttled.json()).resolves.toMatchObject({ error: 'LOGIN_RATE_LIMITED' })
  await attacker.dispose()

  const independentIp = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { 'X-Forwarded-For': '203.0.113.202' },
  })
  const independentLogin = await independentIp.post('/api/auth/login', {
    data: { username: 'boundary-owner', password: ownerPassword },
  })
  expect(independentLogin.status()).toBe(200)
  const ownerToken = sessionToken(independentLogin.headers()['set-cookie'])
  await independentIp.dispose()

  const owner = await playwrightRequest.newContext({
    baseURL: 'http://127.0.0.1:8799',
    extraHTTPHeaders: { Cookie: `pa_account=${encodeURIComponent(ownerToken)}`, 'X-Forwarded-For': '203.0.113.203' },
  })

  // Auth parser boundaries: malformed and oversized bodies must fail before reaching credential logic.
  const malformedAuth = await owner.post('/api/auth/users', {
    data: '{',
    headers: { 'Content-Type': 'application/json' },
  })
  expect(malformedAuth.status()).toBe(400)
  await expect(malformedAuth.json()).resolves.toMatchObject({ error: 'REQUEST_BODY_INVALID' })

  const oversizedAuth = await owner.post('/api/auth/users', {
    data: JSON.stringify({ username: 'oversized-user', displayName: 'x'.repeat(17_000), password: 'OversizedPass!2026' }),
    headers: { 'Content-Type': 'application/json' },
  })
  expect(oversizedAuth.status()).toBe(413)
  await expect(oversizedAuth.json()).resolves.toMatchObject({ error: 'REQUEST_BODY_TOO_LARGE' })

  // A rotating-IP attacker must not bypass the login throttle simply by changing XFF.
  const distributedUsername = 'distributed-throttle-user'
  const distributedPassword = 'DistributedThrottle!2026'
  expect((await owner.post('/api/auth/users', {
    data: { username: distributedUsername, displayName: 'Distributed Throttle', password: distributedPassword, accessPreset: 'VIEWER' },
  })).status()).toBe(201)
  const distributed = await playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8799' })
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await distributed.post('/api/auth/login', {
      data: { username: distributedUsername, password: `WrongDistributed!${attempt}` },
      headers: { 'X-Forwarded-For': `198.51.100.${attempt + 1}` },
    })
    expect(response.status(), `distributed wrong password attempt ${attempt + 1}`).toBe(401)
  }
  const distributedThrottled = await distributed.post('/api/auth/login', {
    data: { username: distributedUsername, password: distributedPassword },
    headers: { 'X-Forwarded-For': '198.51.100.250' },
  })
  expect(distributedThrottled.status()).toBe(429)
  expect(distributedThrottled.headers()['retry-after']).toBe('900')
  await distributed.dispose()

  const invalidReserveBodies: Array<{ label: string; data: Record<string, unknown>; status: number; error: string }> = [
    { label: 'empty filename', data: { originalName: '', mimeType: 'application/octet-stream', sizeBytes: 1 }, status: 400, error: 'INVALID_FILE_NAME' },
    { label: 'control character filename', data: { originalName: 'bad\u0000name.jpg', mimeType: 'image/jpeg', sizeBytes: 1 }, status: 400, error: 'INVALID_FILE_NAME' },
    { label: 'too long filename', data: { originalName: `${'a'.repeat(252)}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1 }, status: 400, error: 'INVALID_FILE_NAME' },
    { label: 'negative size', data: { originalName: 'negative.bin', mimeType: 'application/octet-stream', sizeBytes: -1 }, status: 400, error: 'INVALID_FILE_SIZE' },
    { label: 'fractional size', data: { originalName: 'fraction.bin', mimeType: 'application/octet-stream', sizeBytes: 1.5 }, status: 400, error: 'INVALID_FILE_SIZE' },
    { label: 'bot size over boundary', data: { originalName: 'large.bin', mimeType: 'application/octet-stream', sizeBytes: 20 * 1024 * 1024 + 1, storageBackend: 'telegram_bot' }, status: 413, error: 'FILE_TOO_LARGE' },
    { label: 'invalid backend', data: { originalName: 'backend.bin', mimeType: 'application/octet-stream', sizeBytes: 1, storageBackend: 'filesystem' }, status: 400, error: 'INVALID_STORAGE_BACKEND' },
    { label: 'latitude high', data: { originalName: 'gps.jpg', mimeType: 'image/jpeg', sizeBytes: 1, latitude: 90.0001 }, status: 400, error: 'INVALID_LATITUDE' },
    { label: 'longitude low', data: { originalName: 'gps.jpg', mimeType: 'image/jpeg', sizeBytes: 1, longitude: -180.0001 }, status: 400, error: 'INVALID_LONGITUDE' },
    { label: 'zero width', data: { originalName: 'width.jpg', mimeType: 'image/jpeg', sizeBytes: 1, width: 0 }, status: 400, error: 'INVALID_WIDTH' },
    { label: 'invalid hash', data: { originalName: 'hash.bin', mimeType: 'application/octet-stream', sizeBytes: 1, contentHash: '../not-a-sha256' }, status: 400, error: 'INVALID_CONTENT_HASH' },
    { label: 'invalid source id', data: { originalName: 'source.bin', mimeType: 'application/octet-stream', sizeBytes: 1, sourceId: '../../source' }, status: 400, error: 'INVALID_SOURCE_ID' },
  ]

  for (const item of invalidReserveBodies) {
    const response = await owner.post('/api/assets/reserve', { data: item.data })
    expect(response.status(), item.label).toBe(item.status)
    await expect(response.json(), item.label).resolves.toMatchObject({ error: item.error })
  }

  // Upload-token guessing: wrong guesses stay unauthorized and do not invalidate the real token.
  const reserve = await owner.post('/api/assets/reserve', {
    data: { originalName: 'token-boundary.bin', mimeType: 'application/octet-stream', sizeBytes: 4, storageBackend: 'telegram_bot' },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const guessed = await owner.put(`/api/assets/${reservation.assetId}/content`, {
      data: Buffer.from('test'),
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '4',
        'X-Upload-Token': `guess-${String(attempt).padStart(2, '0')}-${'x'.repeat(40)}`,
      },
    })
    expect(guessed.status(), `upload-token guess ${attempt}`).toBe(401)
    await expect(guessed.json()).resolves.toMatchObject({ error: 'UPLOAD_TOKEN_INVALID_OR_EXPIRED' })
  }
  const validUpload = await owner.put(`/api/assets/${reservation.assetId}/content`, {
    data: Buffer.from('test'),
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': '4',
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(validUpload.status()).toBe(201)

  // Share token boundaries must reject short/oversized/unstructured input without session creation.
  for (const token of ['', 'short', 'a'.repeat(201), '../'.repeat(20)]) {
    const response = await owner.post('/api/share/exchange', { data: { token } })
    expect([400, 401]).toContain(response.status())
    expect(response.headers()['set-cookie'] ?? '').not.toContain('private_archive_share=')
  }
  const oversizedShareExchange = await owner.post('/api/share/exchange', {
    data: JSON.stringify({ token: 'a'.repeat(5 * 1024) }),
    headers: { 'Content-Type': 'application/json' },
  })
  expect(oversizedShareExchange.status()).toBe(413)
  await expect(oversizedShareExchange.json()).resolves.toMatchObject({ error: 'REQUEST_BODY_TOO_LARGE' })

  // Public webhook path must authenticate before parsing/processing attacker-controlled update JSON.
  for (const supplied of [undefined, '', 'wrong', 'x'.repeat(128)]) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (supplied !== undefined) headers['X-Telegram-Bot-Api-Secret-Token'] = supplied
    const response = await owner.post('/api/telegram/webhook', {
      data: { update_id: 1, message: { chat: { id: 1, type: 'private' }, message_id: 1, date: 1 } },
      headers,
    })
    expect(response.status()).toBe(401)
    await expect(response.json()).resolves.toMatchObject({ error: 'WEBHOOK_SECRET_INVALID' })
  }
  const malformedTrustedWebhook = await owner.post('/api/telegram/webhook', {
    data: '{',
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(malformedTrustedWebhook.status()).toBe(400)
  await expect(malformedTrustedWebhook.json()).resolves.toMatchObject({ error: 'REQUEST_BODY_INVALID' })

  const oversizedTrustedWebhook = await owner.post('/api/telegram/webhook', {
    data: JSON.stringify({ update_id: 2, padding: 'x'.repeat(1024 * 1024) }),
    headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(oversizedTrustedWebhook.status()).toBe(413)
  await expect(oversizedTrustedWebhook.json()).resolves.toMatchObject({ error: 'REQUEST_BODY_TOO_LARGE' })

  // Authenticated API/media responses must never be reusable from the browser cache
  // after logout, role downgrade or account switch. Edge Cache API acceleration remains server-side.
  const assetDetail = await owner.get(`/api/assets/${reservation.assetId}`)
  expect(assetDetail.status()).toBe(200)
  expect(assetDetail.headers()['cache-control']).toBe('private, no-store')
  const assetMedia = await owner.get(`/api/assets/${reservation.assetId}/media`)
  expect(assetMedia.status()).toBe(200)
  expect(assetMedia.headers()['cache-control']).toBe('private, no-store')

  await owner.dispose()
})
