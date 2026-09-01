export async function readBoundedJsonObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new Error('REQUEST_BODY_LIMIT_INVALID')

  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new Error('REQUEST_BODY_INVALID')
    if (parsedLength > maxBytes) throw new Error('REQUEST_BODY_TOO_LARGE')
  }
  if (!request.body) throw new Error('REQUEST_BODY_INVALID')

  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let total = 0
  let text = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new Error('REQUEST_BODY_TOO_LARGE')
    }
    text += decoder.decode(value, { stream: true })
  }
  text += decoder.decode()

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('REQUEST_BODY_INVALID')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('REQUEST_BODY_INVALID')
  return parsed as Record<string, unknown>
}
