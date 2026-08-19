import { useMemo, useState } from 'react'
import { CalendarRange, LoaderCircle, X } from 'lucide-react'
import { api } from '../lib/api'

interface TimelineMonthJumpProps {
  value?: string
  onChange: (month?: string) => void
}

export function TimelineMonthJump({ value, onChange }: TimelineMonthJumpProps) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<Array<{ month: string; asset_count: number }>>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState(false)

  const groups = useMemo(() => {
    const grouped = new Map<string, Array<{ month: string; asset_count: number }>>()
    for (const item of items) {
      const year = item.month.slice(0, 4)
      grouped.set(year, [...(grouped.get(year) ?? []), item])
    }
    return [...grouped.entries()]
  }, [items])

  const show = async () => {
    setOpen(true)
    if (loaded || loading) return
    setLoading(true)
    setError(false)
    try {
      const response = await api.timelineMonths()
      setItems(response.items)
      setLoaded(true)
    } catch {
      setError(true)
    } finally {
      setLoading(false)
    }
  }

  return <div className="timeline-month-jump">
    <button className={`secondary-button${value ? ' active' : ''}`} type="button" onClick={() => void show()} aria-expanded={open}><CalendarRange />{value ? value.replace('-', ' · ') : '时间定位'}</button>
    {open ? <div className="timeline-month-popover" role="dialog" aria-label="按月份跳转">
      <header><div><p className="eyebrow">TIME INDEX</p><strong>按年月直达</strong></div><button className="icon-button" type="button" aria-label="关闭时间定位" onClick={() => setOpen(false)}><X /></button></header>
      {loading ? <div className="timeline-month-loading"><LoaderCircle className="spin" />正在读取时间索引</div> : error ? <button className="secondary-button" type="button" onClick={() => { setLoaded(false); void show() }}>重新读取</button> : groups.length ? <div className="timeline-month-groups">
        {value ? <button className="timeline-month-all" type="button" onClick={() => { onChange(undefined); setOpen(false) }}>返回全部时间</button> : null}
        {groups.map(([year, months]) => <section key={year}><strong>{year}</strong><div>{months.map((item) => <button key={item.month} className={item.month === value ? 'selected' : ''} type="button" onClick={() => { onChange(item.month); setOpen(false) }}><span>{Number(item.month.slice(5))}月</span><small>{item.asset_count}</small></button>)}</div></section>)}
      </div> : <p className="timeline-month-empty">当前还没有可定位的拍摄月份。</p>}
    </div> : null}
  </div>
}
