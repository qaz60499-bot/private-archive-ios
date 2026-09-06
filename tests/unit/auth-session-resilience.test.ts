// @ts-expect-error -- this regression test executes under Vitest's Node runtime; the app tsconfig intentionally omits Node globals.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../../src/worker/lib/auth-runtime.ts', import.meta.url), 'utf8')
const durableSource = readFileSync(new URL('../../src/worker/durable/password-verifier.ts', import.meta.url), 'utf8')
const authRouteSource = readFileSync(new URL('../../src/worker/routes/auth.ts', import.meta.url), 'utf8')

describe('application session resilience guard', () => {
  it('backs new Durable Object sessions with the existing D1 session store', () => {
    const createStart = source.indexOf('export async function createAppSessionRuntime')
    const resolveStart = source.indexOf('export async function resolveAppSessionRuntime')
    const block = source.slice(createStart, resolveStart)

    expect(block).toContain('runtime.createSession')
    expect(block.match(/createD1AppSession\(env\.DB, userId, rawToken\)/g)?.length).toBeGreaterThanOrEqual(2)
    expect(block).toContain('D1 auth session backup unavailable')
  })

  it('rolls a valid device session forward in both Durable Object and D1 stores', () => {
    const refreshStart = source.indexOf('export async function refreshAppSessionRuntime')
    const resolveStart = source.indexOf('export async function resolveAppSessionRuntime')
    const block = source.slice(refreshStart, resolveStart)
    expect(block).toContain('runtime.createSession(tokenHash, user.id, APP_SESSION_TTL_SECONDS, user.password_hash)')
    expect(block).toContain('refreshD1AppSession(env.DB, user.id, rawToken)')
    expect(block).toContain('Promise.allSettled')
    expect(block).toContain("throw new Error('APP_SESSION_REFRESH_UNAVAILABLE')")
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

  it('revokes the Durable Object session atomically and deletes the mirrored D1 session in parallel', () => {
    const deleteStart = source.indexOf('export async function deleteAppSessionRuntime')
    const block = source.slice(deleteStart)
    expect(block).toContain('Promise.allSettled')
    expect(block).toContain('runtime.revokeSession(tokenHash, APP_SESSION_TTL_SECONDS)')
    expect(block).toContain('deleteD1AppSession(env.DB, rawToken)')
    expect(block).toContain('if (!runtimeRevoked && !d1Deleted)')

    const revokeStart = durableSource.indexOf('async revokeSession(')
    const revokeEnd = durableSource.indexOf('async isLegacyRevoked(', revokeStart)
    const revokeBlock = durableSource.slice(revokeStart, revokeEnd)
    expect(revokeBlock).toContain('this.ctx.storage.transaction')
    expect(revokeBlock).toContain('txn.delete(`auth-session:${tokenHash}`)')
    expect(revokeBlock).toContain('txn.put(`auth-revoked:${tokenHash}`')
  })

  it('does not make a no-op Durable Object prune RPC on every auth request', () => {
    const pruneStart = source.indexOf('export async function pruneAuthRuntime')
    const recentStart = source.indexOf('export async function recentLoginFailuresRuntime')
    const block = source.slice(pruneStart, recentStart)
    expect(block).not.toContain('runtime.prune()')
    expect(block).toContain('if (authRuntime(env)) return')
  })

  it('keeps password verification on the request Worker instead of Durable Object RPC', () => {
    const verifyStart = authRouteSource.indexOf('async function verifyLoginPassword')
    const ownerStart = authRouteSource.indexOf('async function requireCurrentOwner', verifyStart)
    const block = authRouteSource.slice(verifyStart, ownerStart)
    expect(block).toContain('return verifyAppPassword(password, encodedHash)')
    expect(block).not.toContain('.verify(password, encodedHash)')
  })

  it('falls back to D1 when Durable Object throttle bookkeeping is unavailable', () => {
    const recentStart = source.indexOf('export async function recentLoginFailuresRuntime')
    const createStart = source.indexOf('export async function createAppSessionRuntime')
    const block = source.slice(recentStart, createStart)
    expect(block).toContain('Durable auth IP throttle lookup unavailable; falling back to D1')
    expect(block).toContain('Durable auth account throttle lookup unavailable; falling back to D1')
    expect(block).toContain('Durable auth failure recording unavailable; falling back to D1')
    expect(block).toContain('Durable auth failure cleanup unavailable; falling back to D1')
    expect(block).toContain('recentD1LoginFailures(env.DB, ip, windowMinutes)')
    expect(block).toContain('recentD1AccountLoginFailures(env.DB, username, windowMinutes)')
    expect(block).toContain('recordD1LoginAttempt(env.DB, ip, username, success)')
    expect(block).toContain('clearD1LoginFailures(env.DB, ip, username)')
  })
})
