import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppAccount, LocalUploadJob } from '../../src/web/types'

const mocks = vi.hoisted(() => ({
  uploads: new Map<string, any>(), payloads: new Map<string, any>(),
  reserve: vi.fn(), uploadContent: vi.fn(), commitUserGroupUpload: vi.fn(), bridgeUpload: vi.fn(),
  prepareMedia: vi.fn(), sha256File: vi.fn(),
  native: { setPrincipal: vi.fn(), adoptLegacyJobs: vi.fn(), listJobs: vi.fn(), addListener: vi.fn(), resumeJob: vi.fn(), removeJob: vi.fn() },
  listeners: new Map<string, (event: any) => void>(),
}))

vi.mock('idb', () => ({ openDB: async () => ({
  get: async (store: string, id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).get(id),
  put: async (store: string, value: any) => (store === 'uploads' ? mocks.uploads : mocks.payloads).set(value.id ?? value.key, value),
  delete: async (store: string, id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).delete(id),
  getAllFromIndex: async (_store: string, index: string, key?: string) => [...mocks.uploads.values()].filter((job) => index !== 'by-batch' || job.batchId === key),
  transaction: (store: string) => ({
    store: {
      get: async (id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).get(id),
      put: async (value: any) => (store === 'uploads' ? mocks.uploads : mocks.payloads).set(value.id ?? value.key, value),
      delete: async (id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).delete(id),
    }, done: Promise.resolve(),
  }),
}) }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true }, registerPlugin: () => mocks.native,
}))
vi.mock('../../src/web/lib/native-platform', () => ({ isNativeApp: () => true, nativePlatform: () => 'ios' }))
vi.mock('../../src/web/lib/api', () => ({
  ApiError: class extends Error { constructor(public status: number, public code: string) { super(code) } },
  api: { reserve: mocks.reserve, uploadContent: mocks.uploadContent, commitUserGroupUpload: mocks.commitUserGroupUpload },
}))
vi.mock('../../src/web/lib/telegram-user-group', () => ({ telegramUserGroupBridge: { upload: mocks.bridgeUpload } }))
vi.mock('../../src/web/lib/preview/media-metadata', () => ({ prepareMedia: mocks.prepareMedia }))
vi.mock('../../src/web/lib/file-hash', () => ({ sha256File: mocks.sha256File }))

import {
  enqueueLocalUpload, getLocalUploadFile, listLocalUploads, registerNativeLocalUploadMirror,
  getLocalUploadPrincipal, setLocalUploadPrincipal, updateLocalUpload,
} from '../../src/web/lib/offline/store'
import { processLocalUpload, wakeUploadScheduler } from '../../src/web/lib/offline/processor'
import { getNativeUploadAuthenticationPending, getQuarantinedNativeUploadCount, initializeIosBackgroundUploadSync, syncIosBackgroundUploads } from '../../src/web/lib/native-background-upload'
import { importFiles } from '../../src/web/lib/import-files'
import { activateUploadPrincipal } from '../../src/web/context/AuthContext'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function readyJob(backend: 'telegram_bot' | 'telegram_user_group' = 'telegram_bot'): Promise<LocalUploadJob> {
  const job = await enqueueLocalUpload({ file: new File(['original'], 'a.jpg', { type: 'image/jpeg' }), batchId: 'batch-a', mediaType: 'photo', storageBackend: backend })
  return (await updateLocalUpload(job.id, { prepareStatus: 'ready', contentHash: 'hash-a', metadata: { contentHash: 'hash-a' } }))!
}

beforeEach(() => {
  setLocalUploadPrincipal(null)
  mocks.uploads.clear(); mocks.payloads.clear()
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'iPhone', maxTouchPoints: 1 })
  vi.stubGlobal('dispatchEvent', vi.fn())
  setLocalUploadPrincipal('account-a')
  mocks.native.listJobs.mockResolvedValue({ items: [], quarantinedCount: 0 })
  mocks.native.setPrincipal.mockReset().mockResolvedValue(undefined)
  mocks.native.addListener.mockImplementation(async (name: string, handler: (event: any) => void) => {
    mocks.listeners.set(name, handler)
    return { remove: async () => undefined }
  })
})

describe('upload account changes with delayed transport', () => {
  it.each([false, true])('does not upload A bytes after switching to B (switch back=%s)', async (switchBack) => {
    const job = await readyJob()
    const pending = deferred<any>()
    mocks.reserve.mockReturnValueOnce(pending.promise)
    const result = processLocalUpload(job)
    await vi.waitFor(() => expect(mocks.reserve).toHaveBeenCalledOnce())
    const signal = mocks.reserve.mock.calls[0][1] as AbortSignal
    setLocalUploadPrincipal('account-b')
    if (switchBack) setLocalUploadPrincipal('account-a')
    expect(signal.aborted).toBe(true)
    pending.resolve({ assetId: 'asset-a', uploadToken: 'token-a', duplicate: false })
    expect(await result).toBe(false)
    expect(mocks.uploadContent).not.toHaveBeenCalled()
    expect(mocks.payloads.has(`${job.id}:original`)).toBe(true)
    expect(mocks.uploads.get(job.id).principalId).toBe('account-a')
    expect(mocks.uploads.get(job.id).status).not.toBe('done')
    setLocalUploadPrincipal('account-a')
    expect(await (await getLocalUploadFile(job))?.text()).toBe('original')
  })

  it('does not commit a delayed Telegram receipt with B credentials', async () => {
    const job = await readyJob('telegram_user_group')
    mocks.reserve.mockResolvedValueOnce({ assetId: 'asset-a', uploadToken: 'token-a', duplicate: false })
    const pending = deferred<any>()
    mocks.bridgeUpload.mockReturnValueOnce(pending.promise)
    const result = processLocalUpload(job)
    await vi.waitFor(() => expect(mocks.bridgeUpload).toHaveBeenCalledOnce())
    setLocalUploadPrincipal('account-b')
    pending.resolve({ chatId: 'chat-a', messageId: 1, sizeBytes: 8 })
    expect(await result).toBe(false)
    expect(mocks.commitUserGroupUpload).not.toHaveBeenCalled()
    expect(mocks.payloads.has(`${job.id}:original`)).toBe(true)
  })

  it('keeps the selecting account when persistence spans a switch', async () => {
    const pending = enqueueLocalUpload({ file: new File(['retained'], 'a.jpg'), batchId: 'batch-a', mediaType: 'photo' })
    setLocalUploadPrincipal('account-b')
    const job = await pending
    expect(job.principalId).toBe('account-a')
    expect(await listLocalUploads()).toEqual([])
    setLocalUploadPrincipal('account-a')
    expect(await (await getLocalUploadFile(job))?.text()).toBe('retained')
  })

  it('keeps all later files of a selected batch under A after a switch', async () => {
    const result = await importFiles(Array.from({ length: 10 }, (_, index) => new File([`original-${index}`], `${index}.jpg`)), false, {
      mobile: true, storageBackend: 'telegram_user_group',
      onProgress: ({ processed }) => { if (processed === 1) setLocalUploadPrincipal('account-b') },
    })
    expect(result.queued).toBe(10)
    expect(result.errors).toEqual([])
    expect([...mocks.uploads.values()].every((job) => job.principalId === 'account-a')).toBe(true)
    expect(await listLocalUploads()).toEqual([])
    expect(mocks.payloads.size).toBe(10)
  })

  it('returns interrupted metadata preparation to pending without losing A payload', async () => {
    const job = await enqueueLocalUpload({ file: new File(['original'], 'a.jpg'), batchId: 'batch-a', mediaType: 'photo' })
    const pending = deferred<any>()
    mocks.prepareMedia.mockReturnValueOnce(pending.promise)
    mocks.sha256File.mockResolvedValueOnce('hash-a')
    await wakeUploadScheduler('test')
    await vi.waitFor(() => expect(mocks.prepareMedia).toHaveBeenCalledOnce())
    setLocalUploadPrincipal('account-b')
    pending.resolve({ metadata: {}, preview: undefined })
    await vi.waitFor(() => expect(mocks.uploads.get(job.id).prepareStatus).toBe('pending'))
    expect(mocks.uploads.get(job.id).principalId).toBe('account-a')
    expect(mocks.payloads.has(`${job.id}:original`)).toBe(true)
    expect(mocks.reserve).not.toHaveBeenCalled()
  })
})

describe('native mirror and upgrade isolation', () => {
  const nativeJob = {
    id: 'native-a', principalId: 'account-a', batchId: 'native-batch', fileName: 'private-a.jpg', mimeType: 'image/jpeg',
    sizeBytes: 8, mediaType: 'photo' as const, status: 'waiting' as const, stage: 'reserving' as const, progress: 15, attempts: 0,
    createdAt: '2026-10-20T00:00:00Z', updatedAt: '2026-10-20T00:00:00Z',
  }

  it('keeps successful Web authentication usable while native validation times out and retries on recovery', async () => {
    const validation = deferred<void>()
    mocks.native.setPrincipal.mockReturnValueOnce(validation.promise.then(() => { throw new Error('REQUEST_TIMEOUT') }))
    const account = { id: 'account-a', role: 'OWNER' } as AppAccount
    await activateUploadPrincipal(account)
    expect(getLocalUploadPrincipal()).toBe('account-a')
    expect(getNativeUploadAuthenticationPending()).toBe(true)
    expect(mocks.native.setPrincipal).toHaveBeenCalledOnce()
    expect(mocks.native.listJobs).not.toHaveBeenCalled()
    validation.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getLocalUploadPrincipal()).toBe('account-a')
    expect(mocks.native.listJobs).not.toHaveBeenCalled()
    await syncIosBackgroundUploads()
    expect(mocks.native.setPrincipal).toHaveBeenCalledTimes(2)
    expect(mocks.native.listJobs).toHaveBeenCalledWith({ principalId: 'account-a' })
    expect(getNativeUploadAuthenticationPending()).toBe(false)
  })

  it('does not reconcile A when its native validation completes after logout and B activation', async () => {
    const validation = deferred<void>()
    mocks.native.setPrincipal.mockReturnValueOnce(validation.promise)
    await activateUploadPrincipal({ id: 'account-a', role: 'OWNER' } as AppAccount)
    await activateUploadPrincipal(null)
    await activateUploadPrincipal({ id: 'account-b', role: 'MEMBER' } as AppAccount)
    await syncIosBackgroundUploads()
    validation.resolve()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(getLocalUploadPrincipal()).toBe('account-b')
    expect(mocks.native.listJobs.mock.calls.every(([options]) => options.principalId === 'account-b')).toBe(true)
  })

  it('rejects foreign native callbacks and refuses to relabel a persisted foreign mirror', async () => {
    await registerNativeLocalUploadMirror(nativeJob)
    await initializeIosBackgroundUploadSync()
    setLocalUploadPrincipal('account-b')
    mocks.listeners.get('stateChanged')?.({ job: { ...nativeJob, status: 'done', progress: 100 } })
    await Promise.resolve()
    expect(await listLocalUploads()).toEqual([])
    expect(mocks.uploads.get(nativeJob.id).status).toBe('waiting')
    await expect(registerNativeLocalUploadMirror({ ...nativeJob, principalId: 'account-b' })).rejects.toThrow('UPLOAD_ACCOUNT_MISMATCH')
    expect(mocks.uploads.get(nativeJob.id).principalId).toBe('account-a')
  })

  it('migrates only mirrors with a persisted matching owner and leaves unknown originals quarantined', async () => {
    await registerNativeLocalUploadMirror(nativeJob)
    mocks.uploads.set('legacy-unknown', { ...mocks.uploads.get(nativeJob.id), id: 'legacy-unknown', principalId: undefined })
    setLocalUploadPrincipal('account-a', { adoptLegacy: true })
    mocks.native.listJobs.mockResolvedValue({ items: [nativeJob], quarantinedCount: 1 })
    await syncIosBackgroundUploads()
    expect(mocks.native.adoptLegacyJobs).toHaveBeenCalledWith({ principalId: 'account-a', ids: ['native-a'] })
    expect(mocks.uploads.get('legacy-unknown').principalId).toBeUndefined()
    expect(getQuarantinedNativeUploadCount()).toBe(1)
    expect(mocks.native.removeJob).not.toHaveBeenCalled()
    setLocalUploadPrincipal('account-b')
    mocks.native.listJobs.mockResolvedValue({ items: [nativeJob], quarantinedCount: 1 })
    await syncIosBackgroundUploads()
    expect(await listLocalUploads()).toEqual([])
    expect(mocks.uploads.get(nativeJob.id).principalId).toBe('account-a')
  })
})
