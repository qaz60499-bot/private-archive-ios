import { describe, expect, it } from 'vitest'
import { deriveRecoveryPasswordHash, passwordRecoveryErrorMessage } from '../../src/web/lib/password-recovery'
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

  it('rejects passwords above the worker 256-character maximum', async () => {
    await expect(deriveRecoveryPasswordHash('a'.repeat(257))).rejects.toThrow('PASSWORD_INVALID')
  })

  it('explains when account recovery must run through the Cloudflare Access page', () => {
    expect(passwordRecoveryErrorMessage(new Error('APP_RECOVERY_NOT_ALLOWED'))).toContain('Cloudflare Access 保护的网页')
    expect(passwordRecoveryErrorMessage(new Error('PASSWORD_INVALID'))).toBe('密码长度必须为 9–256 个字符。')
    expect(passwordRecoveryErrorMessage(new Error('APP_PASSWORD_RECOVERY_FAILED'))).toContain('密码重置暂时未确认完成')
  })
})
