import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const statePath = resolve(process.argv[2] || '.wrangler/e2e-state')
const maxAttempts = 12

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  try {
    rmSync(statePath, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 })
    process.exit(0)
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined
    const transient = code === 'EPERM' || code === 'EBUSY'
    if (!transient || attempt === maxAttempts) throw error

    const delayMs = Math.min(1_500, 150 * attempt)
    console.warn(`[e2e:prepare] state directory is still releasing (${code}); retrying (${attempt}/${maxAttempts}) after ${delayMs}ms.`)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
  }
}
