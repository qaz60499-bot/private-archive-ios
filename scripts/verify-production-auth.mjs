import fs from 'node:fs'

const username = process.argv[2]
if (!username) throw new Error('Usage: node scripts/verify-production-auth.mjs <username>')

function readDevVars() {
  const result = {}
  const text = fs.readFileSync('.dev.vars', 'utf8')
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const index = trimmed.indexOf('=')
    if (index <= 0) continue
    const key = trimmed.slice(0, index).trim()
    let value = trimmed.slice(index + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    result[key] = value
  }
  return result
}

const password = readDevVars().TEMP_OWNER_LOGIN_PASSWORD
if (!password) throw new Error('TEMP_OWNER_LOGIN_PASSWORD_MISSING')

const base = 'https://api.photo.joye.cc.cd'
const nativeHeaders = {
  Origin: 'capacitor://localhost',
  'X-Private-Archive-Native': 'ios',
  'Content-Type': 'application/json',
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function bodyJson(response) {
  return response.json().catch(() => null)
}

async function login(passwordValue) {
  return fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: nativeHeaders,
    body: JSON.stringify({ username, password: passwordValue }),
    redirect: 'manual',
  })
}

function cookieFrom(response) {
  const setCookie = response.headers.get('set-cookie')
  return setCookie?.split(';')[0] ?? null
}

const statusAnon = await fetch(`${base}/api/auth/status`, {
  headers: { 'X-Private-Archive-Native': 'ios' },
  redirect: 'manual',
})
const statusAnonBody = await bodyJson(statusAnon)
assert(statusAnon.status === 200 && statusAnonBody?.initialized === true, 'AUTH_STATUS_ANON_FAILED')

const wrong = await login(`wrong-${crypto.randomUUID()}`)
const wrongBody = await bodyJson(wrong)
assert(wrong.status === 401 && wrongBody?.error === 'LOGIN_INVALID', 'WRONG_PASSWORD_BEHAVIOR_FAILED')

const correct = await login(password)
const correctBody = await bodyJson(correct)
assert(correct.status === 200 && correctBody?.user?.username === username, `CORRECT_LOGIN_FAILED:${correct.status}:${correctBody?.error ?? 'NO_ERROR_CODE'}`)
const cookie = cookieFrom(correct)
assert(cookie, 'LOGIN_COOKIE_MISSING')

const me = await fetch(`${base}/api/auth/me`, {
  headers: { 'X-Private-Archive-Native': 'ios', Cookie: cookie },
  redirect: 'manual',
})
const meBody = await bodyJson(me)
assert(me.status === 200 && meBody?.user?.username === username, 'AUTH_ME_FAILED')

const statusSession = await fetch(`${base}/api/auth/status`, {
  headers: { 'X-Private-Archive-Native': 'ios', Cookie: cookie },
  redirect: 'manual',
})
const statusSessionBody = await bodyJson(statusSession)
assert(statusSession.status === 200 && statusSessionBody?.authenticated === true, 'AUTH_STATUS_SESSION_FAILED')

const logout = await fetch(`${base}/api/auth/logout`, {
  method: 'POST',
  headers: { ...nativeHeaders, Cookie: cookie },
  body: '{}',
  redirect: 'manual',
})
assert(logout.status === 200, 'LOGOUT_FAILED')

const meAfterLogout = await fetch(`${base}/api/auth/me`, {
  headers: { 'X-Private-Archive-Native': 'ios', Cookie: cookie },
  redirect: 'manual',
})
const meAfterLogoutBody = await bodyJson(meAfterLogout)
assert(meAfterLogout.status === 401 && meAfterLogoutBody?.error === 'APP_AUTH_REQUIRED', 'LOGOUT_REVOCATION_FAILED')

const relogin = await login(password)
const reloginBody = await bodyJson(relogin)
assert(relogin.status === 200 && reloginBody?.user?.username === username, 'RELOGIN_FAILED')
const reloginCookie = cookieFrom(relogin)
assert(reloginCookie, 'RELOGIN_COOKIE_MISSING')

const finalLogout = await fetch(`${base}/api/auth/logout`, {
  method: 'POST',
  headers: { ...nativeHeaders, Cookie: reloginCookie },
  body: '{}',
  redirect: 'manual',
})
assert(finalLogout.status === 200, 'FINAL_LOGOUT_FAILED')

console.log('PRODUCTION_AUTH_SMOKE_OK', JSON.stringify({
  anonymousStatus: statusAnon.status,
  wrongPasswordStatus: wrong.status,
  loginStatus: correct.status,
  meStatus: me.status,
  authenticatedStatus: statusSessionBody.authenticated,
  logoutStatus: logout.status,
  postLogoutStatus: meAfterLogout.status,
  reloginStatus: relogin.status,
  finalLogoutStatus: finalLogout.status,
}))
