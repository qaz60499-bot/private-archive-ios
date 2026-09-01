import { describe, expect, it } from 'vitest'
import { readBoundedJsonObject } from '../../src/worker/lib/request-json'

function chunkedRequest(chunks: string[], headers: HeadersInit = {}): Request {
  const encoder = new TextEncoder()
  let index = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index >= chunks.length) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(chunks[index++]))
    },
  })
  return new Request('https://example.test/api', { method: 'POST', headers, body: stream, duplex: 'half' } as RequestInit & { duplex: 'half' })
}

describe('readBoundedJsonObject', () => {
  it('parses a bounded JSON object', async () => {
    const request = new Request('https://example.test/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ok: true }),
    })
    await expect(readBoundedJsonObject(request, 1024)).resolves.toEqual({ ok: true })
  })

  it('rejects an oversized declared Content-Length before reading the body', async () => {
    const request = chunkedRequest(['{}'], { 'Content-Length': '4096' })
    await expect(readBoundedJsonObject(request, 1024)).rejects.toThrow('REQUEST_BODY_TOO_LARGE')
  })

  it('rejects an oversized streamed body without Content-Length', async () => {
    const request = chunkedRequest(['{"value":"', 'x'.repeat(2048), '"}'], { 'Content-Type': 'application/json' })
    await expect(readBoundedJsonObject(request, 1024)).rejects.toThrow('REQUEST_BODY_TOO_LARGE')
  })

  it('rejects malformed or non-object JSON', async () => {
    const malformed = chunkedRequest(['{'])
    await expect(readBoundedJsonObject(malformed, 1024)).rejects.toThrow('REQUEST_BODY_INVALID')

    const array = chunkedRequest(['[]'])
    await expect(readBoundedJsonObject(array, 1024)).rejects.toThrow('REQUEST_BODY_INVALID')
  })
})
