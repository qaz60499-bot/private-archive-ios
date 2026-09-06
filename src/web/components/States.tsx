import { useEffect, useRef } from 'react'
import { ArchiveX, CircleAlert, Images, LoaderCircle, RefreshCw } from 'lucide-react'

export function SkeletonGrid() {
  return <div className="skeleton-grid" aria-label="正在加载" aria-busy="true">{Array.from({ length: 10 }, (_, index) => <div key={index} style={{ aspectRatio: index % 3 === 0 ? '4/5' : '4/3' }} />)}</div>
}

export function EmptyState({ title = '档案仍是空的', description = '加入第一张影像，或从 Telegram 发给机器人。', action }: { title?: string; description?: string; action?: React.ReactNode }) {
  return <section className="empty-state"><ArchiveX aria-hidden="true" /><h2>{title}</h2><p>{description}</p>{action}</section>
}

export function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return <section className="error-state" role="alert"><CircleAlert /><h2>暂时无法打开档案</h2><p>{message}</p><button className="secondary-button" type="button" onClick={onRetry}><RefreshCw />重新尝试</button></section>
}

export function PageIntro({ eyebrow, title, description, count }: { eyebrow: string; title: string; description: string; count?: number }) {
  return <header className="page-intro"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>{count !== undefined && <div className="accession-count" aria-label={`${count} 项`}><Images /><strong>{String(count).padStart(2, '0')}</strong><span>ITEMS</span></div>}</header>
}

export function LoadMore({ loading, onLoad }: { loading: boolean; onLoad: () => void }) {
  const sentinelRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const target = sentinelRef.current
    if (!target || loading || typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoad()
    }, { rootMargin: '320px 0px' })
    observer.observe(target)
    return () => observer.disconnect()
  }, [loading, onLoad])

  return <div ref={sentinelRef} className="load-more-row" aria-live="polite" aria-busy={loading}>{loading ? <><LoaderCircle className="spin" /><span>正在载入更早档案…</span></> : <span className="sr-only">继续向下滚动会自动载入更早档案</span>}</div>
}

