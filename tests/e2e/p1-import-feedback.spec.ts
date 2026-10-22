import { expect, test, type Page } from '@playwright/test'

const tinyPdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\n%%EOF')

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
})
