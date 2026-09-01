import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const accountId = '401ad6b2ed84076030b3d980a78a696c'
const zoneName = 'joye.cc.cd'
const targetHostname = 'photo.joye.cc.cd'
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
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${loadWranglerOAuthToken()}`,
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

const zones = await cloudflare(`/zones?name=${encodeURIComponent(zoneName)}&account.id=${encodeURIComponent(accountId)}`)
const zone = Array.isArray(zones.result) ? zones.result.find((item) => item.name === zoneName) : null
if (!zone?.id) throw new Error('ZONE_NOT_FOUND')

const [accountList, zoneList] = await Promise.all([
  cloudflare(`/accounts/${accountId}/access/apps?per_page=200`),
  cloudflare(`/zones/${zone.id}/access/apps?per_page=200`),
])
const apps = [
  ...(Array.isArray(accountList.result) ? accountList.result.map((app) => ({ ...app, _scope: 'account' })) : []),
  ...(Array.isArray(zoneList.result) ? zoneList.result.map((app) => ({ ...app, _scope: 'zone' })) : []),
]
const selected = apps.filter((app) => {
  const domain = String(app.domain ?? '').toLowerCase()
  const destinations = JSON.stringify(app.destinations ?? []).toLowerCase()
  return domain === targetHostname || domain.startsWith(`${targetHostname}/`) || destinations.includes(targetHostname)
})

console.log(`[photo-access] mode=${apply ? 'apply' : 'dry-run'}`)
if (!selected.length) {
  console.log('[photo-access] no-matching-application')
  for (const app of apps) {
    const summary = JSON.stringify({ id: app.id, name: app.name, domain: app.domain, type: app.type, destinations: app.destinations })
    if (/photo|private-archive|joye\.cc\.cd/i.test(summary)) console.log(`[photo-access] candidate ${summary}`)
  }
  process.exitCode = 0
} else {
for (const app of selected) {
  console.log(`[photo-access] ${apply ? 'delete' : 'would-delete'} scope=${app._scope} id=${app.id} name=${app.name ?? ''} domain=${app.domain ?? ''} type=${app.type ?? ''} destinations=${JSON.stringify(app.destinations ?? [])}`)
}
}

if (!apply || !selected.length) {
  // no-op
} else for (const app of selected) {
  const base = app._scope === 'zone' ? `/zones/${zone.id}` : `/accounts/${accountId}`
  await cloudflare(`${base}/access/apps/${app.id}`, { method: 'DELETE' })
  console.log(`[photo-access] deleted id=${app.id}`)
}

const [accountVerify, zoneVerify] = await Promise.all([
  cloudflare(`/accounts/${accountId}/access/apps?per_page=200`),
  cloudflare(`/zones/${zone.id}/access/apps?per_page=200`),
])
const verifyApps = [
  ...(Array.isArray(accountVerify.result) ? accountVerify.result : []),
  ...(Array.isArray(zoneVerify.result) ? zoneVerify.result : []),
]
const remaining = verifyApps.filter((app) => {
  const domain = String(app.domain ?? '').toLowerCase()
  const destinations = JSON.stringify(app.destinations ?? []).toLowerCase()
  return domain === targetHostname || domain.startsWith(`${targetHostname}/`) || destinations.includes(targetHostname)
})
if (remaining.length) throw new Error(`PHOTO_ACCESS_REMAINS ${remaining.map((app) => app.id).join(',')}`)
console.log('[photo-access] verification=clean')
