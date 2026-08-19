import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('concurrent reserve for the same content does not rotate the active upload token', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'reserve race only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const file = Buffer.from(`same-content-reserve-${suffix}`)
  const contentHash = createHash('sha256').update(file).digest('hex')
  const metadata = {
    originalName: `reserve-race-${suffix}.pdf`, mimeType: 'application/pdf', sizeBytes: file.byteLength,
    mediaType: 'file', contentHash,
  }

  const responses = await Promise.all([
    request.post('/api/assets/reserve', { data: metadata }),
    request.post('/api/assets/reserve', { data: { ...metadata, originalName: `competing-${suffix}.pdf` } }),
  ])
  expect(responses.map((response) => response.status()).sort()).toEqual([201, 409])
  const first = responses.find((response) => response.status() === 201)
  const competing = responses.find((response) => response.status() === 409)
  expect(first).toBeDefined()
  expect(competing).toBeDefined()
  const reservation = await first!.json() as { assetId: string; uploadToken: string }
  expect(competing!.headers()['retry-after']).toBe('1')
  await expect(competing!.json()).resolves.toMatchObject({ error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: reservation.assetId })

  const contentResponses = await Promise.all([
    request.put(`/api/assets/${reservation.assetId}/content`, {
      data: file,
      headers: {
        'Content-Type': 'application/pdf', 'Content-Length': String(file.byteLength), 'X-Upload-Token': reservation.uploadToken,
      },
    }),
    request.put(`/api/assets/${reservation.assetId}/content`, {
      data: file,
      headers: {
        'Content-Type': 'application/pdf', 'Content-Length': String(file.byteLength), 'X-Upload-Token': reservation.uploadToken,
      },
    }),
  ])
  expect(contentResponses.filter((response) => response.status() === 201)).toHaveLength(1)
  const follower = contentResponses.find((response) => response.status() !== 201)
  expect(follower).toBeDefined()
  expect([200, 409]).toContain(follower!.status())
  if (follower!.status() === 409) {
    expect(follower!.headers()['retry-after']).toBe('1')
    await expect(follower!.json()).resolves.toMatchObject({ error: 'UPLOAD_ALREADY_IN_PROGRESS' })
  }

  const idempotentContent = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: file,
    headers: {
      'Content-Type': 'application/pdf', 'Content-Length': String(file.byteLength), 'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(idempotentContent.status()).toBe(200)
  await expect(idempotentContent.json()).resolves.toMatchObject({ alreadyStored: true })

  const duplicate = await request.post('/api/assets/reserve', { data: metadata })
  expect(duplicate.status()).toBe(200)
  await expect(duplicate.json()).resolves.toMatchObject({ assetId: reservation.assetId, duplicate: true })
})

test('web upload and Telegram webhook converge into archive records', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'API convergence only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const basePng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nAAAAABJRU5ErkJggg==', 'base64')
  const png = Buffer.concat([basePng, Buffer.from(suffix)])
  const contentHash = createHash('sha256').update(png).digest('hex')
  const webName = `garden-upload-${suffix}.png`

  const reserve = await request.post('/api/assets/reserve', {
    data: {
      originalName: webName,
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      mediaType: 'photo',
      width: 1,
      height: 1,
      takenAt: '2026-08-12T01:02:03.000Z',
      contentHash,
    },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }

  const preview = await request.post(`/api/assets/${reservation.assetId}/preview`, {
    data: png,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(preview.status()).toBe(201)

  const content = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: png,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(content.status()).toBe(201)

  const idempotentContent = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: png,
    headers: {
      'Content-Type': 'image/png',
      'Content-Length': String(png.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(idempotentContent.status()).toBe(200)
  await expect(idempotentContent.json()).resolves.toMatchObject({ alreadyStored: true })

  const duplicateReserve = await request.post('/api/assets/reserve', {
    data: {
      originalName: `renamed-${webName}`,
      mimeType: 'image/png',
      sizeBytes: png.byteLength,
      mediaType: 'photo',
      contentHash,
    },
  })
  expect(duplicateReserve.status()).toBe(200)
  await expect(duplicateReserve.json()).resolves.toMatchObject({ assetId: reservation.assetId, duplicate: true })

  const messageId = 100_000 + Math.floor(Math.random() * 800_000)
  const updateId = Date.now() + Math.floor(Math.random() * 1000)
  const telegramName = `telegram-note-${suffix}.pdf`
  const telegramPayload = {
    update_id: updateId,
    message: {
      message_id: messageId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: 10001, type: 'private' },
      from: { id: 10001, is_bot: false, first_name: 'Owner' },
      document: {
        file_id: `file-${suffix}`,
        file_unique_id: `unique-${suffix}`,
        file_name: telegramName,
        mime_type: 'application/pdf',
        file_size: 1024,
      },
    },
  }
  const webhook = await request.post('/api/telegram/webhook', {
    data: telegramPayload,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(webhook.status()).toBe(201)
  const webhookResult = await webhook.json() as { assetId: string }

  const duplicate = await request.post('/api/telegram/webhook', {
    data: telegramPayload,
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(duplicate.status()).toBe(200)
  await expect(duplicate.json()).resolves.toMatchObject({ ok: true, duplicate: true })

  await expect.poll(async () => {
    const [webResponse, telegramResponse] = await Promise.all([
      request.get(`/api/assets/${reservation.assetId}`),
      request.get(`/api/assets/${webhookResult.assetId}`),
    ])
    const web = webResponse.ok() ? (await webResponse.json() as { asset: { originalName: string; source: string } }).asset : undefined
    const telegram = telegramResponse.ok() ? (await telegramResponse.json() as { asset: { originalName: string; source: string } }).asset : undefined
    return { web, telegram }
  }).toMatchObject({
    web: { originalName: webName, source: 'web' },
    telegram: { originalName: telegramName, source: 'mock' },
  })
})
