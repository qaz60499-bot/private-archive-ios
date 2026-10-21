import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  uploads: new Map<string, any>(),
  payloads: new Map<string, any>(),
  listeners: new Map<string, (event: any) => void>(),
  native: {
    setPrincipal: vi.fn(), adoptLegacyJobs: vi.fn(), listJobs: vi.fn(), addListener: vi.fn(),
    pauseJob: vi.fn(), resumeJob: vi.fn(), cancelJob: vi.fn(), removeJob: vi.fn(),
  },
  blockedGet: undefined as undefined | { id: string; entered: () => void; wait: Promise<void> },
}))

vi.mock('idb', () => ({ openDB: async () => ({
  get: async (store: string, id: string) => {
    const values = store === 'uploads' ? mocks.uploads : mocks.payloads
    const value = values.get(id)
    const blocked = mocks.blockedGet
    if (store === 'uploads' && blocked?.id === id) {
      mocks.blockedGet = undefined
      blocked.entered()
      await blocked.wait
    }
    return value
  },
  put: async (store: string, value: any) => (store === 'uploads' ? mocks.uploads : mocks.payloads).set(value.id ?? value.key, value),
  delete: async (store: string, id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).delete(id),
  getAllFromIndex: async (store: string, index: string, key?: string) => {
    const jobs = [...mocks.uploads.values()]
    return store !== 'uploads' || index !== 'by-batch' ? jobs : jobs.filter((job) => job.batchId === key)
  },
  transaction: (store: string) => ({
    store: {
      get: async (id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).get(id),
      put: async (value: any) => (store === 'uploads' ? mocks.uploads : mocks.payloads).set(value.id ?? value.key, value),
      delete: async (id: string) => (store === 'uploads' ? mocks.uploads : mocks.payloads).delete(id),
    },
    done: Promise.resolve(),
  }),
}) }))

vi.mock('@capacitor/core', () => ({
  Capacitor: { isPluginAvailable: () => true },
  registerPlugin: () => mocks.native,
}))
vi.mock('../../src/web/lib/native-platform', () => ({ isNativeApp: () => true, nativePlatform: () => 'ios' }))

import { initializeIosBackgroundUploadSync } from '../../src/web/lib/native-background-upload'
import { NativeBackgroundUpload, type NativeBackgroundUploadJob } from '../../src/web/lib/native-background-upload-plugin'
import { pauseLocalUpload, resumeLocalUpload } from '../../src/web/lib/offline/processor'
import { registerNativeLocalUploadMirror, setLocalUploadPrincipal } from '../../src/web/lib/offline/store'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const nativeJob = {
  id: 'native-ordering', principalId: 'account-a', batchId: 'batch-a', fileName: 'a.jpg', mimeType: 'image/jpeg',
  sizeBytes: 8, mediaType: 'photo' as const, status: 'waiting' as const, stage: 'reserving' as const, progress: 10,
  attempts: 0, createdAt: '2026-10-20T00:00:00.000Z', updatedAt: '2026-10-20T00:00:00.000Z',
}

async function seedNativeJob(status: 'waiting' | 'paused' = 'waiting'): Promise<void> {
  await registerNativeLocalUploadMirror({
    ...nativeJob,
    status,
    stage: status === 'paused' ? 'original' : 'reserving',
    progress: status === 'paused' ? 32 : 10,
    createdAt: nativeJob.createdAt,
    updatedAt: nativeJob.updatedAt,
  })
}

function emitNativeJob(job: NativeBackgroundUploadJob): void {
  mocks.listeners.get('stateChanged')?.({ job })
}

beforeEach(async () => {
  setLocalUploadPrincipal(null)
  mocks.uploads.clear()
  mocks.payloads.clear()
  mocks.blockedGet = undefined
  vi.clearAllMocks()
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'iPhone', maxTouchPoints: 1 })
  vi.stubGlobal('dispatchEvent', vi.fn())
  setLocalUploadPrincipal('account-a')
  mocks.native.setPrincipal.mockResolvedValue(undefined)
  mocks.native.listJobs.mockResolvedValue({ items: [], quarantinedCount: 0 })
  mocks.native.pauseJob.mockResolvedValue(undefined)
  mocks.native.resumeJob.mockResolvedValue(undefined)
  mocks.native.addListener.mockImplementation(async (name: string, handler: (event: any) => void) => {
    mocks.listeners.set(name, handler)
    return { remove: async () => undefined }
  })
  await initializeIosBackgroundUploadSync()
})

describe('native upload mirror ordering', () => {
  it('keeps a validated completion after a delayed 32% mirror read', async () => {
    await seedNativeJob()
    mocks.payloads.set('native-ordering:original', { key: 'native-ordering:original', bytes: new Uint8Array([1]).buffer, mimeType: 'image/jpeg' })

    const entered = deferred<void>()
    const release = deferred<void>()
    mocks.blockedGet = { id: nativeJob.id, entered: () => entered.resolve(), wait: release.promise }
    emitNativeJob({ ...nativeJob, progress: 32, stage: 'original' })
    await entered.promise

    emitNativeJob({ ...nativeJob, status: 'done', stage: 'completed', progress: 100, remoteAssetId: 'asset-a' })
    // Let the later callback progress while the older callback's IndexedDB read is held.
    await new Promise((resolve) => setTimeout(resolve, 0))
    release.resolve()

    await vi.waitFor(() => expect(mocks.uploads.get(nativeJob.id).status).toBe('done'))
    expect(mocks.uploads.get(nativeJob.id).progress).toBe(100)
    expect(mocks.uploads.get(nativeJob.id).remoteAssetId).toBe('asset-a')
    expect(mocks.payloads.has(`${nativeJob.id}:original`)).toBe(false)

    // A delayed old callback that arrives after completion must also leave the terminal row intact.
    emitNativeJob({ ...nativeJob, progress: 32, stage: 'original' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(mocks.uploads.get(nativeJob.id).status).toBe('done')
    expect(mocks.uploads.get(nativeJob.id).progress).toBe(100)
  })
})

describe('native upload controls after completion', () => {
  it.each(['pause', 'resume'] as const)('does not let a late %s acknowledgement replace native done', async (control) => {
    await seedNativeJob(control === 'resume' ? 'paused' : 'waiting')
    const acknowledgement = deferred<void>()
    if (control === 'pause') vi.mocked(NativeBackgroundUpload.pauseJob).mockReturnValueOnce(acknowledgement.promise)
    else vi.mocked(NativeBackgroundUpload.resumeJob).mockReturnValueOnce(acknowledgement.promise)

    const action = control === 'pause' ? pauseLocalUpload(nativeJob.id) : resumeLocalUpload(nativeJob.id)
    await vi.waitFor(() => expect(control === 'pause' ? NativeBackgroundUpload.pauseJob : NativeBackgroundUpload.resumeJob).toHaveBeenCalledOnce())

    emitNativeJob({ ...nativeJob, status: 'done', stage: 'completed', progress: 100, remoteAssetId: 'asset-a' })
    await vi.waitFor(() => expect(mocks.uploads.get(nativeJob.id).status).toBe('done'))
    acknowledgement.resolve()
    await action

    expect(mocks.uploads.get(nativeJob.id).status).toBe('done')
    expect(mocks.uploads.get(nativeJob.id).progress).toBe(100)
    expect(mocks.uploads.get(nativeJob.id).remoteAssetId).toBe('asset-a')
  })
})

describe('native upload controls preserve the latest intent', () => {
  it('does not let an older pause acknowledgement replace a newer resume and uploading snapshot', async () => {
    await seedNativeJob()
    const pauseAcknowledgement = deferred<void>()
    vi.mocked(NativeBackgroundUpload.pauseJob).mockReturnValueOnce(pauseAcknowledgement.promise)

    const pause = pauseLocalUpload(nativeJob.id)
    await vi.waitFor(() => expect(NativeBackgroundUpload.pauseJob).toHaveBeenCalledOnce())

    await resumeLocalUpload(nativeJob.id)
    // Swift emits `uploading`; IndexedDB normalizes that state to `retrying` for the Web UI.
    emitNativeJob({ ...nativeJob, status: 'uploading', stage: 'original', progress: 60 } as unknown as NativeBackgroundUploadJob)
    await vi.waitFor(() => expect(mocks.uploads.get(nativeJob.id).progress).toBe(60))

    pauseAcknowledgement.resolve()
    await pause

    expect(mocks.uploads.get(nativeJob.id).status).toBe('retrying')
    expect(mocks.uploads.get(nativeJob.id).controlState).toBe('active')
    expect(mocks.uploads.get(nativeJob.id).progress).toBe(60)
  })
})
