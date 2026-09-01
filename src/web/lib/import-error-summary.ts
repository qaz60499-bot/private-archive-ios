export function summarizeImportErrors(errors: string[]): string | null {
  if (!errors.length) return null
  if (errors.length === 1) return errors[0]
  const first = errors[0]
  const separator = first.indexOf('：')
  const reason = (separator >= 0 ? first.slice(separator + 1) : first).trim()
  const conciseReason = reason.length > 180 ? `${reason.slice(0, 177)}…` : reason
  return `${errors.length} 项未能加入上传队列。主要原因：${conciseReason}`
}
