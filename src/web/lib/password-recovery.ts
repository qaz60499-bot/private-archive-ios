const PASSWORD_ITERATIONS = 600_000
const PASSWORD_BYTES = 32
const MIN_PASSWORD_LENGTH = 9
const MAX_PASSWORD_LENGTH = 256

const encoder = new TextEncoder()

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

export async function deriveRecoveryPasswordHash(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) throw new Error('PASSWORD_INVALID')
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits'])
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PASSWORD_ITERATIONS },
    key,
    PASSWORD_BYTES * 8,
  )
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${encodeBase64Url(salt)}$${encodeBase64Url(new Uint8Array(bits))}`
}
