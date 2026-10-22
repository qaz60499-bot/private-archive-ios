import { describe, expect, it, vi } from 'vitest'
import { PERSONAL_WORKSPACE_ID } from '../../src/worker/db/assets-repository'
import { resetAllAppUserPasswords } from '../../src/worker/db/app-users-repository'

type PasswordRow = { id: string; password_hash: string }

type MockStatement = {
  sql: string
  values: unknown[]
  bind: (...values: unknown[]) => MockStatement
  run: ReturnType<typeof vi.fn>
  all: ReturnType<typeof vi.fn>
}

function createMockD1(
  batchHandler: (statements: MockStatement[]) => Promise<unknown>,
  rows: PasswordRow[],
) {
  const statements: MockStatement[] = []
  const prepare = vi.fn((sql: string) => {
    const statement: MockStatement = {
      sql,
      values: [],
      bind(...values) {
        this.values = values
        return this
      },
      run: vi.fn(async () => ({ meta: { changes: 0 } })),
      all: vi.fn(async () => ({ results: rows })),
    }
    statements.push(statement)
    return statement
  })
  const batch = vi.fn(async (batchStatements: MockStatement[]) => batchHandler(batchStatements))
  const db = { prepare, batch } as unknown as D1Database
  return { db, batch, prepare, statements }
}

const updates = [
  { id: 'owner-1', passwordHash: 'hash-1' },
  { id: 'member-2', passwordHash: 'hash-2' },
]

describe('resetAllAppUserPasswords atomicity', () => {
  it('propagates a batch failure without replaying individual writes', async () => {
    const failure = new Error('D1 batch failed')
    const mock = createMockD1(async () => { throw failure }, [])

    await expect(resetAllAppUserPasswords(mock.db, updates)).rejects.toBe(failure)

    expect(mock.batch).toHaveBeenCalledTimes(1)
    expect(mock.statements).toHaveLength(3)
    for (const statement of mock.statements) expect(statement.run).not.toHaveBeenCalled()
    for (const statement of mock.statements) expect(statement.all).not.toHaveBeenCalled()
  })

  it('batches all password updates with session invalidation and verifies the resulting hashes', async () => {
    const mock = createMockD1(async () => [
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
      { meta: { changes: 2 } },
    ], [
      { id: 'owner-1', password_hash: 'hash-1' },
      { id: 'member-2', password_hash: 'hash-2' },
    ])

    await expect(resetAllAppUserPasswords(mock.db, updates)).resolves.toBe(2)

    expect(mock.batch).toHaveBeenCalledTimes(1)
    const batchStatements = mock.batch.mock.calls[0][0]
    expect(batchStatements).toHaveLength(3)
    expect(batchStatements[0].sql).toContain('UPDATE app_users')
    expect(batchStatements[0].values).toEqual(['hash-1', expect.any(String), 'owner-1', PERSONAL_WORKSPACE_ID])
    expect(batchStatements[1].sql).toContain('UPDATE app_users')
    expect(batchStatements[1].values).toEqual(['hash-2', expect.any(String), 'member-2', PERSONAL_WORKSPACE_ID])
    expect(batchStatements[2].sql).toContain('DELETE FROM app_sessions')
    expect(batchStatements[2].values).toEqual([PERSONAL_WORKSPACE_ID])

    const verification = mock.statements[3]
    expect(verification.sql).toContain('SELECT id, password_hash')
    expect(verification.all).toHaveBeenCalledTimes(1)
    for (const statement of mock.statements) expect(statement.run).not.toHaveBeenCalled()
  })

  it('rejects a missing update target without replaying writes', async () => {
    const mock = createMockD1(async () => [
      { meta: { changes: 1 } },
      { meta: { changes: 0 } },
      { meta: { changes: 1 } },
    ], [])

    await expect(resetAllAppUserPasswords(mock.db, updates)).rejects.toThrow('APP_PASSWORD_RESET_TARGET_MISSING')

    expect(mock.batch).toHaveBeenCalledTimes(1)
    expect(mock.prepare).toHaveBeenCalledTimes(3)
    for (const statement of mock.statements) expect(statement.run).not.toHaveBeenCalled()
  })

  it('rejects verification mismatches without replaying writes', async () => {
    const mock = createMockD1(async () => [
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
      { meta: { changes: 1 } },
    ], [
      { id: 'owner-1', password_hash: 'hash-1' },
      { id: 'member-2', password_hash: 'old-hash' },
    ])

    await expect(resetAllAppUserPasswords(mock.db, updates)).rejects.toThrow('APP_PASSWORD_RESET_VERIFY_FAILED')

    expect(mock.batch).toHaveBeenCalledTimes(1)
    expect(mock.statements[3].all).toHaveBeenCalledTimes(1)
    for (const statement of mock.statements) expect(statement.run).not.toHaveBeenCalled()
  })
})
