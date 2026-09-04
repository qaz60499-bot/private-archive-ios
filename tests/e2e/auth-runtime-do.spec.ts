import { expect, request as playwrightRequest, test } from '@playwright/test'

const ownerPassword = 'OwnerPass!2026'
const rotatedOwnerPassword = 'OwnerPass!2026-Rotated'

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

test('Durable Object auth runtime enforces login and revocation with D1 session fallback', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'auth runtime contract only needs one browser project')

  const initial = await page.request.get('/api/auth/status')
  expect(initial.status()).toBe(200)
  await expect(initial.json()).resolves.toMatchObject({ initialized: false, authenticated: false, user: null })

  const staleSessionApi = await newApi('definitely-stale-session-token')
  const staleStatus = await staleSessionApi.get('/api/auth/status')
  expect(staleStatus.status()).toBe(200)
  await expect(staleStatus.json()).resolves.toMatchObject({ initialized: false, authenticated: false, user: null })
  expect(staleStatus.headers()['set-cookie']).toContain('pa_account=')
  expect(staleStatus.headers()['set-cookie']).toContain('Max-Age=0')
  await staleSessionApi.dispose()

  const bootstrap = await page.request.post('/api/auth/bootstrap', {
    data: { username: 'Owner', displayName: 'Joye Owner', password: ownerPassword },
  })
  expect(bootstrap.status()).toBe(201)
  const bootstrapBody = await bootstrap.json() as { user: { id: string } }
  const ownerId = bootstrapBody.user.id
  const bootstrapToken = sessionToken(bootstrap.headers()['set-cookie'])
  await expect((await page.request.get('/api/auth/me')).json()).resolves.toMatchObject({
    user: { username: 'Owner', role: 'OWNER', status: 'ACTIVE' },
  })

  const logout = await page.request.post('/api/auth/logout', { data: {} })
  expect(logout.status()).toBe(200)
  const revokedBootstrap = await newApi(bootstrapToken)
  expect((await revokedBootstrap.get('/api/auth/me')).status()).toBe(401)
  await revokedBootstrap.dispose()

  const loginApi = await newApi(undefined, '203.0.113.40')
  expect((await loginApi.post('/api/auth/login', {
    data: { username: 'Owner', password: 'WrongPass!2026' },
  })).status()).toBe(401)

  const login = await loginApi.post('/api/auth/login', {
    data: { username: 'Owner', password: ownerPassword },
  })
  expect(login.status()).toBe(200)
  const loginToken = sessionToken(login.headers()['set-cookie'])
  await expect((await loginApi.get('/api/auth/me')).json()).resolves.toMatchObject({
    user: { username: 'Owner', role: 'OWNER', status: 'ACTIVE' },
  })

  expect((await loginApi.post('/api/auth/logout', { data: {} })).status()).toBe(200)
  const revokedLogin = await newApi(loginToken)
  expect((await revokedLogin.get('/api/auth/me')).status()).toBe(401)
  await revokedLogin.dispose()

  const relogin = await loginApi.post('/api/auth/login', {
    data: { username: 'Owner', password: ownerPassword },
  })
  expect(relogin.status()).toBe(200)
  const preRotationToken = sessionToken(relogin.headers()['set-cookie'])
  const rotatePassword = await loginApi.patch(`/api/auth/users/${ownerId}`, {
    data: { password: rotatedOwnerPassword },
  })
  expect(rotatePassword.status()).toBe(200)

  const staleAfterRotation = await newApi(preRotationToken, '203.0.113.43')
  expect((await staleAfterRotation.get('/api/auth/me')).status()).toBe(401)
  await staleAfterRotation.dispose()
  expect((await loginApi.post('/api/auth/login', {
    data: { username: 'Owner', password: ownerPassword },
  })).status()).toBe(401)
  expect((await loginApi.post('/api/auth/login', {
    data: { username: 'Owner', password: rotatedOwnerPassword },
  })).status()).toBe(200)
  await loginApi.dispose()

  const limitedApi = await newApi(undefined, '203.0.113.41')
  for (let index = 0; index < 8; index += 1) {
    expect((await limitedApi.post('/api/auth/login', {
      data: { username: 'Owner', password: 'WrongPass!2026' },
    })).status()).toBe(401)
  }
  const limited = await limitedApi.post('/api/auth/login', {
    data: { username: 'Owner', password: 'WrongPass!2026' },
  })
  expect(limited.status()).toBe(429)
  expect(limited.headers()['retry-after']).toBe('900')
  await limitedApi.dispose()

  const independentIp = await newApi(undefined, '203.0.113.42')
  expect((await independentIp.post('/api/auth/login', {
    data: { username: 'Owner', password: rotatedOwnerPassword },
  })).status()).toBe(200)
  await independentIp.dispose()
})
