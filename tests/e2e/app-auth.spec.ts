import { createHash } from 'node:crypto'
import { expect, request as playwrightRequest, test } from '@playwright/test'

const ownerPassword = 'OwnerPass!2026'
const memberPassword = 'MemberPass!2026'

function sessionToken(setCookie: string | undefined): string {
  const match = setCookie?.match(/(?:^|;\s*)pa_account=([^;]+)/)
  if (!match?.[1]) throw new Error('pa_account cookie missing')
  return decodeURIComponent(match[1])
}

async function newApi(cookie?: string, ip?: string) {
  const headers: Record<string, string> = {}
  if (cookie) headers.Cookie = `pa_account=${encodeURIComponent(cookie)}`
  if (ip) headers['X-Forwarded-For'] = ip
  return playwrightRequest.newContext({ baseURL: 'http://127.0.0.1:8799', extraHTTPHeaders: headers })
}

test('strict app-account auth covers bootstrap, sessions, roles, switching, disable and rate limiting', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'strict application-account contract only needs one browser project')

  const initial = await page.request.get('/api/auth/status')
  expect(initial.ok()).toBeTruthy()
  await expect(initial.json()).resolves.toMatchObject({ initialized: false, authenticated: false, user: null })

  const invalidBootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'ow', displayName: 'Owner', password: 'short' },
  })
  expect(invalidBootstrap.status()).toBe(400)

  const bootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'Owner', displayName: 'Joye Owner', password: ownerPassword },
  })
  expect(bootstrap.status()).toBe(201)
  const bootstrapBody = await bootstrap.json() as { user: { id: string; username: string; role: string } }
  expect(bootstrapBody.user).toMatchObject({ username: 'Owner', role: 'OWNER' })
  const ownerId = bootstrapBody.user.id
  const bootstrapCookie = bootstrap.headers()['set-cookie']
  expect(bootstrapCookie).toContain('HttpOnly')
  expect(bootstrapCookie).toContain('SameSite=Lax')
  expect(bootstrapCookie).toContain('Max-Age=34560000')
  expect(bootstrapCookie).not.toContain('Secure') // local HTTP; production HTTPS adds Secure.
  const firstOwnerToken = sessionToken(bootstrapCookie)

  const statusAfterBootstrap = await page.request.get('/api/auth/status')
  expect(statusAfterBootstrap.headers()['set-cookie']).toContain('Max-Age=34560000')
  expect(sessionToken(statusAfterBootstrap.headers()['set-cookie'])).toBe(firstOwnerToken)
  await expect(statusAfterBootstrap.json()).resolves.toMatchObject({
    initialized: true,
    authenticated: true,
    user: { id: ownerId, username: 'Owner', role: 'OWNER', status: 'ACTIVE' },
  })
  const me = await page.request.get('/api/auth/me')
  expect(me.ok()).toBeTruthy()
  await expect(me.json()).resolves.toMatchObject({ user: { id: ownerId, role: 'OWNER' } })

  const duplicateBootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'AnotherOwner', displayName: 'Another Owner', password: ownerPassword },
  })
  expect(duplicateBootstrap.status()).toBe(409)
  await expect(duplicateBootstrap.json()).resolves.toMatchObject({ error: 'APP_ALREADY_INITIALIZED' })

  const badOwnerLogin = await newApi(undefined, '203.0.113.10')
  expect((await badOwnerLogin.post('/api/auth/login', { data: { username: 'Owner', password: 'WrongPass!2026' } })).status()).toBe(401)
  expect((await badOwnerLogin.post('/api/auth/login', { data: { username: 'ghost-user', password: 'WrongPass!2026' } })).status()).toBe(401)
  await badOwnerLogin.dispose()

  const createdMembers: Array<{ id: string; username: string }> = []
  for (let index = 0; index < 12; index += 1) {
    const username = `member-${String(index).padStart(2, '0')}`
    const response = await page.request.post('/api/auth/users', {
      data: { username, displayName: `Member ${index}`, password: memberPassword, ...(index === 0 ? { accessPreset: 'FULL' } : {}) },
    })
    expect(response.status()).toBe(201)
    const body = await response.json() as { user: { id: string; username: string; role: string; accessPreset: string } }
    expect(body.user.role).toBe('MEMBER')
    expect(body.user.accessPreset).toBe(index === 0 ? 'FULL' : 'VIEWER')
    createdMembers.push({ id: body.user.id, username: body.user.username })
  }

  const duplicateCase = await page.request.post('/api/auth/users', {
    data: { username: 'MEMBER-00', displayName: 'Duplicate', password: memberPassword },
  })
  expect(duplicateCase.status()).toBe(409)
  expect((await page.request.post('/api/auth/users', { data: { username: 'ab', displayName: 'Bad', password: memberPassword } })).status()).toBe(400)
  expect((await page.request.post('/api/auth/users', { data: { username: 'valid-user', displayName: '', password: memberPassword } })).status()).toBe(400)
  expect((await page.request.post('/api/auth/users', { data: { username: 'valid-user', displayName: 'Valid', password: 'short123' } })).status()).toBe(400)

  const selfDisable = await page.request.patch(`/api/auth/users/${ownerId}`, { data: { status: 'DISABLED' } })
  expect(selfDisable.status()).toBe(409)
  await expect(selfDisable.json()).resolves.toMatchObject({ error: 'OWNER_CANNOT_BE_DISABLED' })

  const memberApi = await newApi(undefined, '203.0.113.20')
  const memberLogin = await memberApi.post('/api/auth/login', {
    data: { username: createdMembers[0].username, password: memberPassword },
  })
  expect(memberLogin.ok()).toBeTruthy()
  const memberToken = sessionToken(memberLogin.headers()['set-cookie'])
  await expect((await memberApi.get('/api/auth/me')).json()).resolves.toMatchObject({
    user: { id: createdMembers[0].id, role: 'MEMBER', status: 'ACTIVE' },
  })

  for (const path of ['/api/assets?limit=5', '/api/albums', '/api/timeline/months']) {
    const response = await memberApi.get(path)
    expect(response.ok(), `MEMBER should access ${path}`).toBeTruthy()
  }
  const payload = Buffer.from('member-upload-permission-check')
  const reserve = await memberApi.post('/api/assets/reserve', {
    data: {
      originalName: 'member-upload-check.pdf',
      mimeType: 'application/pdf',
      sizeBytes: payload.byteLength,
      mediaType: 'file',
      storageBackend: 'telegram_bot',
      contentHash: createHash('sha256').update(payload).digest('hex'),
    },
  })
  expect(reserve.status()).toBe(201)

  const scopedAssets: string[] = []
  for (const label of ['visible', 'hidden']) {
    const bytes = Buffer.from(`owner-scoped-${label}`)
    const response = await page.request.post('/api/assets/reserve', {
      data: {
        originalName: `${label}.jpg`, mimeType: 'image/jpeg', sizeBytes: bytes.byteLength, mediaType: 'photo',
        contentHash: createHash('sha256').update(bytes).digest('hex'), storageBackend: 'telegram_bot',
      },
    })
    expect(response.status()).toBe(201)
    const reservation = await response.json() as { assetId: string; uploadToken: string }
    const content = await page.request.put(`/api/assets/${reservation.assetId}/content`, {
      data: bytes,
      headers: {
        'Content-Type': 'image/jpeg',
        'Content-Length': String(bytes.byteLength),
        'X-Upload-Token': reservation.uploadToken,
      },
    })
    const contentStatus = content.status()
    const contentBody = await content.json().catch(() => ({}))
    expect(contentStatus, JSON.stringify(contentBody)).toBe(201)
    scopedAssets.push(reservation.assetId)
  }

  const scopedMember = createdMembers[1]
  const scopedGrant = await page.request.put(`/api/auth/users/${scopedMember.id}/access`, {
    data: { grants: [{ scopeType: 'asset', scopeId: scopedAssets[0], permission: 'read' }] },
  })
  expect(scopedGrant.ok()).toBeTruthy()
  await expect(scopedGrant.json()).resolves.toMatchObject({ user: { accessPreset: 'SCOPED' } })

  const scopedApi = await newApi(undefined, '203.0.113.22')
  expect((await scopedApi.post('/api/auth/login', { data: { username: scopedMember.username, password: memberPassword } })).ok()).toBeTruthy()
  const scopedList = await scopedApi.get('/api/assets?limit=60')
  expect(scopedList.ok()).toBeTruthy()
  const scopedListBody = await scopedList.json() as { items: Array<{ id: string }> }
  expect(scopedListBody.items.map((item) => item.id)).toContain(scopedAssets[0])
  expect(scopedListBody.items.map((item) => item.id)).not.toContain(scopedAssets[1])
  expect((await scopedApi.get(`/api/assets/${scopedAssets[0]}`)).status()).toBe(200)
  expect((await scopedApi.get(`/api/assets/${scopedAssets[1]}`)).status()).toBe(404)
  expect((await scopedApi.patch(`/api/assets/${scopedAssets[0]}`, { data: { favorite: true } })).status()).toBe(403)
  expect((await scopedApi.post('/api/assets/reserve', {
    data: { originalName: 'not-allowed.jpg', mimeType: 'image/jpeg', sizeBytes: 3, mediaType: 'photo', contentHash: createHash('sha256').update('new').digest('hex') },
  })).status()).toBe(403)

  const downloadGrant = await page.request.put(`/api/auth/users/${scopedMember.id}/access`, {
    data: { grants: [
      { scopeType: 'asset', scopeId: scopedAssets[0], permission: 'read' },
      { scopeType: 'workspace', scopeId: 'personal', permission: 'download' },
    ] },
  })
  expect(downloadGrant.ok()).toBeTruthy()
  expect((await scopedApi.get(`/api/assets/${scopedAssets[1]}/media`)).status()).toBe(403)
  expect((await scopedApi.get(`/api/assets/${scopedAssets[0]}/media`)).status()).toBe(200)
  await scopedApi.dispose()

  for (const path of ['/api/auth/users', '/api/telegram/sources', '/api/access/shares', '/api/recovery/integrity']) {
    const response = await memberApi.get(path)
    expect(response.status(), `MEMBER must be denied ${path}`).toBe(403)
    await expect(response.json()).resolves.toMatchObject({ error: 'APP_OWNER_REQUIRED' })
  }

  await page.goto('/?app=personal-desktop')
  await expect(page.getByRole('button', { name: '当前账号 Joye Owner' })).toBeVisible()
  await page.getByRole('button', { name: '当前账号 Joye Owner' }).click()
  await page.getByRole('menuitem', { name: '切换账号' }).click()
  await expect(page.getByRole('heading', { name: '登录私人档案' })).toBeVisible()

  const deadOwnerSession = await newApi(firstOwnerToken)
  expect((await deadOwnerSession.get('/api/auth/me')).status()).toBe(401)
  await deadOwnerSession.dispose()

  await page.getByLabel('用户名').fill(createdMembers[0].username)
  await page.getByLabel('密码').fill(memberPassword)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('button', { name: '当前账号 Member 0' })).toBeVisible()
  await page.getByRole('button', { name: '当前账号 Member 0' }).click()
  await page.getByRole('menuitem', { name: '切换账号' }).click()
  await expect(page.getByRole('heading', { name: '登录私人档案' })).toBeVisible()
  await page.getByRole('button', { name: /Joye Owner/ }).click()
  await page.getByLabel('密码').fill(ownerPassword)
  await page.getByRole('button', { name: '登录' }).click()
  await expect(page.getByRole('button', { name: '当前账号 Joye Owner' })).toBeVisible()

  const ownerLoginAfterSwitch = await page.request.get('/api/auth/me')
  expect(ownerLoginAfterSwitch.ok()).toBeTruthy()
  await expect(ownerLoginAfterSwitch.json()).resolves.toMatchObject({ user: { id: ownerId, role: 'OWNER' } })

  const disableMember = await page.request.patch(`/api/auth/users/${createdMembers[0].id}`, { data: { status: 'DISABLED' } })
  expect(disableMember.ok()).toBeTruthy()
  const staleMember = await newApi(memberToken)
  expect((await staleMember.get('/api/auth/me')).status()).toBe(401)
  expect((await staleMember.post('/api/auth/login', { data: { username: createdMembers[0].username, password: memberPassword } })).status()).toBe(401)
  await staleMember.dispose()

  const enableMember = await page.request.patch(`/api/auth/users/${createdMembers[0].id}`, { data: { status: 'ACTIVE' } })
  expect(enableMember.ok()).toBeTruthy()
  const enabledMember = await newApi(undefined, '203.0.113.21')
  expect((await enabledMember.post('/api/auth/login', { data: { username: createdMembers[0].username, password: memberPassword } })).ok()).toBeTruthy()
  await enabledMember.dispose()

  const clearingIp = '203.0.113.30'
  const clearingApi = await newApi(undefined, clearingIp)
  for (let index = 0; index < 3; index += 1) {
    expect((await clearingApi.post('/api/auth/login', { data: { username: 'Owner', password: 'WrongPass!2026' } })).status()).toBe(401)
  }
  expect((await clearingApi.post('/api/auth/login', { data: { username: 'Owner', password: ownerPassword } })).ok()).toBeTruthy()
  await clearingApi.post('/api/auth/logout', { data: {} })
  for (let index = 0; index < 8; index += 1) {
    expect((await clearingApi.post('/api/auth/login', { data: { username: 'Owner', password: 'WrongPass!2026' } })).status()).toBe(401)
  }
  const limited = await clearingApi.post('/api/auth/login', { data: { username: 'Owner', password: 'WrongPass!2026' } })
  expect(limited.status()).toBe(429)
  expect(limited.headers()['retry-after']).toBe('900')
  await clearingApi.dispose()

  const unaffectedIp = await newApi(undefined, '203.0.113.31')
  expect((await unaffectedIp.post('/api/auth/login', { data: { username: 'Owner', password: ownerPassword } })).ok()).toBeTruthy()
  await unaffectedIp.dispose()

  const simplePassword = 'simple123'
  const resetAll = await page.request.post('/api/auth/users/reset-passwords', { data: { password: simplePassword } })
  expect(resetAll.status()).toBe(200)
  await expect(resetAll.json()).resolves.toMatchObject({ ok: true, count: 13 })
  expect((await page.request.get('/api/auth/me')).status()).toBe(401)
  expect((await memberApi.get('/api/auth/me')).status()).toBe(401)

  const resetOwner = await newApi(undefined, '203.0.113.32')
  expect((await resetOwner.post('/api/auth/login', { data: { username: 'Owner', password: ownerPassword } })).status()).toBe(401)
  expect((await resetOwner.post('/api/auth/login', { data: { username: 'Owner', password: simplePassword } })).status()).toBe(200)
  await resetOwner.dispose()

  const resetMember = await newApi(undefined, '203.0.113.33')
  expect((await resetMember.post('/api/auth/login', { data: { username: createdMembers[1].username, password: memberPassword } })).status()).toBe(401)
  expect((await resetMember.post('/api/auth/login', { data: { username: createdMembers[1].username, password: simplePassword } })).status()).toBe(200)
  await resetMember.dispose()

  await memberApi.dispose()
})
