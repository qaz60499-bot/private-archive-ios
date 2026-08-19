const encoder = new TextEncoder()

function quoteHeader(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('\r', '').replaceAll('\n', '')
}

export function createStreamingMultipart(options: {
  fields: Record<string, string>
  fileField: string
  fileName: string
  mimeType: string
  body: ReadableStream<Uint8Array>
}): { body: ReadableStream<Uint8Array>; contentType: string } {
  const boundary = `----private-archive-${crypto.randomUUID()}`
  const fields = Object.entries(options.fields)
    .map(([name, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${quoteHeader(name)}"\r\n\r\n${value}\r\n`)
    .join('')
  const prefix = encoder.encode(
    `${fields}--${boundary}\r\nContent-Disposition: form-data; name="${quoteHeader(options.fileField)}"; filename="${quoteHeader(options.fileName)}"\r\nContent-Type: ${options.mimeType}\r\n\r\n`,
  )
  const suffix = encoder.encode(`\r\n--${boundary}--\r\n`)
  const reader = options.body.getReader()
  let prefixSent = false
  let suffixSent = false

  return {
    contentType: `multipart/form-data; boundary=${boundary}`,
    body: new ReadableStream<Uint8Array>({
      async pull(controller) {
        if (!prefixSent) {
          prefixSent = true
          controller.enqueue(prefix)
          return
        }
        const next = await reader.read()
        if (!next.done) {
          controller.enqueue(next.value)
          return
        }
        if (!suffixSent) {
          suffixSent = true
          controller.enqueue(suffix)
        }
        controller.close()
      },
      async cancel(reason) {
        await reader.cancel(reason)
      },
    }),
  }
}

