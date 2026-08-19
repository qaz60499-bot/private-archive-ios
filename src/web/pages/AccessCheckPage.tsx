import { useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'

function safeReturnTarget(rawTarget: string | null): string {
  if (!rawTarget) return '/'
  try {
    const target = new URL(rawTarget, window.location.origin)
    if (target.origin !== window.location.origin) return '/'
    return `${target.pathname}${target.search}${target.hash}` || '/'
  } catch {
    return '/'
  }
}

export function AccessCheckPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    window.location.replace(safeReturnTarget(params.get('return')))
  }, [])

  return <section className="access-check-page" aria-live="polite"><LoaderCircle className="spin" /><strong>访问验证完成，正在返回档案…</strong></section>
}
