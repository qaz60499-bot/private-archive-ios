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

test('home is a DOM archive cover while search stays task-focused', async ({ page }) => {
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toBeVisible()
  await expect(hero).toHaveAttribute('data-render-mode', 'dom')
  await expect(hero.getByRole('heading', { level: 1 })).toHaveText('时间留下的形状')
  await expect(hero.locator('canvas')).toHaveCount(0)
  await expect(hero.locator('.archive-composition')).toBeVisible()
  await expect(hero.locator('.archive-frame')).toHaveCount(3)
  await expect(hero.locator('.archive-hero-stats')).toBeVisible()
  await expect(hero.getByRole('link', { name: '查看时间线' })).toBeVisible()
  await expect(hero.getByRole('button', { name: '导入' })).toBeVisible()

  await page.goto('/?q=archive')
  await expect(page.locator('.memory-aperture')).toHaveCount(0)
  await expect(page.locator('.page-intro')).toBeVisible()
  await expect(page.locator('.page-intro h1')).toContainText('archive')
})

test('desktop archive composition responds locally without blocking the timeline action', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'pointer proximity is intentionally desktop-only')
  await page.goto('/')

  const stage = page.locator('.memory-aperture-stage')
  const bounds = await stage.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * 0.82, bounds!.y + bounds!.height * 0.28)

  const depth = await stage.evaluate((element) => ({
    frontX: parseFloat((element as HTMLElement).style.getPropertyValue('--archive-front-x')) || 0,
    frontY: parseFloat((element as HTMLElement).style.getPropertyValue('--archive-front-y')) || 0,
  }))
  expect(Math.abs(depth.frontX) + Math.abs(depth.frontY)).toBeGreaterThan(1)
  expect(Math.abs(depth.frontX)).toBeLessThanOrEqual(5.3)
  expect(Math.abs(depth.frontY)).toBeLessThanOrEqual(3.9)

  await page.getByRole('link', { name: '查看时间线' }).click()
  await expect(page.locator('#archive-timeline')).toBeVisible()
  expect(await page.evaluate(() => location.hash)).toBe('#archive-timeline')
})

test('timeline exposes factual monthly memory markers without scroll-jacking', async ({ page }) => {
  await page.goto('/')

  const marker = page.locator('.timeline-month-marker').first()
  await expect(marker).toBeVisible()
  await expect(marker).toContainText(/\d{4}/)
  await expect(marker).toContainText(/这个月留下了 \d+ 项记录/)
  await expect(page.locator('.timeline-month-chapter').first()).toHaveCSS('display', 'grid')
  await expect(page.locator('html')).not.toHaveCSS('scroll-snap-type', /mandatory/)
})

test('reduced motion keeps the DOM archive cover usable without canvas', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')

  const hero = page.locator('.memory-aperture')
  await expect(hero).toBeVisible()
  await expect(hero).toHaveAttribute('data-render-mode', 'dom')
  await expect(hero.locator('.archive-composition')).toBeVisible()
  await expect(hero.locator('canvas')).toHaveCount(0)

  const stage = hero.locator('.memory-aperture-stage')
  const bounds = await stage.boundingBox()
  expect(bounds).not.toBeNull()
  await page.mouse.move(bounds!.x + bounds!.width * .85, bounds!.y + bounds!.height * .2)
  const pointerDepth = await stage.evaluate((element) => (element as HTMLElement).style.getPropertyValue('--archive-front-x'))
  expect(pointerDepth === '' || pointerDepth === '0px').toBeTruthy()
})

test('reduced motion keeps the static darkroom field and disables ambient WebGL motion', async ({ page }, testInfo) => {
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

test('archive cover stays bounded across required responsive widths', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'one project is enough for the responsive viewport sweep')

  for (const viewport of [
    { width: 375, height: 812 },
    { width: 430, height: 844 },
    { width: 768, height: 900 },
    { width: 1280, height: 900 },
    { width: 1366, height: 768 },
    { width: 1440, height: 960 },
    { width: 1920, height: 1080 },
  ]) {
    await page.setViewportSize(viewport)
    await page.goto('/')
    const hero = page.locator('.memory-aperture')
    await expect(hero).toBeVisible()
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width + 1)

    const composition = await page.locator('.archive-composition').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { left: rect.left, right: rect.right, width: rect.width, height: rect.height }
    })
    expect(composition.left).toBeGreaterThanOrEqual(-1)
    expect(composition.right).toBeLessThanOrEqual(viewport.width + 1)
    expect(composition.width).toBeGreaterThan(240)
    expect(composition.height).toBeGreaterThan(240)
  }
})

test('1366x768 personal desktop keeps the complete cover above the timeline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Windows personal surface only needs desktop project')
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.goto('/?app=personal-desktop')

  await expect(page.locator('html')).toHaveAttribute('data-app-surface', 'personal-desktop')
  const hero = page.locator('.memory-aperture')
  const frontFrame = hero.locator('.archive-frame-front')
  const timeline = page.locator('#archive-timeline')
  await expect(frontFrame).toBeVisible()
  await expect(timeline).toBeVisible()
  const geometry = await page.evaluate(() => {
    const hero = document.querySelector('.memory-aperture')?.getBoundingClientRect()
    const frame = document.querySelector('.archive-frame-front')?.getBoundingClientRect()
    const timeline = document.querySelector('#archive-timeline')?.getBoundingClientRect()
    return hero && frame && timeline ? { heroBottom: hero.bottom, frameBottom: frame.bottom, timelineTop: timeline.top } : null
  })
  expect(geometry).not.toBeNull()
  expect(geometry!.frameBottom).toBeLessThanOrEqual(geometry!.heroBottom + 1)
  expect(geometry!.timelineTop).toBeGreaterThanOrEqual(geometry!.heroBottom - 1)
})

test('mobile archive cover stays inside the viewport', async ({ page }, testInfo) => {
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
