import { expect, test, type Page } from '@playwright/test'

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')
const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const exifIphoneJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QEgRXhpZgAATU0AKgAAAAgABQEPAAIAAAAGAAAASgEQAAIAAAAOAAAAUIglAAQAAAABAAAAXpADAAIAAAAUAAAA8JAEAAIAAAAUAAABBAAAAABBcHBsZQBpUGhvbmUgMTUgUHJvAAAGAAEAAgAAAAJOAAAAAAIABQAAAAMAAACsAAMAAgAAAAJXAAAAAAQABQAAAAMAAADEAAYABQAAAAEAAADcAB0AAgAAAAsAAADkAAAAAAAAACUAAAABAAAALgAAAAEAAAAeAAAAAQAAAHoAAAABAAAAGQAAAAEAAAAKAAAAAQAAAA8AAAABMjAyNDowNTowNgAAMjAyNDowNTowNiAwNzowODowOQAyMDI0OjA1OjA2IDA3OjA4OjA5AP/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAIAAgMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOLooor5k/cT/9k=', 'base64')

async function openUpload(page: Page): Promise<void> {
  await page.goto('/')
  const width = page.viewportSize()?.width ?? 1280
  await (width < 768 ? page.getByRole('button', { name: '上传媒体' }) : page.getByRole('button', { name: '加入档案' })).click()
  // Local Playwright runs on :8799 and intentionally has no Windows Telegram
  // Storage Bridge. Keep processor P0s deterministic by explicitly choosing the
  // Bot backend whenever the real user-group picker is therefore unavailable.
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  const filePicker = width < 768
    ? sheet.getByRole('button', { name: '选择文件', exact: true })
    : sheet.getByRole('button', { name: '选择照片、视频或文件' })
  if (await filePicker.isDisabled()) await sheet.getByRole('radio', { name: /Telegram Bot/ }).check()
}

async function chooseFiles(page: Page, names: string[]): Promise<void> {
  const width = page.viewportSize()?.width ?? 1280
  const chooserPromise = page.waitForEvent('filechooser')
  await (width < 768
    ? page.getByRole('button', { name: '选择文件', exact: true })
    : page.getByRole('button', { name: '选择照片、视频或文件' })).click()
  const chooser = await chooserPromise
  await chooser.setFiles(names.map((name, index) => ({ name, mimeType: 'application/pdf', buffer: Buffer.concat([tinyPdf, Buffer.from(String(index))]) })))
}

async function chooseIdenticalFiles(page: Page, names: string[]): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择照片、视频或文件' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles(names.map((name) => ({ name, mimeType: 'application/pdf', buffer: tinyPdf })))
}

async function localJobs(page: Page): Promise<Array<Record<string, unknown>>> {
  return page.evaluate(async () => await new Promise<Array<Record<string, unknown>>>((resolve, reject) => {
    const request = indexedDB.open('private-archive-offline', 3)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction('uploads', 'readonly')
      const all = transaction.objectStore('uploads').getAll()
      all.onerror = () => reject(all.error)
      all.onsuccess = () => resolve(all.result as Array<Record<string, unknown>>)
    }
  }))
}

async function localPayloads(page: Page): Promise<Array<{ key: string; byteLength: number; arrayBuffer: boolean }>> {
  return page.evaluate(async () => await new Promise<Array<{ key: string; byteLength: number; arrayBuffer: boolean }>>((resolve, reject) => {
    const request = indexedDB.open('private-archive-offline', 3)
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      const transaction = request.result.transaction('payloads', 'readonly')
      const all = transaction.objectStore('payloads').getAll()
      all.onerror = () => reject(all.error)
      all.onsuccess = () => resolve((all.result as Array<{ key: string; bytes: ArrayBuffer }>).map((payload) => ({
        key: payload.key,
        byteLength: payload.bytes?.byteLength ?? 0,
        arrayBuffer: payload.bytes instanceof ArrayBuffer,
      })))
    }
  }))
}

async function mockSuccessfulBoundary(page: Page, contentDelayMs = 0): Promise<{ maxActive: () => number; contentCalls: () => number }> {
  let active = 0
  let maximum = 0
  let calls = 0
  await page.route('**/api/assets/reserve', async (route) => {
    const body = route.request().postDataJSON() as { originalName: string }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ assetId: `asset-${body.originalName}`, uploadToken: 'token', duplicate: false, sizeTier: 'inline' }) })
  })
  await page.route('**/api/assets/*/content', async (route) => {
    active += 1; calls += 1; maximum = Math.max(maximum, active)
    if (contentDelayMs) await new Promise((resolve) => setTimeout(resolve, contentDelayMs))
    active -= 1
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null }) })
  })
  return { maxActive: () => maximum, contentCalls: () => calls }
}

test('20-item desktop batch respects upload concurrency and releases completed payloads', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop concurrency contract')
  const boundary = await mockSuccessfulBoundary(page, 120)
  await openUpload(page)
  await chooseFiles(page, Array.from({ length: 20 }, (_, index) => `batch-20-${index}.pdf`))

  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status === 'done').length, { timeout: 30_000 }).toBe(20)
  expect(boundary.contentCalls()).toBe(20)
  expect(boundary.maxActive()).toBeGreaterThan(1)
  expect(boundary.maxActive()).toBeLessThanOrEqual(3)
  const jobs = await localJobs(page)
  expect(jobs.every((job) => !job.fileBlob && !job.previewBlob && !job.opfsPath)).toBe(true)
})

test('same-content files are serialized so only one original reaches storage', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'same-hash scheduler contract')
  let stored = false
  let activeReserve = 0
  let maxActiveReserve = 0
  let reserveCalls = 0
  let contentCalls = 0
  await page.route('**/api/assets/reserve', async (route) => {
    activeReserve += 1
    maxActiveReserve = Math.max(maxActiveReserve, activeReserve)
    reserveCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 40))
    if (stored) {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: 'same-content-asset', duplicate: true, sizeTier: 'inline' }) })
    } else {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ assetId: 'same-content-asset', uploadToken: 'token', duplicate: false, sizeTier: 'inline' }) })
    }
    activeReserve -= 1
  })
  await page.route('**/api/assets/same-content-asset/content', async (route) => {
    contentCalls += 1
    await new Promise((resolve) => setTimeout(resolve, 180))
    stored = true
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null }) })
  })

  await openUpload(page)
  await chooseIdenticalFiles(page, ['same-a.pdf', 'same-b.pdf'])
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status === 'done').length, { timeout: 20_000 }).toBe(2)

  const jobs = await localJobs(page)
  expect(new Set(jobs.map((job) => job.contentHash)).size).toBe(1)
  expect(reserveCalls).toBe(2)
  expect(contentCalls).toBe(1)
  expect(maxActiveReserve).toBe(1)
  expect(jobs.filter((job) => job.deduplicated === true)).toHaveLength(1)
})

test('100-item batch is scheduled to completion without fake byte progress', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'large batch only needs one browser project')
  await page.route('**/api/assets/reserve', async (route) => {
    const body = route.request().postDataJSON() as { originalName: string }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: `duplicate-${body.originalName}`, duplicate: true, sizeTier: 'inline' }) })
  })
  await openUpload(page)
  await chooseFiles(page, Array.from({ length: 100 }, (_, index) => `batch-100-${index}.pdf`))

  await expect.poll(async () => (await localJobs(page)).length, { timeout: 30_000 }).toBe(100)
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status === 'done').length, { timeout: 45_000 }).toBe(100)
  const jobs = await localJobs(page)
  expect(jobs.every((job) => job.deduplicated === true && job.progress === 100)).toBe(true)
  expect(await page.locator('.upload-sheet').evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true)
})

test('iPhone upload sheet exposes complete native sources and metadata-aware photo import', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'iPhone-only native upload sources')
  await openUpload(page)
  await expect(page.getByText('照片 / iCloud Photos')).toBeVisible()
  await expect(page.getByText('文件 / iCloud Drive')).toBeVisible()
  await expect(page.getByText('直接拍摄')).toBeVisible()
  await expect(page.getByText(/EXIF 拍摄时间和 GPS/)).toBeVisible()
  const photoInput = page.locator('#archive-upload-input')
  await expect(photoInput).toHaveAttribute('accept', 'image/*')
  await expect(photoInput).toHaveAttribute('multiple', '')
  await expect(page.getByLabel('从文件或 iCloud Drive 选择')).toHaveAttribute('multiple', '')
  await expect(page.getByLabel('拍照上传')).toHaveAttribute('capture', 'environment')
  await expect(page.getByLabel('录像上传')).toHaveAttribute('capture', 'environment')
})

test('iPhone photo import sends EXIF capture time, GPS and camera metadata to reserve', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile metadata extraction contract')
  let captured: Record<string, unknown> | null = null
  await page.route('**/api/assets/reserve', async (route) => {
    captured = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: 'exif-duplicate', duplicate: true, sizeTier: 'inline' }) })
  })

  await openUpload(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择照片', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([{ name: 'iphone-photo.jpg', mimeType: 'image/jpeg', buffer: exifIphoneJpeg }])

  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  expect(captured).not.toBeNull()
  const reservation = captured as unknown as Record<string, unknown>
  expect(Number.isNaN(Date.parse(String(reservation.takenAt ?? '')))).toBe(false)
  expect(Number(reservation.latitude)).toBeCloseTo(37.775, 4)
  expect(Number(reservation.longitude)).toBeCloseTo(-122.419444, 4)
  expect(reservation.metadata).toMatchObject({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', gpsAltitude: 15 })
})

test('desktop upload sheet accepts arbitrary files and folders including iCloud Photos', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop-only folder import')
  await openUpload(page)
  await expect(page.getByText('文件夹 / iCloud Photos')).toBeVisible()
  await expect(page.getByRole('button', { name: '选择文件夹' })).toBeVisible()
  const mainInput = page.locator('#archive-upload-input')
  await expect(mainInput).not.toHaveAttribute('accept')
  const folderInput = page.locator('.icloud-folder-input')
  await expect(folderInput).toHaveAttribute('multiple', '')
  await expect(folderInput).toHaveAttribute('webkitdirectory', '')
  await expect(folderInput).not.toHaveAttribute('accept')
})

test('iPhone BlobURL-in-IDB incompatibility is bypassed by binary payload storage', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Safari-class IndexedDB payload compatibility is mobile-specific')
  await page.addInitScript(() => {
    const originalPut = IDBObjectStore.prototype.put
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      const candidate = value as { fileBlob?: unknown; previewBlob?: unknown } | null
      if (candidate && (candidate.fileBlob instanceof Blob || candidate.previewBlob instanceof Blob)) {
        throw new DOMException('BlobURLs are not yet supported.', 'DataCloneError')
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key)
    }
  })
  let previewCalls = 0
  await page.route('**/api/assets/reserve', async (route) => {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ assetId: 'ios-photo', uploadToken: 'token', duplicate: false, sizeTier: 'inline' }) })
  })
  await page.route('**/api/assets/ios-photo/preview', async (route) => {
    previewCalls += 1
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
  })
  await page.route('**/api/assets/ios-photo/content', async (route) => {
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null, previewAvailable: true }) })
  })

  await openUpload(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择照片', exact: true }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([{ name: 'ios-picker-photo.png', mimeType: 'image/png', buffer: onePixelPng }])

  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  expect(previewCalls).toBe(0)
  const completed = (await localJobs(page))[0]
  expect(completed.fileBlob).toBeUndefined()
  expect(completed.previewBlob).toBeUndefined()
  expect(await localPayloads(page)).toHaveLength(0)
})

test('240-item mobile import advances through bounded windows and completes one batch', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(testInfo.project.name !== 'mobile', 'mobile large-import window contract')
  let reserveCalls = 0
  await page.route('**/api/assets/reserve', async (route) => {
    reserveCalls += 1
    const body = route.request().postDataJSON() as { originalName: string }
    await new Promise((resolve) => setTimeout(resolve, 35))
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: `duplicate-${body.originalName}`, duplicate: true, sizeTier: 'inline' }) })
  })
  await openUpload(page)
  await chooseFiles(page, Array.from({ length: 240 }, (_, index) => `mobile-240-${index}.pdf`))

  await expect(page.getByRole('dialog', { name: '加入私人档案' })).toBeHidden()
  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toBeVisible()
  await expect.poll(async () => (await localJobs(page)).length, { timeout: 90_000 }).toBe(240)
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status === 'done').length, { timeout: 90_000 }).toBe(240)
  expect(reserveCalls).toBe(240)
  const jobs = await localJobs(page)
  expect(new Set(jobs.map((job) => job.batchId)).size).toBe(1)
  expect(jobs.every((job) => !job.fileBlob && !job.previewBlob && !job.opfsPath)).toBe(true)
})

test('offline registration resumes online and preserves payload until success', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile offline recovery contract')
  await page.route('**/api/assets/reserve', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: 'offline-duplicate', duplicate: true, sizeTier: 'inline' }) }))
  await openUpload(page)
  await page.context().setOffline(true)
  await chooseFiles(page, ['offline-recovery.pdf'])
  await expect.poll(async () => (await localJobs(page)).length).toBe(1)
  expect((await localJobs(page))[0]).toMatchObject({ status: 'paused', controlState: 'active', prepareStatus: 'pending' })
  expect((await localJobs(page))[0].fileBlob).toBeUndefined()
  const persisted = await localPayloads(page)
  expect(persisted).toHaveLength(1)
  expect(persisted[0]).toMatchObject({ arrayBuffer: true })
  expect(persisted[0].key).toContain(':original')
  expect(persisted[0].byteLength).toBeGreaterThan(0)

  await page.context().setOffline(false)
  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  const completed = (await localJobs(page))[0]
  expect(completed.deduplicated).toBe(true)
  expect(Boolean(completed.fileBlob || completed.opfsPath)).toBe(false)
  expect(await localPayloads(page)).toHaveLength(0)
})

test('one Access failure does not block another item in the same batch', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'failure isolation only needs one browser project')
  await page.route('**/api/assets/reserve', async (route) => {
    const body = route.request().postDataJSON() as { originalName: string }
    if (body.originalName.startsWith('access-fails')) {
      await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ error: 'ACCESS_SIGN_IN_REQUIRED' }) })
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: 'other-duplicate', duplicate: true, sizeTier: 'inline' }) })
    }
  })
  await openUpload(page)
  await chooseFiles(page, ['access-fails.pdf', 'other-succeeds.pdf'])
  await expect.poll(async () => (await localJobs(page)).filter((job) => ['done', 'failed'].includes(String(job.status))).length, { timeout: 20_000 }).toBe(2)
  const jobs = await localJobs(page)
  expect(jobs.find((job) => job.fileName === 'access-fails.pdf')).toMatchObject({ status: 'failed' })
  expect(String(jobs.find((job) => job.fileName === 'access-fails.pdf')?.error)).toContain('Access 登录已失效')
  expect(jobs.find((job) => job.fileName === 'other-succeeds.pdf')).toMatchObject({ status: 'done' })
})

test('429 Retry-After retries the same reservation and then completes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'rate-limit contract only needs one browser project')
  let contentCalls = 0
  await page.route('**/api/assets/reserve', (route) => route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ assetId: 'rate-limited-asset', uploadToken: 'same-token', duplicate: false, sizeTier: 'inline' }) }))
  await page.route('**/api/assets/rate-limited-asset/content', async (route) => {
    contentCalls += 1
    if (contentCalls === 1) await route.fulfill({ status: 429, contentType: 'application/json', headers: { 'Retry-After': '1' }, body: JSON.stringify({ error: 'TELEGRAM_RATE_LIMITED' }) })
    else await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null }) })
  })
  await openUpload(page)
  await chooseFiles(page, ['rate-limited.pdf'])
  await expect.poll(async () => contentCalls, { timeout: 10_000 }).toBe(1)
  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  expect(contentCalls).toBe(2)
  const job = (await localJobs(page))[0]
  expect(job.remoteAssetId).toBe('rate-limited-asset')
  expect(job.attempts).toBe(2)
})

test('batch pause aborts active work and continue finishes the retained jobs', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'batch controls only need one browser project')
  await page.route('**/api/assets/reserve', async (route) => {
    const body = route.request().postDataJSON() as { originalName: string }
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ assetId: `pause-${body.originalName}`, uploadToken: 'token', duplicate: false, sizeTier: 'inline' }) })
  })
  await page.route('**/api/assets/*/content', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900))
    await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null }) })
  })
  await openUpload(page)
  await chooseFiles(page, Array.from({ length: 8 }, (_, index) => `pause-${index}.pdf`))
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.stage === 'original').length, { timeout: 10_000 }).toBeGreaterThan(0)
  await page.getByRole('button', { name: '暂停全部' }).click()
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status !== 'done').every((job) => job.controlState === 'paused')).toBe(true)
  expect((await localJobs(page)).filter((job) => job.status !== 'done').every((job) => Boolean(job.fileBlob || job.opfsPath))).toBe(true)
  await page.getByRole('button', { name: '继续全部' }).click()
  await expect.poll(async () => (await localJobs(page)).filter((job) => job.status === 'done').length, { timeout: 20_000 }).toBe(8)
})
