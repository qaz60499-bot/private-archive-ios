import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Env } from '../../src/worker/env'

const routeMocks = vi.hoisted(() => {
  const deleteMessage = vi.fn(async () => true)
  const storageAdapter = {
    storeOriginal: vi.fn(),
    storePreview: vi.fn(),
    copyMessage: vi.fn(),
    deleteMessage,
    fetchFile: vi.fn(),
  }

  return {
    getAsset: vi.fn(async () => null),
    claimStorageObjectForPurge: vi.fn(async (): Promise<'claimed' | 'shared' | 'busy' | 'deleted' | 'missing'> => 'shared'),
    deleteLogicalAsset: vi.fn(async () => true),
    markStorageObjectDeleted: vi.fn(async () => true),
    markStorageObjectDeleteFailed: vi.fn(async () => undefined),
    markPurgeFailure: vi.fn(async () => undefined),
    logActivity: vi.fn(async () => undefined),
    refreshUsageSnapshot: vi.fn(async () => undefined),
    deleteMessage,
    storageAdapter,
    createStorageAdapterFromConfig: vi.fn(() => storageAdapter),
  }
})

vi.mock('../../src/worker/db/assets-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/db/assets-repository')>()
  return {
    ...actual,
    getAsset: routeMocks.getAsset,
    claimStorageObjectForPurge: routeMocks.claimStorageObjectForPurge,
    deleteLogicalAsset: routeMocks.deleteLogicalAsset,
    markStorageObjectDeleted: routeMocks.markStorageObjectDeleted,
    markStorageObjectDeleteFailed: routeMocks.markStorageObjectDeleteFailed,
    markPurgeFailure: routeMocks.markPurgeFailure,
  }
})

vi.mock('../../src/worker/lib/security', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/lib/security')>()
  const requireAccount: typeof actual.requireAccount = async (_context, next) => { await next() }
  const resolveRequestAppUser: typeof actual.resolveRequestAppUser = async () =>
    ({ role: 'OWNER' }) as Awaited<ReturnType<typeof actual.resolveRequestAppUser>>
  return { ...actual, requireAccount, resolveRequestAppUser }
})

vi.mock('../../src/worker/db/app-user-access-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/db/app-user-access-repository')>()
  return {
    ...actual,
    canAppUserAccessAsset: async () => true,
    canAppUserAccessAssets: async () => true,
    canAppUserAccessSource: async () => true,
  }
})

vi.mock('../../src/worker/db/activity-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/db/activity-repository')>()
  return { ...actual, logActivity: routeMocks.logActivity }
})

vi.mock('../../src/worker/db/usage-repository', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/db/usage-repository')>()
  return { ...actual, refreshUsageSnapshot: routeMocks.refreshUsageSnapshot }
})

vi.mock('../../src/worker/services/storage/factory', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/worker/services/storage/factory')>()
  const createStorageAdapterFromConfig: typeof actual.createStorageAdapterFromConfig = () =>
    routeMocks.storageAdapter as unknown as ReturnType<typeof actual.createStorageAdapterFromConfig>
  return { ...actual, createStorageAdapterFromConfig }
})

import { assetsRoutes } from '../../src/worker/routes/assets'

type Reference = { id: string; storageObjectId: string; status: 'ready' | 'trashed' }
type DeleteState = 'active' | 'deleting' | 'delete_failed' | 'deleted'

function createReferenceDb(initialAssets: Reference[]) {
  const assets = [...initialAssets]
  const storageObject = { id: 'storage-1', deleteState: 'active' as DeleteState }
  const statements: Array<{ sql: string; values: unknown[] }> = []

  const prepare = (sql: string) => {
    const statement = {
      sql,
      values: [] as unknown[],
      bind(...values: unknown[]) {
        this.values = values
        return this
      },
      async run() {
        statements.push({ sql, values: this.values })
        if (sql.includes("UPDATE storage_objects SET delete_state = 'deleting'")) {
          const [, id, , , referencedObjectId, excludedAssetId] = this.values
          const hasOtherReference = assets.some((asset) =>
            asset.storageObjectId === referencedObjectId && asset.id !== excludedAssetId,
          )
          const canClaim = storageObject.id === id
            && ['active', 'delete_failed'].includes(storageObject.deleteState)
            && !hasOtherReference
          if (canClaim) storageObject.deleteState = 'deleting'
          return { meta: { changes: canClaim ? 1 : 0 } }
        }
        if (sql.includes('DELETE FROM asset_search')) return { meta: { changes: 0 } }
        if (sql.includes("DELETE FROM assets WHERE id = ? AND workspace_id = ? AND status = 'trashed'")) {
          const [id] = this.values
          const index = assets.findIndex((asset) => asset.id === id && asset.status === 'trashed')
          if (index >= 0) assets.splice(index, 1)
          return { meta: { changes: index >= 0 ? 1 : 0 } }
        }
        throw new Error(`Unexpected write SQL: ${sql}`)
      },
      async first<T>() {
        statements.push({ sql, values: this.values })
        if (sql.includes('SELECT delete_state FROM storage_objects')) {
          return { delete_state: storageObject.deleteState } as T
        }
        if (sql.includes('SELECT COUNT(*) AS count FROM assets')) {
          const [, referencedObjectId, excludedAssetId] = this.values
          return {
            count: assets.filter((asset) =>
              asset.storageObjectId === referencedObjectId && asset.id !== excludedAssetId,
            ).length,
          } as T
        }
        throw new Error(`Unexpected read SQL: ${sql}`)
      },
    }
    return statement
  }

  return {
    db: { prepare } as unknown as D1Database,
    assets,
    storageObject,
    statements,
  }
}

beforeEach(() => {
  routeMocks.getAsset.mockResolvedValue(null)
  routeMocks.claimStorageObjectForPurge.mockResolvedValue('shared')
  routeMocks.deleteLogicalAsset.mockResolvedValue(true)
  routeMocks.markStorageObjectDeleted.mockResolvedValue(true)
  routeMocks.markStorageObjectDeleteFailed.mockResolvedValue(undefined)
  routeMocks.markPurgeFailure.mockResolvedValue(undefined)
  routeMocks.logActivity.mockResolvedValue(undefined)
  routeMocks.refreshUsageSnapshot.mockResolvedValue(undefined)
  routeMocks.deleteMessage.mockClear()
  routeMocks.createStorageAdapterFromConfig.mockClear()
})

describe('storage object purge reference guard', () => {
  it.each(['ready', 'trashed'] as const)(
    'deletes only the purged reference and preserves the object when another %s asset refers to it',
    async (siblingStatus) => {
      const actualRepository = await vi.importActual<typeof import('../../src/worker/db/assets-repository')>(
        '../../src/worker/db/assets-repository',
      )
      const mock = createReferenceDb([
        { id: 'purged', storageObjectId: 'storage-1', status: 'trashed' },
        { id: 'sibling', storageObjectId: 'storage-1', status: siblingStatus },
      ])

      const claim = await actualRepository.claimStorageObjectForPurge(mock.db, 'storage-1', 'purged')
      expect(claim).toBe('shared')
      const claimStatement = mock.statements.find(({ sql }) => sql.includes("UPDATE storage_objects SET delete_state = 'deleting'"))
      expect(claimStatement?.sql).toContain('NOT EXISTS (')
      expect(claimStatement?.sql).toContain('WHERE workspace_id = ? AND storage_object_id = ? AND id != ?')

      await actualRepository.deleteLogicalAsset(mock.db, 'purged')

      expect(mock.assets).toEqual([{ id: 'sibling', storageObjectId: 'storage-1', status: siblingStatus }])
      expect(mock.storageObject.deleteState).toBe('active')
    },
  )

  it('returns shared from the bot purge route without deleting the Telegram object', async () => {
    routeMocks.getAsset.mockResolvedValue({
      id: 'purged', status: 'trashed', storage_backend: 'telegram_bot', storage_object_id: 'storage-1',
      source_id: 'telegram-legacy', storage_message_id: 42, preview_message_id: null,
    } as never)

    const response = await assetsRoutes.request('/purged/purge', {
      method: 'DELETE',
    }, { DB: {} as D1Database, MOCK_TELEGRAM: 'true' } as Env, { waitUntil: vi.fn() } as unknown as ExecutionContext)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, telegramDeleted: false, sharedObjectPreserved: true })
    expect(routeMocks.deleteLogicalAsset).toHaveBeenCalledWith(expect.anything(), 'purged')
    expect(routeMocks.createStorageAdapterFromConfig).not.toHaveBeenCalled()
    expect(routeMocks.deleteMessage).not.toHaveBeenCalled()
    expect(routeMocks.markStorageObjectDeleted).not.toHaveBeenCalled()
  })

  it('deletes the Telegram message when the last reference claims the object for purge', async () => {
    routeMocks.getAsset.mockResolvedValue({
      id: 'last-reference', status: 'trashed', storage_backend: 'telegram_bot', storage_object_id: 'storage-1',
      source_id: 'telegram-legacy', storage_message_id: 42, preview_message_id: null,
    } as never)
    routeMocks.claimStorageObjectForPurge.mockResolvedValue('claimed')

    const response = await assetsRoutes.request('/last-reference/purge', {
      method: 'DELETE',
    }, { DB: {} as D1Database, MOCK_TELEGRAM: 'true' } as Env, { waitUntil: vi.fn() } as unknown as ExecutionContext)

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toMatchObject({ ok: true, telegramDeleted: true, sharedObjectPreserved: false })
    expect(routeMocks.deleteMessage).toHaveBeenCalledExactlyOnceWith(42)
    expect(routeMocks.markStorageObjectDeleted).toHaveBeenCalledWith(expect.anything(), 'storage-1')
    expect(routeMocks.deleteLogicalAsset).toHaveBeenCalledWith(expect.anything(), 'last-reference')
  })
})
