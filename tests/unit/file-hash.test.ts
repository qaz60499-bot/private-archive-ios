import { describe, expect, it } from 'vitest'
import { sha256File } from '../../src/web/lib/file-hash'

function patternBlob(size: number): Blob {
  const chunk = new Uint8Array(1024 * 1024)
  for (let index = 0; index < chunk.length; index += 1) chunk[index] = index % 251
  const parts: BlobPart[] = []
  let remaining = size
  while (remaining > 0) {
    const take = Math.min(remaining, chunk.length)
    parts.push(chunk.slice(0, take))
    remaining -= take
  }
  return new Blob(parts)
}

describe('sha256File', () => {
  it('matches the standard SHA-256 vector for a small blob', async () => {
    await expect(sha256File(new Blob(['abc']))).resolves.toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  it('uses the bounded-memory incremental path for large blobs without changing the digest', async () => {
    const blob = patternBlob(33 * 1024 * 1024 + 123)
    const expected = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer())
    const expectedHex = [...new Uint8Array(expected)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
    await expect(sha256File(blob)).resolves.toBe(expectedHex)
  }, 20_000)
})
