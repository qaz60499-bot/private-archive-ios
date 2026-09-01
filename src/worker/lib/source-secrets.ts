const encoder = new TextEncoder()
const decoder = new TextDecoder()

function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - normalized.length % 4) % 4)
  const binary = atob(padded)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

async function importMasterKey(encodedKey: string): Promise<CryptoKey> {
  const raw = fromBase64Url(encodedKey)
  if (raw.byteLength !== 32) throw new Error('MASTER_ENCRYPTION_KEY_INVALID')
  return crypto.subtle.importKey('raw', toArrayBuffer(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

export interface EncryptedSecret {
  ciphertext: string
  iv: string
}

export async function encryptSourceSecret(masterKey: string, plaintext: string, aad: string): Promise<EncryptedSecret> {
  if (!plaintext) throw new Error('SECRET_EMPTY')
  const key = await importMasterKey(masterKey)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({
    name: 'AES-GCM',
    iv,
    additionalData: encoder.encode(aad),
    tagLength: 128,
  }, key, encoder.encode(plaintext))
  return { ciphertext: toBase64Url(new Uint8Array(encrypted)), iv: toBase64Url(iv) }
}

export async function decryptSourceSecret(masterKey: string, secret: EncryptedSecret, aad: string): Promise<string> {
  const key = await importMasterKey(masterKey)
  try {
    const decrypted = await crypto.subtle.decrypt({
      name: 'AES-GCM',
      iv: toArrayBuffer(fromBase64Url(secret.iv)),
      additionalData: encoder.encode(aad),
      tagLength: 128,
    }, key, toArrayBuffer(fromBase64Url(secret.ciphertext)))
    return decoder.decode(decrypted)
  } catch {
    throw new Error('SOURCE_SECRET_DECRYPT_FAILED')
  }
}

export function createSecretToken(bytesLength = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytesLength)))
}
