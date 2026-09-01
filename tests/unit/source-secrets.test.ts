import { describe, expect, it } from 'vitest'
import { decryptSourceSecret, encryptSourceSecret } from '../../src/worker/lib/source-secrets'

const TEST_MASTER_KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('telegram source secret encryption', () => {
  it('round-trips with AES-GCM and never stores plaintext', async () => {
    const plaintext = '123456789:very-sensitive-bot-token'
    const encrypted = await encryptSourceSecret(TEST_MASTER_KEY, plaintext, 'telegram-source:source-a:bot-token')
    expect(encrypted.ciphertext).not.toContain(plaintext)
    expect(encrypted.iv).toBeTruthy()
    await expect(decryptSourceSecret(TEST_MASTER_KEY, encrypted, 'telegram-source:source-a:bot-token')).resolves.toBe(plaintext)
  })

  it('uses a fresh IV for every encryption and binds ciphertext to source AAD', async () => {
    const first = await encryptSourceSecret(TEST_MASTER_KEY, 'same-token', 'telegram-source:source-a:bot-token')
    const second = await encryptSourceSecret(TEST_MASTER_KEY, 'same-token', 'telegram-source:source-a:bot-token')
    expect(first.iv).not.toBe(second.iv)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    await expect(decryptSourceSecret(TEST_MASTER_KEY, first, 'telegram-source:source-b:bot-token')).rejects.toThrow('SOURCE_SECRET_DECRYPT_FAILED')
  })
})
