import { expect, test } from '@playwright/test'

test('preview and photo original transition from edge MISS to HIT without query-key sharding', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'cache semantics only need one browser project')
  // Use a unique logical asset so earlier gallery tests cannot prewarm this cache key.
  // The cache key deliberately ignores query strings, so a fixed seeded id makes the
  // first request nondeterministically HIT when the shared local workerd cache persists.
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const bytes = Buffer.from(`cache-probe-${suffix}`)
  const reserve = await request.post('/api/assets/reserve', {
    data: { originalName: `cache-probe-${suffix}.jpg`, mimeType: 'image/jpeg', sizeBytes: bytes.byteLength, mediaType: 'photo', width: 1200, height: 800, storageBackend: 'telegram_bot' },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  const content = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: bytes,
    headers: { 'Content-Type': 'image/jpeg', 'Content-Length': String(bytes.byteLength), 'X-Upload-Token': reservation.uploadToken },
  })
  expect(content.status()).toBe(201)
  const detail = await request.get(`/api/assets/${reservation.assetId}`)
  expect(detail.ok()).toBeTruthy()
  const photo = (await detail.json() as { asset: Record<string, unknown> }).asset
  expect(photo).not.toHaveProperty('telegramUrl')

  const previewUrl = String(photo.previewUrl)
  const mediaUrl = String(photo.mediaUrl)
  const previewMiss = await request.get(`${previewUrl}?retry=first`)
  expect(previewMiss.ok()).toBeTruthy()
  expect(previewMiss.headers()['x-private-archive-edge-cache']).toBe('MISS')
  expect(previewMiss.headers()['x-private-archive-upstream']).toBe('mock')
  await new Promise((resolve) => setTimeout(resolve, 100))

  const previewHit = await request.get(`${previewUrl}?retry=second`)
  expect(previewHit.ok()).toBeTruthy()
  expect(previewHit.headers()['x-private-archive-edge-cache']).toBe('HIT')
  expect(previewHit.headers()['x-private-archive-upstream']).toBe('edge')

  const mediaMiss = await request.get(`${mediaUrl}?viewer=first`)
  expect(mediaMiss.ok()).toBeTruthy()
  expect(mediaMiss.headers()['x-private-archive-edge-cache']).toBe('MISS')
  expect(mediaMiss.headers()['x-private-archive-upstream']).toBe('mock')
  await new Promise((resolve) => setTimeout(resolve, 100))

  const mediaHit = await request.get(`${mediaUrl}?viewer=second`)
  expect(mediaHit.ok()).toBeTruthy()
  expect(mediaHit.headers()['x-private-archive-edge-cache']).toBe('HIT')
  expect(mediaHit.headers()['x-private-archive-upstream']).toBe('edge')
})

test('gallery loads previews only; original is requested only after opening Viewer', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'request-count contract only needs one browser project')
  expect((await request.post('/api/dev/seed')).ok()).toBeTruthy()

  let previewRequests = 0
  let mediaRequests = 0
  page.on('request', (req) => {
    const pathname = new URL(req.url()).pathname
    if (/\/api\/assets\/[^/]+\/preview$/.test(pathname)) previewRequests += 1
    if (/\/api\/assets\/[^/]+\/media$/.test(pathname)) mediaRequests += 1
  })

  await page.goto('/')
  await expect(page.locator('.media-tile').first()).toBeVisible()
  await page.waitForTimeout(300)
  expect(previewRequests).toBeGreaterThan(0)
  expect(mediaRequests).toBe(0)

  await page.locator('.media-tile .media-open').first().click()
  await expect(page.getByRole('dialog', { name: /查看/ })).toBeVisible()
  await expect.poll(() => mediaRequests, { timeout: 10_000 }).toBeGreaterThan(0)
})
