import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

const testDir = 'tests/e2e'
const projectRoot = resolve(process.cwd())
const lockPath = resolve(projectRoot, '.wrangler', 'e2e-run.lock.json')
const runId = randomUUID()
let currentChild = null
let shuttingDown = false
let lockAcquired = false

const discoveredSpecs = readdirSync(testDir)
  .filter((name) => name.endsWith('.spec.ts'))
  .sort()
const requestedSpecs = process.argv.slice(2).map((value) => value.replaceAll('\\', '/').split('/').at(-1)).filter(Boolean)
const specs = requestedSpecs.length ? requestedSpecs : discoveredSpecs
for (const spec of specs) {
  if (!discoveredSpecs.includes(spec)) throw new Error(`E2E_SPEC_NOT_FOUND ${spec}`)
}

const require = createRequire(import.meta.url)
const playwrightCli = require.resolve('@playwright/test/cli')

function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readLock() {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf8'))
  } catch {
    return null
  }
}

function removeOwnLock() {
  const lock = readLock()
  if (!lock || lock.runId !== runId) return
  try { rmSync(lockPath, { force: true }) } catch {}
}

function powershellOwnedE2EPids() {
  if (process.platform !== 'win32') return []
  const escapedRoot = projectRoot.replaceAll("'", "''")
  const script = [
    "$root='" + escapedRoot + "'",
    "$rows=Get-CimInstance Win32_Process | Where-Object {",
    "  $_.ProcessId -ne $PID -and",
    "  $_.CommandLine -and $_.CommandLine.IndexOf($root,[System.StringComparison]::OrdinalIgnoreCase) -ge 0 -and",
    "  (($_.CommandLine -like '*wrangler*' -and ($_.CommandLine -like '*.wrangler/e2e-state*' -or $_.CommandLine -like '*.wrangler\\e2e-state*')) -or",
    "   ($_.Name -eq 'workerd.exe' -and $_.ExecutablePath -and $_.ExecutablePath.IndexOf($root,[System.StringComparison]::OrdinalIgnoreCase) -ge 0))",
    "}",
    "$rows | ForEach-Object { $_.ProcessId }",
  ].join('\n')
  try {
    const out = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    })
    return out.split(/\s+/).map(Number).filter((pid) => Number.isInteger(pid) && pid > 0)
  } catch {
    return []
  }
}

function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      })
    } else {
      process.kill(-pid, 'SIGTERM')
    }
  } catch {}
}

function cleanupOwnedE2ERuntimes() {
  const pids = powershellOwnedE2EPids().filter((pid) => pid !== process.pid)
  for (const pid of pids) killTree(pid)
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms))
}

async function settleOwnedE2ERuntimes(timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs
  let lastPids = []
  while (Date.now() < deadline) {
    lastPids = powershellOwnedE2EPids().filter((pid) => pid !== process.pid)
    if (lastPids.length === 0) {
      // Require a short quiet period: Playwright can exit just before its webServer
      // grandchildren finish releasing Miniflare/Workerd ephemeral ports on Windows.
      await sleep(300)
      const confirm = powershellOwnedE2EPids().filter((pid) => pid !== process.pid)
      if (confirm.length === 0) return
      lastPids = confirm
    }
    for (const pid of lastPids) killTree(pid)
    await sleep(150)
  }
  throw new Error(`E2E_RUNTIME_CLEANUP_TIMEOUT pids=${lastPids.join(',')}`)
}

function acquireLock() {
  mkdirSync(dirname(lockPath), { recursive: true })

  const existing = readLock()
  if (existing?.pid && isPidAlive(Number(existing.pid))) {
    throw new Error(`E2E_ALREADY_RUNNING pid=${existing.pid} startedAt=${existing.startedAt ?? 'unknown'}`)
  }

  if (existing) {
    cleanupOwnedE2ERuntimes()
    try { rmSync(lockPath, { force: true }) } catch {}
  } else {
    const untracked = powershellOwnedE2EPids()
    if (untracked.length > 0) {
      throw new Error(`E2E_UNTRACKED_RUNTIME_ACTIVE pids=${untracked.join(',')} — another/legacy E2E runtime is still active; do not start a second suite.`)
    }
  }

  writeFileSync(lockPath, JSON.stringify({
    pid: process.pid,
    runId,
    startedAt: new Date().toISOString(),
    projectRoot,
  }, null, 2), { flag: 'wx' })
  lockAcquired = true
}

function isTransientWorkerStartupFailure(output, code) {
  // Windows occasionally fails to initialize a freshly spawned Node/Workerd process
  // after many isolated spec runs. These NTSTATUS values are process/runtime crashes,
  // not Playwright assertion failures. Business failures normally exit with code 1.
  const windowsRuntimeCrash = process.platform === 'win32' && [3221225794, 3221226505].includes(code)
  return windowsRuntimeCrash || /Process from config\.webServer was not able to start|bad port|EADDRINUSE/i.test(output)
}

function runSpecAttempt(spec) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [playwrightCli, 'test', spec], {
      cwd: projectRoot,
      env: { ...process.env, PLAYWRIGHT_REUSE_SERVER: '0', PLAYWRIGHT_AUTH_E2E: (spec.endsWith('/app-auth.spec.ts') || spec.endsWith('/auth-runtime-do.spec.ts')) ? '1' : '0' },
      stdio: ['inherit', 'pipe', 'pipe'],
      shell: false,
      detached: false,
    })
    currentChild = child
    let output = ''
    const capture = (stream, destination) => {
      stream?.on('data', (chunk) => {
        destination.write(chunk)
        output = (output + chunk.toString()).slice(-64 * 1024)
      })
    }
    capture(child.stdout, process.stdout)
    capture(child.stderr, process.stderr)

    child.once('error', (error) => {
      currentChild = null
      rejectPromise(error)
    })
    child.once('exit', async (code, signal) => {
      currentChild = null
      try {
        cleanupOwnedE2ERuntimes()
        await settleOwnedE2ERuntimes()
      } catch (error) {
        rejectPromise(error)
        return
      }
      if (signal) return rejectPromise(new Error(`E2E_CHILD_SIGNAL ${signal} spec=${spec}`))
      resolvePromise({ code: code ?? 1, output })
    })
  })
}

async function runSpec(spec) {
  const maxAttempts = 3
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const result = await runSpecAttempt(spec)
    if (result.code === 0) {
      if (process.platform === 'win32') await sleep(750)
      return
    }
    if (attempt < maxAttempts && isTransientWorkerStartupFailure(result.output, result.code)) {
      const delayMs = attempt === 1 ? 3_000 : 7_000
      console.warn(`[e2e:fresh-retry] transient Worker startup failure code=${result.code}; retrying ${spec} with fresh state after ${delayMs}ms`)
      await sleep(delayMs)
      continue
    }
    throw new Error(`E2E_CHILD_EXIT ${result.code} spec=${spec}`)
  }
}

function shutdown(signal) {
  if (shuttingDown) return
  shuttingDown = true
  if (currentChild?.pid) killTree(currentChild.pid)
  if (lockAcquired) cleanupOwnedE2ERuntimes()
  removeOwnLock()
  process.exitCode = signal ? 130 : 1
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => shutdown(signal))
}

process.on('uncaughtException', (error) => {
  console.error(error)
  shutdown('uncaughtException')
})
process.on('unhandledRejection', (error) => {
  console.error(error)
  shutdown('unhandledRejection')
})

try {
  acquireLock()
  for (const name of specs) {
    if (shuttingDown) break
    const spec = `${testDir}/${name}`
    console.log(`\n[e2e:fresh] ${spec}`)
    await runSpec(spec)
  }
  if (!shuttingDown) console.log(`\n[e2e:fresh] ${specs.length} spec files passed.`)
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
} finally {
  if (currentChild?.pid) killTree(currentChild.pid)
  if (lockAcquired) cleanupOwnedE2ERuntimes()
  removeOwnLock()
}
