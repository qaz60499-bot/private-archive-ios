import { describe, expect, it } from 'vitest'
import { deriveRecoveryPasswordHash } from '../../src/web/lib/password-recovery'
import { verifyAppPassword } from '../../src/worker/lib/app-auth'

describe('browser password recovery hashing', () => {
  it('derives the production PBKDF2 format locally without changing verification semantics', async () => {
    const password = 'simple123'
    const encoded = await deriveRecoveryPasswordHash(password)
    expect(encoded).toMatch(/^pbkdf2-sha256\$600000\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/)
    await expect(verifyAppPassword(password, encoded)).resolves.toBe(true)
    await expect(verifyAppPassword('wrong-pass', encoded)).resolves.toBe(false)
  })

  it('rejects passwords shorter than the shared nine-character minimum', async () => {
    await expect(deriveRecoveryPasswordHash('12345678')).rejects.toThrow('PASSWORD_INVALID')
  })
})
