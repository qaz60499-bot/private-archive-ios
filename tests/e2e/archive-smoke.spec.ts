import { expect, test } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const response = await request.post('/api/dev/seed')
  expect(response.ok()).toBeTruthy()
})

test('Windows personal surface keeps the opening hero compact', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'personal desktop geometry only needs the desktop project')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/?app=personal-desktop')

  await expect(page.locator('html')).toHaveAttribute('data-app-surface', 'personal-desktop')
  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toBeVisible()
  const stageBox = await page.locator('.memory-aperture-stage').boundingBox()
  const topbarBox = await page.locator('.topbar').boundingBox()
  expect(stageBox).not.toBeNull()
  expect(topbarBox).not.toBeNull()
  expect(stageBox!.height).toBeLessThanOrEqual(500)
  expect(topbarBox!.height).toBeLessThanOrEqual(68)
})

test('timeline loads seeded media and the viewer opens', async ({ page }) => {
  await page.goto('/')

  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toBeVisible()
  const firstAsset = page.getByRole('button', { name: '打开 morning-garden.jpg' })
  await expect(firstAsset).toBeVisible()
  await firstAsset.click()

  const viewer = page.getByRole('dialog', { name: '查看 morning-garden.jpg' })
  await expect(viewer).toBeVisible()
  await expect(viewer.getByRole('heading', { name: 'morning-garden.jpg' })).toBeVisible()
  await viewer.getByRole('button', { name: '关闭' }).click()
  await expect(viewer).toBeHidden()
})

test('viewer fits horizontal and vertical images inside the existing canvas', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'fit geometry only needs one browser project')
  await page.setViewportSize({ width: 1280, height: 900 })
  await page.goto('/')

  for (const name of ['morning-garden.jpg', 'friends-at-dusk.jpg']) {
    await page.getByRole('button', { name: `打开 ${name}` }).click()
    const viewer = page.getByRole('dialog', { name: `查看 ${name}` })
    const image = viewer.locator('.viewer-stage > img')
    await expect(image).toBeVisible()
    await expect.poll(async () => image.evaluate((node) => Boolean(node.style.width && node.style.height))).toBe(true)

    const geometry = await viewer.evaluate((node) => {
      const stageNode = node.querySelector<HTMLElement>('.viewer-stage')
      const imageNode = node.querySelector<HTMLImageElement>('.viewer-stage > img')
      if (!stageNode || !imageNode) return null
      const stageStyle = getComputedStyle(stageNode)
      const stage = stageNode.getBoundingClientRect()
      const image = imageNode.getBoundingClientRect()
      const content = {
        left: stage.left + parseFloat(stageStyle.paddingLeft),
        right: stage.right - parseFloat(stageStyle.paddingRight),
        top: stage.top + parseFloat(stageStyle.paddingTop),
        bottom: stage.bottom - parseFloat(stageStyle.paddingBottom),
      }
      return { content, image, naturalWidth: imageNode.naturalWidth, naturalHeight: imageNode.naturalHeight }
    })
    expect(geometry).not.toBeNull()
    expect(geometry!.image.left).toBeGreaterThanOrEqual(geometry!.content.left - 1)
    expect(geometry!.image.top).toBeGreaterThanOrEqual(geometry!.content.top - 1)
    expect(geometry!.image.right).toBeLessThanOrEqual(geometry!.content.right + 1)
    expect(geometry!.image.bottom).toBeLessThanOrEqual(geometry!.content.bottom + 1)
    const naturalRatio = geometry!.naturalWidth / geometry!.naturalHeight
    const renderedRatio = geometry!.image.width / geometry!.image.height
    expect(Math.abs(renderedRatio - naturalRatio)).toBeLessThan(0.02)
    await viewer.getByRole('button', { name: '关闭' }).click()
  }
})

test('album can be created and deleted without touching media', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'album mutation only needs one browser project')
  await page.goto('/albums')
  const albumName = `回归相册-${Date.now()}`
  await page.getByLabel('新相册名称').fill(albumName)
  await page.getByRole('button', { name: '创建' }).click()
  await expect(page.getByRole('heading', { name: albumName })).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: `删除相册 ${albumName}` }).click()
  await expect(page.getByRole('heading', { name: albumName })).toBeHidden()
  await page.goto('/')
  await expect(page.getByRole('button', { name: '打开 morning-garden.jpg' })).toBeVisible()
})

test('album detail supports adding, cover selection, and removing without touching originals', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'album detail mutation only needs one browser project')
  const albumName = `详情回归-${Date.now()}`
  const created = await request.post('/api/albums', { data: { name: albumName } })
  expect(created.status()).toBe(201)
  const album = (await created.json() as { album: { id: string } }).album
  expect((await request.patch(`/api/albums/${album.id}`, { data: { assetId: 'seed-1' } })).ok()).toBeTruthy()

  await page.goto(`/albums/${album.id}`)
  await expect(page.getByRole('heading', { name: albumName })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开 morning-garden.jpg' })).toBeVisible()

  await page.getByRole('button', { name: '加入照片' }).click()
  const picker = page.getByRole('dialog', { name: `加入 ${albumName}` })
  await expect(picker).toBeVisible()
  await picker.getByRole('button', { name: /friends-at-dusk\.jpg/ }).click()
  await picker.getByRole('button', { name: '加入相册' }).click()
  await expect(picker).toBeHidden()
  await expect(page.getByRole('button', { name: '打开 friends-at-dusk.jpg' })).toBeVisible()

  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: '选择 friends-at-dusk.jpg' }).click()
  await page.getByRole('button', { name: '设为封面' }).click()
  await expect.poll(async () => {
    const response = await request.get(`/api/albums/${album.id}`)
    return (await response.json() as { album: { cover_asset_id: string | null } }).album.cover_asset_id
  }).toBe('seed-2')

  await page.getByRole('button', { name: '选择', exact: true }).click()
  await page.getByRole('button', { name: '选择 friends-at-dusk.jpg' }).click()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '移出相册' }).click()
  await expect(page.getByRole('button', { name: '打开 friends-at-dusk.jpg' })).toBeHidden()
  const mediaStillExists = await request.get('/api/assets/seed-2')
  expect(mediaStillExists.ok()).toBeTruthy()
})

test('timeline selection can bulk-trash items without deleting Telegram storage', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'bulk selection only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const prefix = `bulk-trash-${suffix}`
  const names = [`${prefix}-a.pdf`, `${prefix}-b.pdf`]

  for (const name of names) {
    const bytes = Buffer.from(`bulk trash ${name}`)
    const reserve = await request.post('/api/assets/reserve', {
      data: { originalName: name, mimeType: 'application/pdf', sizeBytes: bytes.byteLength, mediaType: 'file', storageBackend: 'telegram_bot' },
    })
    expect(reserve.status()).toBe(201)
    const reservation = await reserve.json() as { assetId: string; uploadToken: string }
    const content = await request.put(`/api/assets/${reservation.assetId}/content`, {
      data: bytes,
      headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.byteLength), 'X-Upload-Token': reservation.uploadToken },
    })
    expect(content.status()).toBe(201)
  }

  await page.goto(`/?q=${encodeURIComponent(prefix)}`)
  for (const name of names) await expect(page.getByRole('button', { name: `打开 ${name}` })).toBeVisible()
  await page.getByRole('button', { name: '选择', exact: true }).click()
  for (const name of names) await page.getByRole('button', { name: `选择 ${name}` }).click()
  await expect(page.getByText('已选 2 项')).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await page.getByRole('button', { name: '删除选中' }).click()
  for (const name of names) await expect(page.getByRole('button', { name: `打开 ${name}` })).toBeHidden()

  const listed = await request.get(`/api/assets?q=${encodeURIComponent(prefix)}`)
  expect(listed.ok()).toBeTruthy()
  expect((await listed.json() as { items: unknown[] }).items).toHaveLength(0)
})

test('timeline month index is loaded on demand and can jump without paging through the archive', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '时间定位' }).click()
  const picker = page.getByRole('dialog', { name: '按月份跳转' })
  await expect(picker).toBeVisible()
  const now = new Date()
  const monthLabel = `${now.getMonth() + 1}月`
  await picker.getByRole('button', { name: new RegExp(`^${monthLabel}`) }).first().click()
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
  await expect(page).toHaveURL(new RegExp(`month=${month}`))
  await expect(page.getByRole('heading', { name: `月度 · ${month.replace('-', ' · ')}` })).toBeVisible()
  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toBeHidden()
})

test('mobile timeline imports photos directly from the native picker without opening the upload sheet when Bot storage is selected', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'photo-library shortcut is a mobile interaction')
  const preference = await request.put('/api/storage-preference', { data: { defaultStorageBackend: 'telegram_bot' } })
  expect(preference.ok()).toBeTruthy()
  await page.addInitScript(() => {
    Object.defineProperty(window, 'createImageBitmap', { value: undefined, configurable: true })
  })
  await page.goto('/')
  const importButton = page.getByRole('button', { name: '导入手机相册' })
  await expect(importButton).toBeVisible()

  const onePixelPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
  const suffix = `${Date.now()}`
  const firstName = `phone-library-${suffix}-a.png`
  const secondName = `phone-library-${suffix}-b.png`
  const chooserPromise = page.waitForEvent('filechooser')
  await importButton.click()
  const chooser = await chooserPromise
  await chooser.setFiles([
    { name: firstName, mimeType: 'image/png', buffer: onePixelPng },
    { name: secondName, mimeType: 'image/png', buffer: onePixelPng },
  ])

  await expect(page.getByRole('dialog', { name: '加入私人档案' })).toBeHidden()
  await expect(page.getByRole('status').filter({ hasText: /本机已保存 2 项|已加入 2 项|正在接收/ }).first()).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: `打开 ${firstName}` })).toBeVisible({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: `打开 ${secondName}` })).toBeVisible({ timeout: 15_000 })
})

test('custom discover module can be created and assigned from the viewer', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'module management only needs one browser project')
  const moduleName = `聚会-${Date.now()}`

  await page.goto('/discover')
  await page.getByLabel('新建模块').fill(moduleName)
  await page.getByRole('button', { name: '添加模块' }).click()
  await expect(page.getByRole('button', { name: new RegExp(moduleName) })).toBeVisible()

  await page.goto('/')
  await page.getByRole('button', { name: '打开 morning-garden.jpg' }).click()
  const viewer = page.getByRole('dialog', { name: '查看 morning-garden.jpg' })
  await viewer.getByLabel('所属模块').selectOption({ label: moduleName })
  await expect(viewer.getByText('手动归类优先，AI 不会覆盖。')).toBeVisible()
  await viewer.getByRole('button', { name: '关闭' }).click()

  await page.goto('/discover')
  await page.getByRole('button', { name: new RegExp(moduleName) }).click()
  await expect(page.getByRole('button', { name: '打开 morning-garden.jpg' })).toBeVisible()
})

test('discover category opens a strict category-filtered timeline', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'category navigation only needs one browser project')
  await page.goto('/discover')
  const peopleCard = page.locator('button.category-card').filter({ has: page.locator('h2', { hasText: /^人物$/ }) })
  await peopleCard.click()
  await expect(page).toHaveURL(/category=people/)
  await expect(page.getByRole('button', { name: '打开 friends-at-dusk.jpg' })).toBeVisible()
  await expect(page.getByRole('button', { name: '打开 morning-garden.jpg' })).toBeHidden()
})

test('upload sheet is reachable on desktop and mobile', async ({ page }) => {
  await page.goto('/')
  const width = page.viewportSize()?.width ?? 1280
  const uploadButton = width < 768
    ? page.getByRole('button', { name: '上传媒体' })
    : page.getByRole('button', { name: '加入档案' })

  await uploadButton.click()
  const sheet = page.getByRole('dialog', { name: '加入私人档案' })
  await expect(sheet).toBeVisible()
  await expect(sheet.getByText('≤20 MB', { exact: true })).toBeVisible()
  await sheet.getByRole('button', { name: '关闭' }).click()
  await expect(sheet).toBeHidden()
})

test('Telegram discovery reads chats captured by the active webhook', async ({ request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Telegram discovery only needs one browser project')
  const updateId = Date.now() * 10 + Math.floor(Math.random() * 10)
  const webhook = await request.post('/api/telegram/webhook', {
    data: {
      update_id: updateId,
      message: {
        message_id: 98_765,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 10001, type: 'private', username: 'archive-owner', first_name: 'Owner' },
        from: { id: 10001, is_bot: false },
        text: '/start',
      },
    },
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(webhook.status()).toBe(200)

  const discovery = await request.get('/api/telegram/discover')
  expect(discovery.status()).toBe(200)
  const body = await discovery.json() as { chats: Array<{ id: string; type: string; username: string | null; firstName: string | null }> }
  expect(body.chats).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: '10001', type: 'private', username: 'archive-owner', firstName: 'Owner' }),
  ]))
})

test('timeline auto-syncs a Telegram item without manual refresh', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'background sync only needs one browser project')
  await page.goto('/')
  await expect(page.getByRole('heading', { name: /时间留下的\s*形状/ })).toBeVisible()

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const messageId = 200_000 + Math.floor(Math.random() * 700_000)
  const telegramName = `telegram-live-${suffix}.pdf`
  const webhook = await request.post('/api/telegram/webhook', {
    data: {
      update_id: Date.now() + Math.floor(Math.random() * 1000),
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: 10001, type: 'private' },
        from: { id: 10001, is_bot: false, first_name: 'Owner' },
        document: {
          file_id: `live-file-${suffix}`,
          file_unique_id: `live-unique-${suffix}`,
          file_name: telegramName,
          mime_type: 'application/pdf',
          file_size: 2048,
        },
      },
    },
    headers: { 'X-Telegram-Bot-Api-Secret-Token': 'local-webhook-secret' },
  })
  expect(webhook.status()).toBe(201)

  await expect(page.getByRole('button', { name: `打开 ${telegramName}` })).toBeVisible({ timeout: 12_000 })
})

test('viewer can soft-delete a web asset without deleting Telegram storage', async ({ page, request }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'destructive UI flow only needs one browser project')
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 100_000)}`
  const name = `trash-me-${suffix}.pdf`
  const bytes = Buffer.from('private archive soft delete smoke test')
  const reserve = await request.post('/api/assets/reserve', {
    data: { originalName: name, mimeType: 'application/pdf', sizeBytes: bytes.byteLength, mediaType: 'file', storageBackend: 'telegram_bot' },
  })
  expect(reserve.status()).toBe(201)
  const reservation = await reserve.json() as { assetId: string; uploadToken: string }
  const content = await request.put(`/api/assets/${reservation.assetId}/content`, {
    data: bytes,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Length': String(bytes.byteLength),
      'X-Upload-Token': reservation.uploadToken,
    },
  })
  expect(content.status()).toBe(201)

  await page.goto(`/?q=${encodeURIComponent(name)}`)
  const open = page.getByRole('button', { name: `打开 ${name}` })
  await expect(open).toBeVisible()
  await open.click()
  const viewer = page.getByRole('dialog', { name: `查看 ${name}` })
  await expect(viewer).toBeVisible()
  page.once('dialog', (dialog) => void dialog.accept())
  await viewer.getByRole('button', { name: '移入回收站' }).click()
  await expect(viewer).toBeHidden()
  await expect(open).toBeHidden()
})
