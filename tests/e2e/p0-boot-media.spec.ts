import { expect, test } from '@playwright/test'

// Covers the P0 upload-sheet / bottom-nav stacking fix and the P1 image error-state fix.
// These are the two structural regressions that made the mobile shell feel broken:
//  - the portalled bottom nav dock (z-index 100) floated over the upload modal (z-index 90),
//    so taps leaked through and the modal could not cleanly own the screen;
//  - a failed <img> preview had no onError path, so tiles shimmered forever with no recovery.

test('mobile: bottom nav dock is hidden while the upload sheet is open and restored on close', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'nav/upload stacking is a mobile interaction')
  await page.goto('/')

  const dock = page.locator('.mobile-nav-dock')
  await expect(dock).toBeVisible()

  await page.getByRole('button', { name: '上传媒体' }).click()
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  await expect(sheet).toBeVisible()
  // While the modal owns the screen the nav dock must be gone, not just visually behind it.
  await expect(dock).toBeHidden()

  await sheet.getByRole('button', { name: '关闭' }).click()
  await expect(sheet).toBeHidden()
  // Closing the sheet returns the user to the normal page with a working bottom nav.
  await expect(dock).toBeVisible()
})

test('mobile: bottom nav remains pinned to the visible viewport after scrolling to the document end', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'viewport pinning is a mobile Safari-class interaction')
  expect((await request.post('/api/dev/seed')).ok()).toBeTruthy()
  await page.goto('/')
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight))
  await page.waitForTimeout(100)

  const metrics = await page.locator('.mobile-nav-dock').evaluate((node) => {
    const rect = node.getBoundingClientRect()
    const visualViewport = window.visualViewport
    return {
      position: getComputedStyle(node).position,
      transform: getComputedStyle(node).transform,
      bottom: rect.bottom,
      viewportBottom: visualViewport ? visualViewport.offsetTop + visualViewport.height : window.innerHeight,
    }
  })
  expect(metrics.position).toBe('fixed')
  expect(metrics.transform).toBe('none')
  expect(Math.abs(metrics.bottom - metrics.viewportBottom)).toBeLessThanOrEqual(2)
})

test('access-check rejects protocol-relative external return targets', async ({ page }) => {
  await page.goto('/access-check?return=%2F%2Fevil.example%2Fsteal')
  await expect(page).toHaveURL('http://127.0.0.1:8787/')
})

test('access-check preserves a same-origin return path', async ({ page }) => {
  await page.goto('/access-check?return=%2Falbums%3Fsource%3Dreauth%23top')
  await expect(page).toHaveURL('http://127.0.0.1:8787/albums?source=reauth#top')
})

test('a broken preview reaches a retry state and recovers when the image loads', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'error-state recovery only needs one browser project')
  expect((await request.post('/api/dev/seed')).ok()).toBeTruthy()

  let failPreviews = true
  await page.route('**/api/assets/*/preview*', async (route) => {
    if (failPreviews) return route.fulfill({ status: 502, contentType: 'text/plain', body: 'boom' })
    return route.continue()
  })

  await page.goto('/')
  // Target one known seeded tile so the assertion is deterministic even though every
  // preview initially fails and many tiles show a retry control.
  const retry = page.getByRole('button', { name: '重新加载 morning-garden.jpg' })
  await expect(retry).toBeVisible({ timeout: 15_000 })

  // Recover: the retry re-requests the preview with a cache-busting query and clears the state.
  failPreviews = false
  await retry.click()
  await expect(retry).toBeHidden({ timeout: 15_000 })
})
