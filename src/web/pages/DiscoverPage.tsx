import { useEffect, useMemo, useState } from 'react'
import { Building2, Camera, Film, Leaf, PartyPopper, Plus, Shapes, Soup, UsersRound, Waypoints } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import { PageIntro } from '../components/States'
import { AssetPreviewById } from '../components/AssetPreviewById'
import { api } from '../lib/api'
import type { DiscoverModule } from '../types'

let analysisRetryScheduledThisSession = false

const moduleIcons: Record<string, LucideIcon> = {
  people: UsersRound,
  gathering: PartyPopper,
  travel: Waypoints,
  city: Building2,
  nature: Leaf,
  food: Soup,
  screenshot: Camera,
  other: Shapes,
  video: Film,
}

export function DiscoverPage() {
  const navigate = useNavigate()
  const [modules, setModules] = useState<DiscoverModule[]>([])
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    void api.listDiscoverModules().then((result) => {
      if (active) setModules(result.items)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : '加载模块失败')
    })

    // Retrying failed AI analysis is maintenance work, not a prerequisite for
    // rendering Discover. Previously Promise.all made every visit wait for the
    // mutation/queue request before showing any modules. Run it once per app session
    // and only after the UI has had time to become interactive.
    let retryTimer: number | undefined
    if (!analysisRetryScheduledThisSession) {
      analysisRetryScheduledThisSession = true
      retryTimer = window.setTimeout(() => { void api.retryFailedAnalysis().catch(() => null) }, 4_000)
    }
    return () => {
      active = false
      if (retryTimer !== undefined) window.clearTimeout(retryTimer)
    }
  }, [])

  const categories = useMemo(() => [...modules].sort((left, right) => left.sortOrder - right.sortOrder), [modules])

  const createModule = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed || creating) return
    setCreating(true)
    setError(null)
    try {
      const result = await api.createDiscoverModule(trimmed)
      setModules((current) => [...current, result.module])
      setName('')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建模块失败')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="page discover-page">
      <PageIntro eyebrow="Collections · 02" title="从另一条路径重逢" description="默认模块负责自动整理；你也可以创建自己的模块，并在图片右侧信息栏手动调整归属。" />
      <form className="discover-module-create" onSubmit={(event) => void createModule(event)}>
        <label htmlFor="discover-module-name">新建模块</label>
        <input id="discover-module-name" value={name} onChange={(event) => setName(event.target.value)} maxLength={24} placeholder="例如：聚餐、家人、展览" />
        <button className="secondary-button" type="submit" disabled={creating || !name.trim()}><Plus />{creating ? '创建中' : '添加模块'}</button>
        {error ? <span className="discover-module-error" role="alert">{error}</span> : null}
      </form>
      <div className="category-grid">
        {categories.map((module) => {
          const Icon = moduleIcons[module.slug] ?? Shapes
          const target = module.kind === 'media'
            ? '/videos'
            : `/?category=${encodeURIComponent(module.slug)}&label=${encodeURIComponent(module.name)}`
          return (
            <button key={module.slug} className="category-card" type="button" onClick={() => navigate(target)}>
              {module.coverAssetId ? <AssetPreviewById assetId={module.coverAssetId} /> : null}
              <span className="category-wash" />
              <div>
                <Icon />
                <p>{module.description}</p>
                <h2>{module.name}</h2>
                <span>{String(module.assetCount).padStart(2, '0')} ITEMS</span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
