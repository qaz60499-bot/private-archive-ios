import { useEffect } from 'react'
import { LoaderCircle } from 'lucide-react'

export function AccessCheckPage() {
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const target = params.get('return') || '/'
    window.location.replace(target.startsWith('/') ? target : '/')
  }, [])

  return <section className="access-check-page" aria-live="polite"><LoaderCircle className="spin" /><strong>访问验证完成，正在返回档案…</strong></section>
}
