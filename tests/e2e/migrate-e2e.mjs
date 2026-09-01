import { spawnSync } from 'node:child_process'
const stateDir = process.argv[2] || '.wrangler/e2e-state'

const wranglerArgs = [
  '-y', '-p', 'wrangler@4.127.1', 'wrangler',
  'd1', 'migrations', 'apply', 'private-archive-db',
  '--config', 'wrangler.e2e-db.toml',
  '--local',
  '--persist-to', stateDir,
]

const wranglerCommand = process.platform === 'win32' ? 'cmd.exe' : 'npx'
const args = process.platform === 'win32'
  ? ['/D', '/S', '/C', `npx -y -p wrangler@4.127.1 wrangler d1 migrations apply private-archive-db --config wrangler.e2e-db.toml --local --persist-to ${stateDir}`]
  : wranglerArgs

const maxAttempts = 8

for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
  const result = spawnSync(wranglerCommand, args, {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
  })

  if (result.stdout) process.stdout.write(result.stdout)
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) console.error(result.error)

  if (result.status === 0) process.exit(0)

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const transientBadPort = /\bbad\s+port\b/i.test(output)
  if (!transientBadPort || attempt === maxAttempts) {
    process.exit(result.status ?? 1)
  }

  // Wrangler/Miniflare on Windows can briefly retain an ephemeral local port while
  // the previous fresh E2E runtime is shutting down. Retrying the same local D1
  // migration is safe because Wrangler records each completed migration before
  // continuing. Use a capped exponential backoff so a transient port handoff does
  // not abort the whole split suite, while persistent failures still fail closed.
  const delayMs = Math.min(3_000, 400 * (2 ** (attempt - 1)))
  console.warn(`[e2e:migrate] Wrangler local D1 hit a transient blocked ephemeral port; retrying (${attempt}/${maxAttempts}) after ${delayMs}ms.`)
  await new Promise((resolvePromise) => setTimeout(resolvePromise, delayMs))
}

process.exit(1)
