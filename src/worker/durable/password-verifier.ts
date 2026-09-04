import { DurableObject } from 'cloudflare:workers'
import type { Env } from '../env'
import { verifyAppPassword } from '../lib/app-auth'

type SessionRecord = {
  userId: string
  expiresAt: number
  // Password hash is used only as an opaque auth-version marker. Storing it beside
  // the session lets password changes invalidate Durable Object sessions without
  // requiring a separate best-effort cleanup RPC that could race or fail.
  authVersion?: string
}

type RevokedRecord = {
  expiresAt: number
}

const MAX_FAILURE_TIMESTAMPS = 32

function failureStorageKey(key: string): string {
  return `auth-fail:${key}`
}

function recentFailureValues(values: number[] | undefined, windowMinutes: number, now: number): number[] {
  if (!Array.isArray(values)) return []
  const cutoff = now - Math.max(1, windowMinutes) * 60 * 1000
  return values
    .filter((value) => Number.isFinite(value) && value >= cutoff)
    .slice(-MAX_FAILURE_TIMESTAMPS)
}

export class PasswordVerifier extends DurableObject<Env> {
  async verify(password: string, encodedHash: string): Promise<boolean> {
    return verifyAppPassword(password, encodedHash)
  }

  // Expiration is enforced lazily by recentFailures/resolveSession/isLegacyRevoked.
  // A global scan on every auth request would add unnecessary storage work.
  async prune(): Promise<void> {}

  async recentFailures(key: string, windowMinutes = 15): Promise<number> {
    const storageKey = failureStorageKey(key)
    const values = await this.ctx.storage.get<number[]>(storageKey)
    return recentFailureValues(values, windowMinutes, Date.now()).length
  }

  async recordAttempt(ip: string, username: string, success: boolean): Promise<void> {
    if (success) return
    const now = Date.now()
    const ipKey = failureStorageKey(ip)
    const accountKey = failureStorageKey(`account:${username.trim().toLowerCase()}`)
    const [ipValues, accountValues] = await Promise.all([
      this.ctx.storage.get<number[]>(ipKey),
      this.ctx.storage.get<number[]>(accountKey),
    ])
    const nextIp = [...recentFailureValues(ipValues, 15, now), now].slice(-MAX_FAILURE_TIMESTAMPS)
    const nextAccount = [...recentFailureValues(accountValues, 15, now), now].slice(-MAX_FAILURE_TIMESTAMPS)
    await this.ctx.storage.put({ [ipKey]: nextIp, [accountKey]: nextAccount })
  }

  async clearFailures(ip: string, username: string): Promise<void> {
    await this.ctx.storage.delete([
      failureStorageKey(ip),
      failureStorageKey(`account:${username.trim().toLowerCase()}`),
    ])
  }

  async createSession(tokenHash: string, userId: string, ttlSeconds: number, authVersion: string): Promise<string> {
    const now = Date.now()
    const expiresAt = now + Math.max(1, ttlSeconds) * 1000
    await this.ctx.storage.put(`auth-session:${tokenHash}`, { userId, expiresAt, authVersion } satisfies SessionRecord)
    return new Date(expiresAt).toISOString()
  }

  async resolveSession(tokenHash: string): Promise<{ userId: string; authVersion?: string } | null> {
    const key = `auth-session:${tokenHash}`
    const record = await this.ctx.storage.get<SessionRecord>(key)
    if (!record) return null
    if (record.expiresAt <= Date.now()) {
      await this.ctx.storage.delete(key)
      return null
    }
    return { userId: record.userId, authVersion: record.authVersion }
  }

  async deleteSession(tokenHash: string): Promise<void> {
    await this.ctx.storage.delete(`auth-session:${tokenHash}`)
  }

  async revokeLegacySession(tokenHash: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000
    await this.ctx.storage.put(`auth-revoked:${tokenHash}`, { expiresAt } satisfies RevokedRecord)
  }

  async revokeSession(tokenHash: string, ttlSeconds: number): Promise<void> {
    const expiresAt = Date.now() + Math.max(1, ttlSeconds) * 1000
    await this.ctx.storage.transaction(async (txn) => {
      await txn.delete(`auth-session:${tokenHash}`)
      await txn.put(`auth-revoked:${tokenHash}`, { expiresAt } satisfies RevokedRecord)
    })
  }

  async isLegacyRevoked(tokenHash: string): Promise<boolean> {
    const key = `auth-revoked:${tokenHash}`
    const record = await this.ctx.storage.get<RevokedRecord>(key)
    if (!record) return false
    if (record.expiresAt > Date.now()) return true
    await this.ctx.storage.delete(key)
    return false
  }
}
