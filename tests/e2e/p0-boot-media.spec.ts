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
    const style = getComputedStyle(node)
    const rootStyle = getComputedStyle(document.documentElement)
    const transform = style.transform
    const translateY = transform === 'none' ? 0 : new DOMMatrixReadOnly(transform).m42
    const viewportOffset = Number.parseFloat(rootStyle.getPropertyValue('--vv-offset')) || 0
    return {
      position: style.position,
      translateY,
      viewportOffset,
      bottom: rect.bottom,
      viewportBottom: visualViewport ? visualViewport.offsetTop + visualViewport.height : window.innerHeight,
    }
  })
  expect(metrics.position).toBe('fixed')
  // useVisualViewportAnchor intentionally translates the dock upward by --vv-offset
  // when the visual viewport is shorter than the layout viewport (for example while
  // a mobile browser chrome strip is visible). Assert the relationship, not a hard-coded
  // identity transform, then verify the actual dock bottom is pinned to the viewport.
  expect(Math.abs(metrics.translateY + metrics.viewportOffset)).toBeLessThanOrEqual(1)
  expect(Math.abs(metrics.bottom - metrics.viewportBottom)).toBeLessThanOrEqual(2)
})

test('desktop personal surface is compact and does not boot Three.js', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'personal desktop layout only needs the desktop project')
  expect((await request.post('/api/dev/seed')).ok()).toBeTruthy()

  await page.goto('/?app=personal-desktop')
  const hero = page.locator('.memory-aperture')
  await expect(hero).toHaveAttribute('data-render-mode', 'dom')
  await expect(page.locator('html')).toHaveAttribute('data-app-surface', 'personal-desktop')
  await expect(hero.locator('canvas')).toHaveCount(0)
  await expect(hero.locator('.archive-frame-front')).toBeVisible()

  const metrics = await page.evaluate(() => {
    const topbar = document.querySelector<HTMLElement>('.topbar')!
    const aperture = document.querySelector<HTMLElement>('.memory-aperture')!
    return {
      topbarHeight: topbar.getBoundingClientRect().height,
      apertureHeight: aperture.getBoundingClientRect().height,
    }
  })

  expect(metrics.topbarHeight).toBeLessThanOrEqual(62)
  expect(metrics.apertureHeight).toBeLessThanOrEqual(500)

  await page.waitForTimeout(1_300)
  const threeResources = await page.evaluate(() => performance.getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((name) => name.includes('three.module')))
  expect(threeResources).toEqual([])
})

test('access-check rejects protocol-relative external return targets', async ({ page }) => {
  await page.goto('/access-check?return=%2F%2Fevil.example%2Fsteal')
  await expect(page).toHaveURL('http://127.0.0.1:8799/')
})

test('access-check preserves a same-origin return path', async ({ page }) => {
  await page.goto('/access-check?return=%2Falbums%3Fsource%3Dreauth%23top')
  await expect(page).toHaveURL('http://127.0.0.1:8799/albums?source=reauth#top')
})

test('a broken preview reaches a retry state and recovers when the image loads', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'error-state recovery only needs one browser project')
  expect((await request.post('/api/dev/seed')).ok()).toBeTruthy()

  await page.goto('/')
  const tile = page.getByRole('button', { name: '打开 morning-garden.jpg' }).locator('..')
  const preview = tile.locator('img')
  await expect(preview).toBeVisible({ timeout: 15_000 })

  // Trigger the same DOM error event that a 4xx/5xx/broken image produces. This avoids
  // racing the PWA service worker, which can claim the first page while Playwright's
  // page-level route interception is being installed and made this regression test flaky.
  await preview.evaluate((image) => image.dispatchEvent(new Event('error')))
  const retry = page.getByRole('button', { name: '重新加载 morning-garden.jpg' })
  await expect(retry).toBeVisible()

  // Recover: retry re-renders the preview with a cache-busting query and clears the state.
  await retry.click()
  await expect(retry).toBeHidden({ timeout: 15_000 })
  await expect(tile.locator('img')).toHaveAttribute('data-loaded', 'true', { timeout: 15_000 })
})
