import { createHash } from 'node:crypto'
import { expect, test } from '@playwright/test'

test('concurrent reserve for the same content does not rotate the active upload token', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'reserve race only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const file = Buffer.from(`same-content-reserve-${suffix}`)
  const contentHash = createHash('sha256').update(file).digest('hex')
  const metadata = {
    originalName: `reserve-race-${suffix}.pdf`, mimeType: 'application/pdf', sizeBytes: file.byteLength,
    mediaType: 'file', contentHash, storageBackend: 'telegram_bot',
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
    expect(follower!.headers()['retry-after']).toBe('20')
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

  const duplicate = await request.post('/api/assets/reserve', { data: { ...metadata, originalName: `logical-copy-${suffix}.pdf` } })
  expect(duplicate.status()).toBe(200)
  const duplicateBody = await duplicate.json() as { assetId: string; duplicate: boolean; duplicateOfAssetId: string; reusedStorage: boolean }
  expect(duplicateBody.assetId).toBe(reservation.assetId)
  expect(duplicateBody).toMatchObject({ duplicate: true, duplicateOfAssetId: reservation.assetId, reusedStorage: true })
})

test('same photo capture deduplicates across JPEG and HEIC representations', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'capture-identity dedup only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const takenAt = '2024-02-19T09:26:46.000Z'
  const jpeg = Buffer.from(`jpeg-representation-${suffix}`)
  const heic = Buffer.from(`heic-representation-${suffix}-different-bytes`)
  const common = {
    mediaType: 'photo', width: 4032, height: 3024, takenAt, storageBackend: 'telegram_bot',
  }
  const first = await request.post('/api/assets/reserve', {
    data: {
      ...common,
      originalName: `IMG_${suffix}.edited.jpeg`, mimeType: 'image/jpeg', sizeBytes: jpeg.byteLength,
      contentHash: createHash('sha256').update(jpeg).digest('hex'),
    },
  })
  expect(first.status()).toBe(201)
  const firstReservation = await first.json() as { assetId: string; uploadToken: string }
  const stored = await request.put(`/api/assets/${firstReservation.assetId}/content`, {
    data: jpeg,
    headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(jpeg.byteLength), 'X-Upload-Token': firstReservation.uploadToken,
    },
  })
  expect(stored.status()).toBe(201)

  const duplicate = await request.post('/api/assets/reserve', {
    data: {
      ...common,
      originalName: `IMG_${suffix}.edited.heic`, mimeType: 'image/heic', sizeBytes: heic.byteLength,
      contentHash: createHash('sha256').update(heic).digest('hex'),
    },
  })
  expect(duplicate.status()).toBe(200)
  await expect(duplicate.json()).resolves.toMatchObject({
    assetId: firstReservation.assetId,
    duplicate: true,
    duplicateOfAssetId: firstReservation.assetId,
    duplicateKind: 'capture',
    reusedStorage: true,
  })
})

test('stale iOS reservation rotates the existing upload job instead of creating duplicates', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'stale reservation contract only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const file = Buffer.from(`ios-stale-reserve-${suffix}`)
  const contentHash = createHash('sha256').update(file).digest('hex')
  const metadata = {
    originalName: `ios-stale-${suffix}.jpg`, mimeType: 'image/jpeg', sizeBytes: file.byteLength,
    mediaType: 'photo', contentHash, storageBackend: 'telegram_bot', importOrigin: 'ios-background',
  }

  const first = await request.post('/api/assets/reserve', { data: metadata })
  expect(first.status()).toBe(201)
  const firstReservation = await first.json() as { assetId: string; uploadToken: string }

  const activeRetry = await request.post('/api/assets/reserve', { data: metadata })
  expect(activeRetry.status()).toBe(409)
  await expect(activeRetry.json()).resolves.toMatchObject({
    error: 'DUPLICATE_UPLOAD_IN_PROGRESS', assetId: firstReservation.assetId,
  })

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15_500))

  const resumed = await request.post('/api/assets/reserve', { data: metadata })
  expect(resumed.status()).toBe(200)
  const resumedReservation = await resumed.json() as { assetId: string; uploadToken: string; resumed: boolean }
  expect(resumedReservation).toMatchObject({ assetId: firstReservation.assetId, resumed: true })
  expect(resumedReservation.uploadToken).not.toBe(firstReservation.uploadToken)

  const jobsResponse = await request.get('/api/upload-jobs')
  expect(jobsResponse.status()).toBe(200)
  const jobs = await jobsResponse.json() as { items: Array<{ asset_id: string; status: string }> }
  const resumedJobs = jobs.items.filter((item) => item.asset_id === firstReservation.assetId)
  expect(resumedJobs).toHaveLength(1)
  expect(resumedJobs[0]?.status).toBe('waiting')

  const pendingAsset = await request.get(`/api/assets/${firstReservation.assetId}`)
  expect(pendingAsset.status()).toBe(200)
  await expect(pendingAsset.json()).resolves.toMatchObject({ asset: { id: firstReservation.assetId, status: 'pending_upload' } })

  const staleTokenUpload = await request.put(`/api/assets/${firstReservation.assetId}/content`, {
    data: file,
    headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(file.byteLength), 'X-Upload-Token': firstReservation.uploadToken,
    },
  })
  expect(staleTokenUpload.status()).toBe(401)

  const resumedUpload = await request.put(`/api/assets/${firstReservation.assetId}/content`, {
    data: file,
    headers: {
      'Content-Type': 'image/jpeg', 'Content-Length': String(file.byteLength), 'X-Upload-Token': resumedReservation.uploadToken,
    },
  })
  expect(resumedUpload.status()).toBe(201)
})

test('content commit racing cancel cleanup converges to one durable server state', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'cancel race only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const file = Buffer.from(`cancel-race-${suffix}`)
  const contentHash = createHash('sha256').update(file).digest('hex')
  const reserve = await request.post('/api/assets/reserve', { data: {
    originalName: `cancel-race-${suffix}.txt`, mimeType: 'text/plain', sizeBytes: file.byteLength,
    mediaType: 'file', contentHash, storageBackend: 'telegram_bot', importOrigin: 'ios-background',
  } })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }

  const [upload, discard] = await Promise.all([
    request.put(`/api/assets/${reservation.assetId}/content`, {
      data: file,
      headers: {
        'Content-Type': 'text/plain', 'Content-Length': String(file.byteLength), 'X-Upload-Token': reservation.uploadToken,
      },
    }),
    request.post('/api/assets/bulk-discard-unstored', { data: { ids: [reservation.assetId] } }),
  ])
  expect(discard.status()).toBe(200)
  const discardBody = await discard.json() as { discarded: number }
  expect([0, 1]).toContain(discardBody.discarded)

  const finalResponse = await request.get(`/api/assets/${reservation.assetId}`)
  expect(finalResponse.status()).toBe(200)
  const finalBody = await finalResponse.json() as { asset: { status: string } }
  if (discardBody.discarded === 1) {
    expect(finalBody.asset.status).toBe('trashed')
    expect(upload.status()).not.toBe(201)
  } else if (upload.status() === 201) {
    expect(finalBody.asset.status).not.toBe('trashed')
    expect(['stored', 'queued', 'analyzing', 'ready', 'limited']).toContain(finalBody.asset.status)
  } else {
    // A lost upload race is still safe only if the reservation remains explicitly
    // recoverable; it may never silently become a stored-but-canceled asset.
    expect(['pending_upload', 'failed', 'trashed']).toContain(finalBody.asset.status)
  }
})

test('batch cleanup discards only unstored reservations', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'batch cleanup API only needs one browser project')

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const pendingBytes = Buffer.from(`pending-cleanup-${suffix}`)
  const pendingHash = createHash('sha256').update(pendingBytes).digest('hex')
  const pendingReserve = await request.post('/api/assets/reserve', { data: {
    originalName: `pending-cleanup-${suffix}.txt`, mimeType: 'text/plain', sizeBytes: pendingBytes.byteLength,
    mediaType: 'file', contentHash: pendingHash, storageBackend: 'telegram_bot', importOrigin: 'web',
  } })
  expect(pendingReserve.status()).toBe(201)
  const pending = await pendingReserve.json() as { assetId: string }
  const discardPending = await request.post('/api/assets/bulk-discard-unstored', { data: { ids: [pending.assetId] } })
  expect(discardPending.status()).toBe(200)
  await expect(discardPending.json()).resolves.toMatchObject({ ok: true, discarded: 1 })

  const storedBytes = Buffer.from(`stored-cleanup-${suffix}`)
  const storedHash = createHash('sha256').update(storedBytes).digest('hex')
  const storedReserve = await request.post('/api/assets/reserve', { data: {
    originalName: `stored-cleanup-${suffix}.txt`, mimeType: 'text/plain', sizeBytes: storedBytes.byteLength,
    mediaType: 'file', contentHash: storedHash, storageBackend: 'telegram_bot', importOrigin: 'web',
  } })
  expect(storedReserve.status()).toBe(201)
  const stored = await storedReserve.json() as { assetId: string; uploadToken: string }
  const upload = await request.put(`/api/assets/${stored.assetId}/content`, {
    data: storedBytes,
    headers: {
      'Content-Type': 'text/plain', 'Content-Length': String(storedBytes.byteLength), 'X-Upload-Token': stored.uploadToken,
    },
  })
  expect(upload.status()).toBe(201)

  const discardStored = await request.post('/api/assets/bulk-discard-unstored', { data: { ids: [stored.assetId] } })
  expect(discardStored.status()).toBe(200)
  await expect(discardStored.json()).resolves.toMatchObject({ ok: true, discarded: 0 })
  const storedAsset = await request.get(`/api/assets/${stored.assetId}`)
  expect(storedAsset.status()).toBe(200)
  await expect(storedAsset.json()).resolves.toMatchObject({ asset: { id: stored.assetId } })
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
      storageBackend: 'telegram_bot',
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
  expect(preview.status()).toBe(200)
  await expect(preview.json()).resolves.toMatchObject({ ok: true, skipped: true })

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
      storageBackend: 'telegram_bot',
    },
  })
  expect(duplicateReserve.status()).toBe(200)
  const duplicateAsset = await duplicateReserve.json() as { assetId: string; duplicate: boolean; duplicateOfAssetId: string; reusedStorage: boolean }
  expect(duplicateAsset.assetId).toBe(reservation.assetId)
  expect(duplicateAsset).toMatchObject({ duplicate: true, duplicateOfAssetId: reservation.assetId, reusedStorage: true })

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
