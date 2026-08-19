import { describe, expect, it } from 'vitest'
import { verifyOwnerPassword } from '../../src/worker/lib/owner-auth'

describe('owner password verification', () => {
  it('verifies the generated PBKDF2 fixture', async () => {
    await expect(verifyOwnerPassword(
      'pH7_GgLFeoNPkXsPRuBM',
      'pbkdf2-sha256$210000$qgVkR8kFXOdTSDMLGFMJsg$DWM0qmD5gXNvge-dhe_UMwmJskgKWzlm0weYbnz8k6k',
    )).resolves.toBe(true)
  })
})
