import { expect, test, type Page } from '@playwright/test'

const webOrigin = 'http://photo.localhost:8799'
const exifIphoneJpeg = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/4QEgRXhpZgAATU0AKgAAAAgABQEPAAIAAAAGAAAASgEQAAIAAAAOAAAAUIglAAQAAAABAAAAXpADAAIAAAAUAAAA8JAEAAIAAAAUAAABBAAAAABBcHBsZQBpUGhvbmUgMTUgUHJvAAAGAAEAAgAAAAJOAAAAAAIABQAAAAMAAACsAAMAAgAAAAJXAAAAAAQABQAAAAMAAADEAAYABQAAAAEAAADcAB0AAgAAAAsAAADkAAAAAAAAACUAAAABAAAALgAAAAEAAAAeAAAAAQAAAHoAAAABAAAAGQAAAAEAAAAKAAAAAQAAAA8AAAABMjAyNDowNTowNgAAMjAyNDowNTowNiAwNzowODowOQAyMDI0OjA1OjA2IDA3OjA4OjA5AP/bAEMACAYGBwYFCAcHBwkJCAoMFA0MCwsMGRITDxQdGh8eHRocHCAkLicgIiwjHBwoNyksMDE0NDQfJzk9ODI8LjM0Mv/bAEMBCQkJDAsMGA0NGDIhHCEyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMv/AABEIAAIAAgMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2gAMAwEAAhEDEQA/AOLooor5k/cT/9k=', 'base64')

async function mockPortalSession(page: Page, storageBackend: 'telegram_user_group' | 'telegram_bot'): Promise<void> {
  await page.route('**/api/storage-preference', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ defaultStorageBackend: storageBackend }) }))
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

test('hosted Web renders the upload portal even if app-auth status is unavailable', async ({ page }) => {
  await page.route('**/api/auth/status', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'SHOULD_NOT_GATE_WEB' }) }))
  await page.route('**/api/storage-preference', (route) => route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'PREFERENCE_TEMPORARILY_UNAVAILABLE' }) }))
  await page.goto(webOrigin)
  await expect(page.getByRole('heading', { name: 'Upload Portal' })).toBeVisible()
  await expect(page.getByText('Cloudflare Access 已验证')).toBeVisible()
  await expect(page.getByText('SHOULD_NOT_GATE_WEB')).toHaveCount(0)
})

test('hosted Web is a direct upload portal and personal-desktop query cannot restore the SaaS shell', async ({ page }) => {
  await mockPortalSession(page, 'telegram_user_group')
  await page.goto(`${webOrigin}/?app=personal-desktop`)

  await expect(page.getByRole('heading', { name: 'Upload Portal' })).toBeVisible()
  await expect(page.getByRole('heading', { name: '选择上传来源' })).toBeVisible()
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await expect(page.getByText(/手机 \/ 普通浏览器无法直接写 Telegram 私人群组/)).toBeVisible()
  await expect(page.getByLabel('选择照片 / iCloud Photos')).toBeDisabled()
  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toHaveCount(0)
  await expect(page.getByText('Timeline', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Albums', { exact: true })).toHaveCount(0)
  await expect(page.getByText('Settings', { exact: true })).toHaveCount(0)

  await page.getByRole('button', { name: '本次改用 Bot' }).click()
  await expect(page.getByLabel('选择照片 / iCloud Photos')).toBeEnabled()
  await expect(page.getByRole('radio', { name: /Telegram Bot/ })).toBeChecked()
})

test('mobile Web exposes Photos, video, Files/iCloud Drive, camera and recording without extension allowlists', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile source contract')
  await mockPortalSession(page, 'telegram_bot')
  await page.goto(webOrigin)

  await expect(page.getByLabel('选择照片 / iCloud Photos')).toHaveAttribute('accept', 'image/*')
  await expect(page.getByLabel('选择照片 / iCloud Photos')).toHaveAttribute('multiple', '')
  await expect(page.getByLabel('选择视频')).toHaveAttribute('accept', 'video/*')
  await expect(page.getByLabel('选择文件 / iCloud Drive')).not.toHaveAttribute('accept')
  await expect(page.getByLabel('选择文件 / iCloud Drive')).toHaveAttribute('multiple', '')
  await expect(page.getByLabel('拍照上传')).toHaveAttribute('capture', 'environment')
  await expect(page.getByLabel('录像上传')).toHaveAttribute('capture', 'environment')
  await expect(page.getByText(/Apple Photos 相册归属、人物、Memories、Favorites/)).toBeVisible()
})

test('mobile Web photo import reserves EXIF capture time, GPS, altitude and camera metadata', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile metadata contract')
  let captured: Record<string, unknown> | null = null
  await mockPortalSession(page, 'telegram_bot')
  await page.route('**/api/assets/reserve', async (route) => {
    captured = route.request().postDataJSON() as Record<string, unknown>
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assetId: 'web-exif-duplicate', duplicate: true, sizeTier: 'inline' }) })
  })
  await page.goto(webOrigin)
  await page.getByLabel('选择照片 / iCloud Photos').setInputFiles([{ name: 'iphone-photo.jpg', mimeType: 'image/jpeg', buffer: exifIphoneJpeg }])

  await expect.poll(async () => (await localJobs(page))[0]?.status, { timeout: 20_000 }).toBe('done')
  expect(captured).not.toBeNull()
  const reservation = captured as unknown as Record<string, unknown>
  expect(Number.isNaN(Date.parse(String(reservation.takenAt ?? '')))).toBe(false)
  expect(Number(reservation.latitude)).toBeCloseTo(37.775, 4)
  expect(Number(reservation.longitude)).toBeCloseTo(-122.419444, 4)
  expect(reservation.metadata).toMatchObject({ cameraMake: 'Apple', cameraModel: 'iPhone 15 Pro', gpsAltitude: 15 })
  await expect(page.getByText('精确重复 · 已复用原件')).toBeVisible()
})

test('desktop Web exposes drag/drop and folder selection while arbitrary-file input stays unrestricted', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop source contract')
  await mockPortalSession(page, 'telegram_bot')
  await page.goto(webOrigin)

  await expect(page.getByText('拖拽文件到这里')).toBeVisible()
  await expect(page.getByLabel('选择文件夹')).toHaveAttribute('multiple', '')
  await expect(page.getByLabel('选择文件夹')).toHaveAttribute('webkitdirectory', '')
  await expect(page.getByLabel('选择文件 / iCloud Drive')).not.toHaveAttribute('accept')
})
