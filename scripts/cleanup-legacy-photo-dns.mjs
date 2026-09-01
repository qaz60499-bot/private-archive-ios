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

async function cf(path, init = {}) {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${loadWranglerOAuthToken()}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  const body = await response.json().catch(() => ({}))
  if (!response.ok || body.success === false) throw new Error(`CLOUDFLARE_API_FAILED ${response.status} ${JSON.stringify(body.errors ?? body)}`)
  return body
}

const zones = await cf(`/zones?name=${encodeURIComponent(zoneName)}&account.id=${encodeURIComponent(accountId)}`)
const zone = Array.isArray(zones.result) ? zones.result.find((item) => item.name === zoneName) : null
if (!zone?.id) throw new Error('ZONE_NOT_FOUND')

const records = await cf(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(targetHostname)}`)
const matches = (Array.isArray(records.result) ? records.result : []).filter((item) => String(item.name).toLowerCase() === targetHostname)
console.log(`[legacy-photo-dns] mode=${apply ? 'apply' : 'dry-run'} count=${matches.length}`)
for (const record of matches) {
  console.log(`[legacy-photo-dns] ${apply ? 'delete' : 'would-delete'} id=${record.id} type=${record.type} name=${record.name} content=${record.content} proxied=${record.proxied}`)
}

if (!apply) process.exit(0)
for (const record of matches) {
  await cf(`/zones/${zone.id}/dns_records/${record.id}`, { method: 'DELETE' })
  console.log(`[legacy-photo-dns] deleted ${record.name} id=${record.id}`)
}
const verify = await cf(`/zones/${zone.id}/dns_records?name=${encodeURIComponent(targetHostname)}`)
const remaining = (Array.isArray(verify.result) ? verify.result : []).filter((item) => String(item.name).toLowerCase() === targetHostname)
if (remaining.length) throw new Error(`PHOTO_DNS_REMAINS count=${remaining.length}`)
console.log('[legacy-photo-dns] verification=clean')
