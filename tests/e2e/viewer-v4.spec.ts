import { expect, test, type APIRequestContext, type Page } from '@playwright/test'

async function seed(request: APIRequestContext) {
  const response = await request.post('/api/dev/seed')
  expect(response.ok()).toBeTruthy()
}

async function touchGesture(page: Page, points: Array<{ x: number; y: number }>) {
  const client = await page.context().newCDPSession(page)
  const first = points[0]
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: first.x, y: first.y }] })
  for (const point of points.slice(1)) {
    await client.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: point.x, y: point.y }] })
  }
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

async function tapViaCdp(page: Page, x: number, y: number) {
  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
}

test.beforeEach(async ({ request }) => seed(request))

test('desktop viewer exposes zoom, fit, and adjacent preview navigation', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'desktop viewer controls only')
  await page.goto('/?q=.jpg')
  await page.getByRole('button', { name: '打开 morning-garden.jpg' }).click()
  const viewer = page.getByRole('dialog', { name: '查看 morning-garden.jpg' })
  await expect(viewer).toBeVisible()

  await viewer.getByRole('button', { name: '放大' }).click()
  await expect(viewer).toHaveClass(/viewer-zoomed/)
  await viewer.getByRole('button', { name: '适合窗口' }).click()
  await expect(viewer).not.toHaveClass(/viewer-zoomed/)

  await page.keyboard.press('ArrowRight')
  await expect(page.getByRole('dialog', { name: '查看 friends-at-dusk.jpg' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(page.getByRole('dialog', { name: '查看 morning-garden.jpg' })).toBeVisible()
})

test('mobile viewer swipes between photos, dismisses downward, double-tap zooms, and pinches', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'mobile gesture contract')
  await page.goto('/?q=.jpg')
  await page.getByRole('button', { name: '打开 morning-garden.jpg' }).click()
  let viewer = page.getByRole('dialog', { name: '查看 morning-garden.jpg' })
  await expect(viewer).toBeVisible()
  const stageBox = await viewer.locator('.viewer-stage').boundingBox()
  expect(stageBox).not.toBeNull()
  const centerY = stageBox!.y + stageBox!.height * 0.45

  await touchGesture(page, [
    { x: stageBox!.x + stageBox!.width * 0.82, y: centerY },
    { x: stageBox!.x + stageBox!.width * 0.52, y: centerY },
    { x: stageBox!.x + stageBox!.width * 0.18, y: centerY },
  ])
  await expect(page.getByRole('dialog', { name: '查看 friends-at-dusk.jpg' })).toBeVisible()

  viewer = page.getByRole('dialog', { name: '查看 friends-at-dusk.jpg' })
  const secondBox = await viewer.locator('.viewer-stage').boundingBox()
  await touchGesture(page, [
    { x: secondBox!.x + secondBox!.width * 0.5, y: secondBox!.y + secondBox!.height * 0.32 },
    { x: secondBox!.x + secondBox!.width * 0.5, y: secondBox!.y + secondBox!.height * 0.58 },
    { x: secondBox!.x + secondBox!.width * 0.5, y: secondBox!.y + secondBox!.height * 0.78 },
  ])
  await expect(viewer).toBeHidden()

  await page.getByRole('button', { name: '打开 morning-garden.jpg' }).click()
  viewer = page.getByRole('dialog', { name: '查看 morning-garden.jpg' })
  const zoomBox = await viewer.locator('.viewer-stage').boundingBox()
  const tapX = zoomBox!.x + zoomBox!.width / 2
  const tapY = zoomBox!.y + zoomBox!.height / 2
  await tapViaCdp(page, tapX, tapY)
  await tapViaCdp(page, tapX, tapY)
  await expect(viewer).toHaveClass(/viewer-zoomed/)

  await tapViaCdp(page, tapX, tapY)
  await tapViaCdp(page, tapX, tapY)
  await expect(viewer).not.toHaveClass(/viewer-zoomed/)

  const client = await page.context().newCDPSession(page)
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: tapX - 22, y: tapY }, { x: tapX + 22, y: tapY }],
  })
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: tapX - 92, y: tapY }, { x: tapX + 92, y: tapY }],
  })
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await client.detach()
  await expect(viewer).toHaveClass(/viewer-zoomed/)
})
