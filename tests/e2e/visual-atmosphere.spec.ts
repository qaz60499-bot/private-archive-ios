import { expect, test } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  await request.post('/api/dev/seed')
})

test('archive atmosphere and custom navigation glyphs follow the active route', async ({ page }) => {
  test.skip(page.viewportSize()!.width < 768, 'desktop rail route animation only applies to desktop')
  await page.goto('/people')

  const atmosphere = page.locator('.archive-atmosphere')
  await expect(atmosphere).toBeVisible()
  await expect(atmosphere.locator('canvas')).toBeVisible()
  await expect(atmosphere.locator('.route-exposure-veil')).toHaveCount(1)
  await expect(atmosphere.locator('.route-exposure-veil')).toHaveCSS('pointer-events', 'none')
  await expect(page.locator('html')).toHaveAttribute('data-archive-scene', '2')

  const activeGlyph = page.locator('.desktop-sidebar .rail-link.active .archive-glyph')
  await expect(activeGlyph).toHaveCount(1)
  await expect(activeGlyph.locator('.glyph-orbit')).toHaveCount(1)

  await page.getByRole('link', { name: '发现' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-archive-scene', '1')
  await expect(page.locator('.desktop-sidebar .rail-link.active .glyph-discover')).toBeVisible()
})

test('home timeline uses the Memory Aperture hero while search stays task-focused', async ({ page }, testInfo) => {
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toBeVisible()
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText('时间留下的形状')
  await expect(hero.locator('.memory-aperture-stage canvas')).toHaveCount(1)
  await expect(hero.locator('.memory-aperture-stage')).toHaveAttribute('aria-hidden', 'true')
  await expect(hero.locator('.memory-aperture-label')).toHaveCount(0)
  await expect(hero.locator('.memory-aperture-count')).toBeVisible()
  await expect(hero).toHaveAttribute('data-interaction-mode', testInfo.project.name === 'mobile' ? 'scroll' : 'pointer')

  await page.goto('/?q=archive')
  await expect(page.locator('.memory-aperture')).toHaveCount(0)
  await expect(page.locator('.page-intro')).toBeVisible()
  await expect(page.locator('.page-intro h1')).toContainText('archive')
})

test('reduced motion keeps the Memory Aperture as a static poster', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toBeVisible()
  await expect(hero).toHaveAttribute('data-render-mode', 'static')
  await expect(hero.locator('.memory-aperture-fallback')).toBeVisible()
  await expect(hero.locator('.memory-aperture-stage canvas')).toBeHidden()
})

test('reduced motion keeps the static darkroom field and disables WebGL motion', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto(testInfo.project.name === 'mobile' ? '/discover' : '/people')

  await expect(page.locator('.archive-atmosphere-fallback')).toBeVisible()
  await expect(page.locator('.archive-atmosphere canvas')).toBeHidden()
  await expect(page.locator('.route-exposure-veil')).toBeHidden()
  const activeDot = testInfo.project.name === 'mobile'
    ? page.locator('.mobile-bottom-nav a.active .glyph-dot')
    : page.locator('.desktop-sidebar .rail-link.active .glyph-dot')
  await expect(activeDot).toHaveCSS('animation-name', 'none')
})

test('Memory Aperture stays bounded across required responsive widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one project is enough for the responsive viewport sweep')

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 430, height: 844 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1440, height: 960 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    await expect(page.locator('.memory-aperture')).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)

    const stage = await page.locator('.memory-aperture-stage').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width }
    })
    expect(stage.left).toBeGreaterThanOrEqual(-1)
    expect(stage.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(stage.width).toBeGreaterThan(240)
  }
})

test('mobile Memory Aperture stays inside the viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile hero geometry only applies to mobile')
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toBeVisible()
  const geometry = await hero.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { left: rect.left, right: rect.right, width: rect.width }
  })
  const viewport = page.viewportSize()!
  expect(geometry.left).toBeGreaterThanOrEqual(-1)
  expect(geometry.right).toBeLessThanOrEqual(viewport.width + 1)
  expect(geometry.width).toBeLessThanOrEqual(viewport.width + 2)
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)
})

test('desktop Memory Aperture accepts pointer movement and settles on leave', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'pointer interaction applies to desktop')
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  const bounds = await hero.boundingBox()
  expect(bounds).not.toBeNull()
  await expect(hero).toHaveAttribute('data-interaction-mode', 'pointer')
  await expect(hero).toHaveAttribute('data-interaction-state', 'idle')

  const box = bounds!
  for (const [x, y] of [
    [box.x + box.width * .2, box.y + box.height * .5],
    [box.x + box.width * .8, box.y + box.height * .5],
    [box.x + box.width * .5, box.y + box.height * .2],
    [box.x + box.width * .5, box.y + box.height * .8],
  ]) {
    await page.mouse.move(x, y, { steps: 8 })
    await page.waitForTimeout(90)
  }
  await expect(hero).toHaveAttribute('data-interaction-state', 'engaged')
  await page.mouse.move(2, 2, { steps: 8 })
  await expect(hero).toHaveAttribute('data-interaction-state', 'settling')
})

test('mobile Memory Aperture exposes scroll inertia for slow, fast, reverse, and settle gestures', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'scroll inertia is a mobile interaction')
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toHaveAttribute('data-interaction-mode', 'scroll')
  await expect(hero).toHaveAttribute('data-scroll-active', 'false')

  for (let index = 0; index < 4; index += 1) {
    await page.evaluate(() => window.scrollBy({ top: 26, behavior: 'instant' }))
    await page.waitForTimeout(85)
  }
  await expect(hero).toHaveAttribute('data-scroll-active', 'true')
  await expect.poll(() => hero.getAttribute('data-scroll-active'), { timeout: 4_000 }).toBe('false')

  await page.evaluate(() => window.scrollBy({ top: 260, behavior: 'instant' }))
  await expect(hero).toHaveAttribute('data-scroll-active', 'true')
  await page.evaluate(() => window.scrollBy({ top: -180, behavior: 'instant' }))
  await expect(hero).toHaveAttribute('data-scroll-active', 'true')
  await expect.poll(() => hero.getAttribute('data-scroll-active'), { timeout: 4_000 }).toBe('false')
})

test('mobile navigation uses archive glyphs and the atmosphere covers the viewport', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile atmosphere geometry only applies to mobile')
  await page.goto('/discover')

  await expect(page.locator('.mobile-bottom-nav .archive-glyph')).toHaveCount(5)
  const geometry = await page.locator('.archive-atmosphere').evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { width: rect.width, height: rect.height }
  })
  const viewport = page.viewportSize()!
  expect(geometry.width).toBeGreaterThanOrEqual(viewport.width - 1)
  expect(geometry.height).toBeGreaterThanOrEqual(viewport.height - 1)
})

test('mobile bottom navigation stays pinned to the visual viewport while the page scrolls', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile fixed navigation only applies to mobile')
  await page.goto('/settings')

  const dock = page.locator('.mobile-nav-dock')
  await expect(dock).toBeVisible()
  expect(await dock.evaluate((element) => element.parentElement?.tagName)).toBe('BODY')

  const initial = await dock.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  })
  await page.evaluate(() => window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' }))
  await page.waitForTimeout(50)
  const scrolled = await dock.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { top: rect.top, bottom: rect.bottom }
  })

  const viewport = page.viewportSize()!
  expect(Math.abs(initial.bottom - viewport.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrolled.bottom - viewport.height)).toBeLessThanOrEqual(1)
  expect(Math.abs(scrolled.top - initial.top)).toBeLessThanOrEqual(1)
})
