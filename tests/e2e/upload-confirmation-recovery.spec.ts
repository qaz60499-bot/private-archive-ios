import { expect, test, type Page } from '@playwright/test'

const originalBytes = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')
const assetId = 'confirmation-recovery-asset'

async function openUpload(page: Page): Promise<void> {
  await page.goto('/')
  await page.getByRole('button', { name: '加入档案' }).click()
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  const filePicker = sheet.getByRole('button', { name: '选择照片、视频或文件' })
  if (await filePicker.isDisabled()) await sheet.getByRole('radio', { name: /Telegram Bot/ }).check()
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

async function persistedOriginalBytes(page: Page, id: string): Promise<number[] | null> {
  return page.evaluate(async (jobId) => {
    const request = indexedDB.open('private-archive-offline', 3)
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => resolve(request.result)
    })
    try {
      const job = await new Promise<{ opfsPath?: string; fileBlob?: Blob } | undefined>((resolve, reject) => {
        const get = database.transaction('uploads', 'readonly').objectStore('uploads').get(jobId)
        get.onerror = () => reject(get.error)
        get.onsuccess = () => resolve(get.result as { opfsPath?: string; fileBlob?: Blob } | undefined)
      })
      if (!job) return null

      if (job.opfsPath && typeof navigator.storage?.getDirectory === 'function') {
        try {
          const root = await navigator.storage.getDirectory()
          const directory = await root.getDirectoryHandle('private-archive-uploads')
          const file = await (await directory.getFileHandle(job.opfsPath)).getFile()
          return Array.from(new Uint8Array(await file.arrayBuffer()))
        } catch {
          // Read the IndexedDB fallback below if OPFS is unavailable.
        }
      }

      const payload = await new Promise<{ bytes?: ArrayBuffer } | undefined>((resolve, reject) => {
        const get = database.transaction('payloads', 'readonly').objectStore('payloads').get(`${jobId}:original`)
        get.onerror = () => reject(get.error)
        get.onsuccess = () => resolve(get.result as { bytes?: ArrayBuffer } | undefined)
      })
      if (payload?.bytes instanceof ArrayBuffer) return Array.from(new Uint8Array(payload.bytes))
      if (job.fileBlob) return Array.from(new Uint8Array(await job.fileBlob.arrayBuffer()))
      return null
    } finally {
      database.close()
    }
  }, id)
}

test('invalid 2xx confirmation retains the original until a stored confirmation succeeds', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'confirmation recovery integration only needs one browser project')

  let reserveCalls = 0
  let contentCalls = 0
  let invalidConfirmationReturned = false
  let allowSuccessfulConfirmation!: () => void
  const successfulConfirmationGate = new Promise<void>((resolve) => { allowSuccessfulConfirmation = resolve })

  await page.route('**/api/assets/reserve', async (route) => {
    reserveCalls += 1
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ assetId, uploadToken: 'confirmation-recovery-token', duplicate: false, sizeTier: 'inline' }),
    })
  })
  await page.route(`**/api/assets/${assetId}/content`, async (route) => {
    contentCalls += 1
    expect(route.request().postDataBuffer()).toEqual(originalBytes)
    if (contentCalls === 1) {
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ asset: null }) })
      invalidConfirmationReturned = true
      return
    }

    await successfulConfirmationGate
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({ asset: { id: assetId, status: 'stored' } }),
    })
  })

  await openUpload(page)
  const chooserPromise = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: '选择照片、视频或文件' }).click()
  const chooser = await chooserPromise
  await chooser.setFiles([{ name: 'confirmation-recovery.pdf', mimeType: 'application/pdf', buffer: originalBytes }])

  try {
    await expect.poll(() => contentCalls, { timeout: 15_000 }).toBe(2)
    expect(invalidConfirmationReturned).toBe(true)
    expect(reserveCalls).toBe(1)

    const job = (await localJobs(page))[0]
    expect(job.remoteAssetId).toBe(assetId)
    expect(job.status).not.toBe('done')
    expect(await persistedOriginalBytes(page, String(job.id))).toEqual(Array.from(originalBytes))
  } finally {
    allowSuccessfulConfirmation()
  }

  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  expect(reserveCalls).toBe(1)
  expect(contentCalls).toBe(2)
  const completedJob = (await localJobs(page))[0]
  expect(completedJob.remoteAssetId).toBe(assetId)
  await expect.poll(async () => await persistedOriginalBytes(page, String(completedJob.id)), { timeout: 5_000 }).toBeNull()
})
