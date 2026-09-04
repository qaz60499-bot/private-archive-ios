// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../src/worker/lib/auth-runtime.ts', import.meta.url), 'utf8')

describe('application session resilience guard', () => {
  it('backs new Durable Object sessions with the existing D1 session store', () => {
    const createStart = source.indexOf('export async function createAppSessionRuntime')
    const resolveStart = source.indexOf('export async function resolveAppSessionRuntime')
    const block = source.slice(createStart, resolveStart)

    expect(block).toContain('runtime.createSession')
    expect(block.match(/createD1AppSession\(env\.DB, userId, rawToken\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(block).toContain('D1 auth session backup unavailable')
  })

  it('falls back to the mirrored D1 session when Durable Object lookups are unavailable', () => {
    const resolveStart = source.indexOf('export async function resolveAppSessionRuntime')
    const deleteStart = source.indexOf('export async function deleteAppSessionRuntime')
    const block = source.slice(resolveStart, deleteStart)

    expect(block).toContain('Durable auth session lookup unavailable; falling back to D1')
    expect(block).toContain('Durable auth revocation lookup unavailable; falling back to D1')
    expect(block.match(/return resolveD1AppSession\(env\.DB, rawToken\)/g)?.length).toBeGreaterThanOrEqual(3)
    expect(block.indexOf('runtime.isLegacyRevoked(tokenHash)')).toBeGreaterThan(-1)
  })

  it('deletes the mirrored D1 session on logout while keeping an independent DO revocation guard', () => {
    const deleteStart = source.indexOf('export async function deleteAppSessionRuntime')
    const block = source.slice(deleteStart)
    const runtimeBranch = block.slice(block.indexOf('const tokenHash = await hashAppSessionToken(rawToken)'))
    expect(runtimeBranch.indexOf('runtime.revokeLegacySession(tokenHash')).toBeGreaterThan(-1)
    expect(runtimeBranch.indexOf('deleteD1AppSession(env.DB, rawToken)')).toBeGreaterThan(runtimeBranch.indexOf('runtime.revokeLegacySession(tokenHash'))
    expect(runtimeBranch).toContain('if (!runtimeRevoked && !d1Deleted)')
  })
})
