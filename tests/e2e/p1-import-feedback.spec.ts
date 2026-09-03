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
