import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

rmSync(resolve('.wrangler/e2e-state'), { recursive: true, force: true })
