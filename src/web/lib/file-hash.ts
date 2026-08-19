function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256File(file: Blob): Promise<string | undefined> {
  try {
    if (!globalThis.crypto?.subtle) return undefined
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
    return toHex(new Uint8Array(digest))
  } catch {
    return undefined
  }
}
