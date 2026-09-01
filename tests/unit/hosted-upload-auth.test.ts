import { beforeEach, describe, expect, it, vi } from 'vitest'

const owner = {
  id: 'owner-id', workspace_id: 'personal', username: 'owner', display_name: 'Owner', password_hash: 'hash',
  role: 'OWNER' as const, status: 'ACTIVE' as const, last_login_at: null, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z',
}

const mocks = vi.hoisted(() => ({
  getActiveAppOwner: vi.fn(),
  resolveAppSession: vi.fn(),
}))

vi.mock('../../src/worker/db/app-users-repository', () => ({
  getActiveAppOwner: mocks.getActiveAppOwner,
  resolveAppSession: mocks.resolveAppSession,
}))

import { isDesktopMutationOriginAllowed, isHostedUploadApiRequestAllowed, resolveRequestAppUser } from '../../src/worker/lib/security'

function context(input: { url: string; email?: string; cookie?: string; desktopHost?: string }) {
  const headers = new Map<string, string>()
  if (input.email) headers.set('cf-access-authenticated-user-email', input.email)
  if (input.cookie) headers.set('cookie', input.cookie)
  return {
    req: {
      url: input.url,
      header(name: string) { return headers.get(name.toLowerCase()) },
    },
    env: {
      DB: {},
      MOCK_TELEGRAM: 'false',
      OWNER_EMAIL: 'owner@example.com',
      DESKTOP_API_HOST: input.desktopHost ?? 'api.photo.example.com',
      SHARE_ORIGIN: 'https://photo.example.com/shared?app=shared',
      E2E_APP_AUTH_MODE: 'strict',
    },
  } as never
}

describe('desktop and iOS mutation origin boundary', () => {
  it('keeps desktop loopback allowed and arbitrary browser origins denied', () => {
    expect(isDesktopMutationOriginAllowed('http://127.0.0.1:8798', undefined)).toBe(true)
    expect(isDesktopMutationOriginAllowed('https://evil.example.com', undefined)).toBe(false)
    expect(isDesktopMutationOriginAllowed(undefined, undefined)).toBe(false)
  })

  it('allows only the Capacitor iOS origin or native no-Origin path when the iOS client marker is present', () => {
    expect(isDesktopMutationOriginAllowed('capacitor://localhost', 'ios')).toBe(true)
    expect(isDesktopMutationOriginAllowed(undefined, 'ios')).toBe(true)
    expect(isDesktopMutationOriginAllowed('https://evil.example.com', 'ios')).toBe(false)
    expect(isDesktopMutationOriginAllowed('capacitor://evil.example.com', 'ios')).toBe(false)
    expect(isDesktopMutationOriginAllowed('capacitor://localhost', 'android')).toBe(false)
  })
})

describe('hosted upload API capability boundary', () => {
  it('allows only the upload portal API family plus token-scoped share APIs', () => {
    expect(isHostedUploadApiRequestAllowed('GET', '/api/health')).toBe(true)
    expect(isHostedUploadApiRequestAllowed('GET', '/api/storage-preference')).toBe(true)
    expect(isHostedUploadApiRequestAllowed('POST', '/api/assets/reserve')).toBe(true)
    expect(isHostedUploadApiRequestAllowed('PUT', '/api/assets/asset-1/content')).toBe(true)
    expect(isHostedUploadApiRequestAllowed('POST', '/api/assets/asset-1/preview')).toBe(true)
    expect(isHostedUploadApiRequestAllowed('POST', '/api/share/exchange')).toBe(true)

    expect(isHostedUploadApiRequestAllowed('GET', '/api/assets')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('GET', '/api/assets/asset-1/media')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('DELETE', '/api/assets/asset-1')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('PUT', '/api/storage-preference')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('GET', '/api/settings/status')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('POST', '/api/telegram/sources')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('GET', '/api/auth/users')).toBe(false)
    expect(isHostedUploadApiRequestAllowed('POST', '/api/access/shares')).toBe(false)
  })
})

describe('hosted owner upload identity', () => {
  beforeEach(() => {
    mocks.getActiveAppOwner.mockReset()
    mocks.resolveAppSession.mockReset()
    mocks.getActiveAppOwner.mockResolvedValue(owner)
    mocks.resolveAppSession.mockResolvedValue(null)
  })

  it('maps the hosted upload domain to the existing D1 owner without relying on the supplemental Access email header', async () => {
    await expect(resolveRequestAppUser(context({
      url: 'https://photo.example.com/api/auth/status',
    }))).resolves.toEqual(owner)
    expect(mocks.getActiveAppOwner).toHaveBeenCalledTimes(1)
  })

  it('does not bypass app auth for the desktop API host', async () => {
    await expect(resolveRequestAppUser(context({
      url: 'https://api.photo.example.com/api/auth/status',
      email: 'owner@example.com',
    }))).resolves.toBeNull()
    expect(mocks.getActiveAppOwner).not.toHaveBeenCalled()
  })
})
