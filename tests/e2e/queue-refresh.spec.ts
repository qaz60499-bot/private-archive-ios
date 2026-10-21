import { expect, test, type Page } from '@playwright/test'

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')

async function installUploadReadCounter(page: Page, captureSafetyInterval = false): Promise<void> {
  await page.addInitScript((captureInterval) => {
    type UploadReadWindow = Window & {
      __privateArchiveUploadReads?: number
      __privateArchiveUploadSafetyIntervalMs?: number
      __privateArchiveRunUploadSafetyRefresh?: () => void
    }
    const counter = window as UploadReadWindow
    counter.__privateArchiveUploadReads = 0
    const recordUploadRead = () => {
      counter.__privateArchiveUploadReads = (counter.__privateArchiveUploadReads ?? 0) + 1
    }
    const originalGetAll = IDBObjectStore.prototype.getAll
    const originalIndexGetAll = IDBIndex.prototype.getAll
    IDBObjectStore.prototype.getAll = function (...args: Parameters<typeof originalGetAll>) {
      if (this.name === 'uploads') recordUploadRead()
      return originalGetAll.apply(this, args)
    }
    IDBIndex.prototype.getAll = function (...args: Parameters<typeof originalIndexGetAll>) {
      if (this.objectStore.name === 'uploads') recordUploadRead()
      return originalIndexGetAll.apply(this, args)
    }
    if (captureInterval) {
      const originalSetInterval = window.setInterval.bind(window)
      window.setInterval = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 30_000) {
          counter.__privateArchiveUploadSafetyIntervalMs = timeout
          if (typeof handler === 'function') counter.__privateArchiveRunUploadSafetyRefresh = () => handler(...args)
        }
        return originalSetInterval(handler, timeout, ...args)
      }) as typeof window.setInterval
    }
  }, captureSafetyInterval)
}

async function uploadReadCount(page: Page): Promise<number> {
  return page.evaluate(() => (window as typeof window & { __privateArchiveUploadReads?: number }).__privateArchiveUploadReads ?? 0)
}

test('shows quarantined old native jobs without exposing their filenames', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the upload sheet keeps UploadQueue mounted on desktop')

  await page.goto('/')
  await page.getByRole('button', { name: '加入档案' }).click()
  await page.waitForTimeout(50)
  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('private-archive:native-upload-quarantined', { detail: { count: 3 } }))
  })

  const notice = page.getByRole('status').filter({ hasText: '有 3 项旧版上传尚未确认所属账号' })
  await expect(notice).toHaveText('有 3 项旧版上传尚未确认所属账号，原件已保留，暂未自动上传。')
  await expect(page.getByText(/旧版.*\.jpg|旧版.*\.heic/)).toHaveCount(0)

  await page.evaluate(() => {
    window.dispatchEvent(new CustomEvent('private-archive:native-upload-quarantined', { detail: { count: 0 } }))
  })
  await expect(notice).toHaveCount(0)
})

test('measures idle upload queue reads while the sheet and import toast are both visible', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the upload sheet stays open on desktop while importing')

  await installUploadReadCounter(page)

  await page.goto('/')
  await page.getByRole('button', { name: '加入档案' }).click()
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  const filePicker = sheet.getByRole('button', { name: '选择照片、视频或文件' })
  if (await filePicker.isDisabled()) await sheet.getByRole('radio', { name: /Telegram Bot/ }).check()

  await page.context().setOffline(true)
  await page.locator('#archive-upload-input').setInputFiles({
    name: 'idle-queue-measurement.pdf',
    mimeType: 'application/pdf',
    buffer: tinyPdf,
  })
  await expect(page.locator('.import-toast')).toBeVisible()
  await expect(page.getByRole('heading', { name: '加入私人档案' })).toBeVisible()
  await expect(page.locator('.upload-job')).toBeVisible()

  // Confirm instrumentation observed queue reads before excluding fixture setup and mounting.
  const warmupReads = await uploadReadCount(page)
  expect(warmupReads).toBeGreaterThan(0)

  // Ignore the reads used while adding the fixture and mounting the initial queue.
  await page.evaluate(() => {
    (window as typeof window & { __privateArchiveUploadReads?: number }).__privateArchiveUploadReads = 0
  })
  const measuredMs = 6_500
  await page.waitForTimeout(measuredMs)
  const reads = await uploadReadCount(page)
  const result = { project: testInfo.project.name, measuredMs, warmupUploadsGetAllCalls: warmupReads, idleUploadsGetAllCalls: reads }
  await testInfo.attach('idle-upload-queue-read-count.json', { body: JSON.stringify(result, null, 2), contentType: 'application/json' })
  console.log('IDLE_UPLOAD_QUEUE_READ_COUNT', JSON.stringify(result))
  expect(reads).toBeLessThanOrEqual(1)

  // Keep this fixture inside the isolated browser profile; the E2E context closes after the test.
  await page.context().setOffline(false)
})

test('coalesces native upload state events into one queue refresh', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the upload queue is mounted on desktop')
  await installUploadReadCounter(page)
  await page.goto('/')
  await page.getByRole('button', { name: '加入档案' }).click()
  await expect(page.getByRole('dialog', { name: '加入私人档案' })).toBeVisible()
  await expect.poll(() => uploadReadCount(page)).toBeGreaterThan(0)
  await page.waitForTimeout(350)
  await page.evaluate(() => {
    (window as typeof window & { __privateArchiveUploadReads?: number }).__privateArchiveUploadReads = 0
  })

  await page.evaluate(() => {
    for (let index = 0; index < 12; index += 1) {
      window.dispatchEvent(new CustomEvent('private-archive:native-upload-state', { detail: { jobId: `native-${index}` } }))
    }
  })
  await expect.poll(() => uploadReadCount(page), { timeout: 2_000 }).toBeGreaterThan(0)
  await page.waitForTimeout(350)
  expect(await uploadReadCount(page)).toBe(1)
})

test('retains the 30-second queue safety refresh', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'the upload queue is mounted on desktop')
  await installUploadReadCounter(page, true)
  await page.goto('/')
  await page.getByRole('button', { name: '加入档案' }).click()
  await expect(page.getByRole('dialog', { name: '加入私人档案' })).toBeVisible()
  await expect.poll(() => uploadReadCount(page)).toBeGreaterThan(0)
  await page.waitForTimeout(350)
  const intervalMs = await page.evaluate(() => (window as typeof window & { __privateArchiveUploadSafetyIntervalMs?: number }).__privateArchiveUploadSafetyIntervalMs)
  expect(intervalMs).toBe(30_000)
  await page.evaluate(() => {
    (window as typeof window & { __privateArchiveUploadReads?: number }).__privateArchiveUploadReads = 0
    ;(window as typeof window & { __privateArchiveRunUploadSafetyRefresh?: () => void }).__privateArchiveRunUploadSafetyRefresh?.()
  })
  await expect.poll(() => uploadReadCount(page)).toBeGreaterThan(0)
})
