import { expect, test, type Page } from '@playwright/test'

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')

test('a retained native retry shows reconnect feedback instead of stalled transfer progress', async ({ page }, testInfo) => {
  await openUpload(page)
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  await sheet.getByRole('radio', { name: /Telegram Bot/ }).check()
  await page.context().setOffline(true)
  const chooser = page.waitForEvent('filechooser')
  await sheet.getByRole('button', { name: testInfo.project.name === 'mobile' ? '选择文件' : '选择照片、视频或文件', exact: true }).click()
  await (await chooser).setFiles({ name: 'retained-native-retry.pdf', mimeType: 'application/pdf', buffer: tinyPdf })
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: '上传媒体' }).click()
  await expect(sheet.getByText('retained-native-retry.pdf', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const opening = indexedDB.open('private-archive-offline', 3)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const transaction = db.transaction('uploads', 'readwrite')
      const store = transaction.objectStore('uploads')
      const reading = store.getAll()
      reading.onsuccess = () => {
        const job = reading.result.find((item: { fileName: string }) => item.fileName === 'retained-native-retry.pdf')
        if (!job) { transaction.abort(); return }
        store.put({ ...job, nativeBackground: true, prepareStatus: 'ready', status: 'retrying', stage: 'original', progress: 32, attempts: 14, error: '正在重新连接后台上传。' })
      }
      transaction.oncomplete = () => { db.close(); resolve() }
      transaction.onerror = () => { db.close(); reject(transaction.error) }
      transaction.onabort = () => { db.close(); reject(new Error('RETRY_FIXTURE_NOT_SAVED')) }
    }
  }))
  await page.evaluate(() => window.dispatchEvent(new Event('private-archive:native-upload-state')))
  await (testInfo.project.name === 'mobile' ? page.getByRole('button', { name: '上传媒体' }) : page.getByRole('button', { name: '加入档案' })).click()
  const row = sheet.locator('.upload-job').filter({ hasText: 'retained-native-retry.pdf' })
  await expect(row).toContainText('正在重新连接并重试 · 已尝试 14 次')
  await expect(row).not.toContainText('32%')
  await expect(row.locator('.progress')).toHaveCount(0)
  await expect(row.getByRole('button', { name: '暂停 retained-native-retry.pdf' })).toBeEnabled()
})

test.beforeEach(async ({ request }) => {
  await request.post('/api/dev/seed')
})

async function openUpload(page: Page): Promise<void> {
  await page.goto('/')
  const width = page.viewportSize()?.width ?? 1280
  await (width < 768 ? page.getByRole('button', { name: '上传媒体' }) : page.getByRole('button', { name: '加入档案' })).click()
}

test('archive cover has no hero canvas and keeps actions interactive', async ({ page }) => {
  await page.goto('/')
  const hero = page.locator('.memory-aperture')
  await expect(hero.locator('canvas')).toHaveCount(0)
  await expect(hero.locator('.archive-composition')).toHaveCSS('pointer-events', 'auto')
  await expect(hero.getByRole('button', { name: '导入' })).toBeEnabled()
})

test('home statistics refresh once after a burst of committed uploads without reopening the page', async ({ page }) => {
  let photoCount = 10
  let summaryRequests = 0
  await page.route('**/api/archive-summary', async (route) => {
    summaryRequests += 1
    await route.fulfill({ json: { assetCount: photoCount, photoCount, albumCount: 2, lastUpdate: '2026-10-21T00:00:00Z' } })
  })
  await page.goto('/')
  const count = page.locator('.archive-hero-stats > div').first().locator('dd')
  await expect(count).toHaveText('10')
  const before = summaryRequests
  photoCount = 11
  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) window.dispatchEvent(new Event('private-archive:upload-committed'))
  })
  await expect(count).toHaveText('11')
  expect(summaryRequests).toBe(before + 1)
})

test('opening an album page starts at its own heading after timeline scrolling', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.memory-aperture')).toBeVisible()
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }))
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  await page.getByRole('link', { name: '相册', exact: true }).click()
  await expect(page).toHaveURL(/\/albums$/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await expect(page.getByRole('heading', { name: '相册', exact: true })).toBeInViewport()
})

test('upload close stays reachable after scrolling and preserves an offline task', async ({ page }, testInfo) => {
  await openUpload(page)
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  await sheet.getByRole('radio', { name: /Telegram Bot/ }).check()
  await page.context().setOffline(true)
  const chooserPromise = page.waitForEvent('filechooser')
  await sheet.getByRole('button', { name: testInfo.project.name === 'mobile' ? '选择文件' : '选择照片、视频或文件', exact: true }).click()
  await (await chooserPromise).setFiles({ name: 'keep-after-close.pdf', mimeType: 'application/pdf', buffer: tinyPdf })

  const readTask = () => page.evaluate(() => new Promise<{ id: string; status: string } | null>((resolve, reject) => {
    const opening = indexedDB.open('private-archive-offline', 3)
    opening.onerror = () => reject(opening.error)
    opening.onsuccess = () => {
      const db = opening.result
      const reading = db.transaction('uploads', 'readonly').objectStore('uploads').getAll()
      reading.onerror = () => { db.close(); reject(reading.error) }
      reading.onsuccess = () => {
        const row = reading.result.find((job: { fileName: string }) => job.fileName === 'keep-after-close.pdf')
        db.close()
        resolve(row ? { id: row.id, status: row.status } : null)
      }
    }
  }))
  await expect.poll(readTask).not.toBeNull()
  const before = await readTask()
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: '上传媒体' }).click()
  await sheet.evaluate((element) => { element.scrollTop = element.scrollHeight })
  await expect.poll(() => sheet.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await expect(sheet.getByRole('button', { name: '关闭', exact: true })).toBeInViewport({ ratio: 1 })
  await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  await expect(sheet).toHaveCount(0)
  expect(await readTask()).toEqual(before)
})

test('choosing files shows immediate app-level import feedback that survives sheet close', async ({ page }, testInfo) => {
  // Deduplicate everything so the queue settles quickly; we only assert the feedback path.
  await page.route('**/api/assets/reserve', async (route) => {
    const body = route.request().postDataJSON() as { originalName: string }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: `dup-${body.originalName}`, duplicate: true, sizeTier: 'inline' }) })
  })

  await openUpload(page)
  const chooserPromise = page.waitForEvent('filechooser')
  const trigger = testInfo.project.name === 'mobile'
    ? page.getByRole('button', { name: '选择文件', exact: true })
    : page.getByRole('button', { name: '选择照片、视频或文件' })
  await trigger.click()
  const chooser = await chooserPromise
  await chooser.setFiles(Array.from({ length: 6 }, (_, index) => ({ name: `feedback-${index}.pdf`, mimeType: 'application/pdf', buffer: Buffer.concat([tinyPdf, Buffer.from(String(index))]) })))

  // The global toast is a portal on <body>, so it stays visible even on mobile where the
  // sheet closes and the app returns to the timeline.
  const toast = page.locator('.import-toast')
  await expect(toast).toBeVisible()
  await expect(toast).toContainText('项')
  await expect.poll(() => toast.textContent(), { timeout: 15_000 }).toContain('云端已确认')

  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  if (await sheet.isVisible()) await sheet.getByRole('button', { name: '关闭', exact: true }).click()
  const localFeedback = page.locator('.mobile-import-status')
  await expect(localFeedback).toContainText('本机上传队列已登记 6 项')
  await expect(localFeedback).not.toContainText(/Telegram|云端|后台确认/)
  await localFeedback.getByRole('button', { name: '查看上传队列' }).click()
  await expect(page.getByRole('dialog', { name: '加入私人档案' })).toBeVisible()
})

test('home timeline anchor keeps its controls clear of the sticky topbar', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('link', { name: '查看时间线' }).click()

  const controls = page.locator('#archive-timeline')
  await expect(page.getByRole('button', { name: '全部', exact: true })).toBeInViewport()
  await expect(controls.getByRole('button', { name: '选择', exact: true })).toBeInViewport()
  const verticalGap = await page.evaluate(() => {
    const target = document.querySelector('#archive-timeline')
    const topbar = document.querySelector('.topbar')
    if (!target || !topbar) return Number.NEGATIVE_INFINITY
    return target.getBoundingClientRect().top - topbar.getBoundingClientRect().bottom
  })
  expect(verticalGap).toBeGreaterThanOrEqual(8)
})

test('mobile bulk selection wraps the delete action into the visible control layout', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile viewport only')
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开 morning-garden.jpg' })).toBeVisible()
  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: /^选择 / }).first().click()

  const controls = page.locator('#archive-timeline')
  const actions = controls.locator('.timeline-actions')
  const deleteButton = actions.getByRole('button', { name: '删除选中' })
  await expect(deleteButton).toBeEnabled()
  await controls.evaluate((element) => element.scrollIntoView({ block: 'start', behavior: 'instant' }))
  await expect(deleteButton).toBeInViewport({ ratio: 1 })
  const layout = await actions.evaluate((element) => {
    const button = element.querySelector('.selection-delete-button')
    if (!button) return null
    const row = element.getBoundingClientRect()
    const action = button.getBoundingClientRect()
    return {
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      rowLeft: row.left,
      rowRight: row.right,
      actionLeft: action.left,
      actionRight: action.right,
    }
  })
  expect(layout).not.toBeNull()
  expect(layout!.scrollWidth).toBeLessThanOrEqual(layout!.clientWidth + 1)
  expect(layout!.actionLeft).toBeGreaterThanOrEqual(layout!.rowLeft - 1)
  expect(layout!.actionRight).toBeLessThanOrEqual(layout!.rowRight + 1)
})
