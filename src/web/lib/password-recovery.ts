const PASSWORD_ITERATIONS = 600_000
const PASSWORD_BYTES = 32
const MIN_PASSWORD_LENGTH = 9
const MAX_PASSWORD_LENGTH = 256

const encoder = new TextEncoder()

export function passwordRecoveryErrorMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : ''
  switch (code) {
    case 'APP_RECOVERY_NOT_ALLOWED': return '密码恢复只能在 Cloudflare Access 保护的网页中完成。请打开浏览器恢复页面，完成后回到应用使用新密码登录。'
    case 'PASSWORD_INVALID': return '密码长度必须为 9–256 个字符。'
    case 'APP_PASSWORD_RECOVERY_FAILED': return '密码重置暂时未确认完成。请重试；如果密码已经更改，请使用新密码登录。'
    default: return code || '密码重置未完成，请重试。'
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=')
  const binary = atob(padded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

export async function derivePasswordProof(password: string, saltBase64Url: string, iterations = PASSWORD_ITERATIONS): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw new Error('PASSWORD_INVALID')
  if (!Number.isInteger(iterations) || iterations < 1) throw new Error('PASSWORD_CHALLENGE_INVALID')
  const salt = decodeBase64Url(saltBase64Url)
  if (salt.byteLength !== 16) throw new Error('PASSWORD_CHALLENGE_INVALID')
  const saltBytes = new Uint8Array(salt.byteLength)
  saltBytes.set(salt)
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes.buffer, iterations },
    key,
    PASSWORD_BYTES * 8,
  )
  return encodeBase64Url(new Uint8Array(bits))
}

export async function deriveRecoveryPasswordHash(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw new Error('PASSWORD_INVALID')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const saltBase64Url = encodeBase64Url(salt)
  const proof = await derivePasswordProof(password, saltBase64Url, PASSWORD_ITERATIONS)
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${saltBase64Url}$${proof}`
}
