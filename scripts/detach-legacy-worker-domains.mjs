import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const accountId = '401ad6b2ed84076030b3d980a78a696c'
const serviceName = 'private-archive'
const targetHostnames = new Set([
  'photo.joye.cc.cd',
  'api.photo.joye.cc.cd',
  'share.photo.joye.cc.cd',
])
const apply = process.argv.includes('--apply')

function loadWranglerOAuthToken() {
  const appData = process.env.APPDATA
  if (!appData) throw new Error('APPDATA_NOT_AVAILABLE')
  const configPath = join(appData, 'xdg.config', '.wrangler', 'config', 'private-archive-qaz60499.toml')
  const text = readFileSync(configPath, 'utf8')
  const match = text.match(/^oauth_token\s*=\s*"([^"]+)"/m)
  if (!match?.[1]) throw new Error('WRANGLER_OAUTH_TOKEN_NOT_FOUND')
  return match[1]
}

async function cloudflare(path, init = {}) {
  const token = loadWranglerOAuthToken()
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) {
    throw new Error(`CLOUDFLARE_API_FAILED ${response.status} ${JSON.stringify(body.errors ?? body)}`)
  }
  return body
}

const list = await cloudflare(`/accounts/${accountId}/workers/domains?service=${encodeURIComponent(serviceName)}`)
const domains = Array.isArray(list.result) ? list.result : []
const selected = domains.filter((item) => targetHostnames.has(String(item.hostname).toLowerCase()))

console.log(`[legacy-domains] mode=${apply ? 'apply' : 'dry-run'}`)
for (const item of selected) {
  console.log(`[legacy-domains] ${apply ? 'detach' : 'would-detach'} ${item.hostname} service=${item.service} id=${item.id}`)
}

if (!apply) {
  const missing = [...targetHostnames].filter((hostname) => !selected.some((item) => item.hostname === hostname))
  for (const hostname of missing) console.log(`[legacy-domains] already-absent ${hostname}`)
  process.exit(0)
}

for (const item of selected) {
  if (item.service !== serviceName) throw new Error(`REFUSING_NON_TARGET_SERVICE ${item.hostname} service=${item.service}`)
  await cloudflare(`/accounts/${accountId}/workers/domains/${item.id}`, { method: 'DELETE' })
  console.log(`[legacy-domains] detached ${item.hostname}`)
}

const verify = await cloudflare(`/accounts/${accountId}/workers/domains?service=${encodeURIComponent(serviceName)}`)
const remaining = (Array.isArray(verify.result) ? verify.result : []).filter((item) => targetHostnames.has(String(item.hostname).toLowerCase()))
if (remaining.length) throw new Error(`LEGACY_DOMAINS_REMAIN ${remaining.map((item) => item.hostname).join(',')}`)
console.log('[legacy-domains] verification=clean')
