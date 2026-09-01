import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type SyntheticEvent } from 'react'
import { ArrowDown, Clock3, ImagePlus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { api } from '../lib/api'
import { formatArchiveDay } from '../lib/asset-display'
import { usePrivateMediaUrl } from '../lib/native-media'
import type { ArchiveSummary, Asset } from '../types'

interface MemoryApertureProps {
  assets: Asset[]
  onImport: () => void
}

function frameDate(asset: Asset | undefined): string {
  return asset ? formatArchiveDay(asset.takenAt) : 'ARCHIVE'
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function chooseArchiveFrames(assets: Asset[]): Asset[] {
  const candidates = assets
    .filter((asset) => asset.status !== 'trashed' && asset.mediaType !== 'file')
    .sort((left, right) => Date.parse(right.takenAt) - Date.parse(left.takenAt) || left.id.localeCompare(right.id))
  if (candidates.length <= 3) return candidates

  const daySeed = new Date().toISOString().slice(0, 10)
  const chosen: Asset[] = []
  const add = (asset: Asset | undefined) => {
    if (asset && !chosen.some((item) => item.id === asset.id)) chosen.push(asset)
  }
  const stablePick = (pool: Asset[], salt: string) => pool.length
    ? pool[stableHash(`${daySeed}:${salt}`) % pool.length]
    : undefined

  const recentWindow = candidates.slice(0, Math.max(3, Math.ceil(candidates.length / 3)))
  const olderWindow = candidates.slice(Math.max(1, Math.floor(candidates.length * 0.62)))
  const favorites = candidates.filter((asset) => asset.favorite)
  add(stablePick(recentWindow, 'recent'))
  add(stablePick(favorites, 'favorite'))
  add(stablePick(olderWindow, 'older'))

  for (const asset of [...candidates].sort((left, right) => stableHash(`${daySeed}:${left.id}`) - stableHash(`${daySeed}:${right.id}`))) {
    add(asset)
    if (chosen.length === 3) break
  }
  return chosen.slice(0, 3)
}

function ArchiveFrame({ asset, label, className, eager = false }: {
  asset?: Asset
  label: string
  className: string
  eager?: boolean
}) {
  const [failed, setFailed] = useState(false)
  const privatePreview = usePrivateMediaUrl(asset?.previewUrl, { enabled: Boolean(asset?.previewSupported && !failed) })
  const showImage = Boolean(privatePreview.url && asset?.previewSupported && !failed && !privatePreview.failed)
  const onError = (event: SyntheticEvent<HTMLImageElement>) => {
    event.currentTarget.hidden = true
    setFailed(true)
  }

  return <div className={`archive-frame ${className}${showImage ? ' has-image' : ' no-image'}`}>
    <span className="archive-frame-code">{label}</span>
    <div className="archive-frame-photo">
      {showImage ? <img
        src={privatePreview.url ?? undefined}
        alt=""
        loading={eager ? 'eager' : 'lazy'}
        decoding="async"
        fetchPriority={eager ? 'high' : 'low'}
        onError={onError}
      /> : null}
      <span className="archive-frame-placeholder" aria-hidden="true"><i /><i /><i /><i /></span>
    </div>
    <span className="archive-frame-caption">{frameDate(asset)} · {asset?.mediaType?.toUpperCase() ?? 'INDEX'}</span>
  </div>
}

export function MemoryAperture({ assets, onImport }: MemoryApertureProps) {
  const [summary, setSummary] = useState<ArchiveSummary | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const fallbackSummary = useMemo<ArchiveSummary>(() => {
    const activeAssets = assets.filter((asset) => asset.status !== 'trashed')
    const latest = activeAssets.reduce<string | null>((current, asset) => {
      if (!current || Date.parse(asset.uploadedAt) > Date.parse(current)) return asset.uploadedAt
      return current
    }, null)
    return {
      assetCount: activeAssets.length,
      photoCount: activeAssets.filter((asset) => asset.mediaType === 'photo').length,
      albumCount: 0,
      lastUpdate: latest,
    }
  }, [assets])

  useEffect(() => {
    let active = true
    void api.archiveSummary().then((next) => {
      if (active) setSummary(next)
    }).catch(() => {
      // Hero statistics are supplementary. A summary failure must never hide the archive.
    })
    return () => { active = false }
  }, [])

  const displaySummary = summary ?? fallbackSummary
  const previewAssets = useMemo(() => chooseArchiveFrames(assets), [assets])

  const resetPointerDepth = () => {
    const stage = stageRef.current
    if (!stage) return
    for (const property of ['--archive-back-x', '--archive-back-y', '--archive-mid-x', '--archive-mid-y', '--archive-front-x', '--archive-front-y']) {
      stage.style.setProperty(property, '0px')
    }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return
    const rect = event.currentTarget.getBoundingClientRect()
    const x = ((event.clientX - rect.left) / Math.max(1, rect.width) - 0.5) * 2
    const y = ((event.clientY - rect.top) / Math.max(1, rect.height) - 0.5) * 2
    const set = (name: string, value: number) => event.currentTarget.style.setProperty(name, `${value.toFixed(2)}px`)
    set('--archive-back-x', x * -2.4)
    set('--archive-back-y', y * -1.8)
    set('--archive-mid-x', x * 3.3)
    set('--archive-mid-y', y * 2.4)
    set('--archive-front-x', x * 5.2)
    set('--archive-front-y', y * 3.8)
  }

  return <header className="memory-aperture" data-render-mode="dom">
    <div className="memory-aperture-copy">
      <p className="eyebrow">PERSONAL ARCHIVE · PRIVATE INDEX</p>
      <h1><span>时间留下的</span><em>形状</em></h1>
      <p>把照片、视频与文件按真实时间收进同一份私人档案，安静地保存，也随时能够重新找到。</p>

      <dl className="archive-hero-stats" aria-label="档案摘要">
        <div><dt>PHOTOS</dt><dd>{displaySummary.photoCount}</dd></div>
        <div><dt>ALBUMS</dt><dd>{displaySummary.albumCount}</dd></div>
        <div className="archive-hero-stat-wide"><dt>LAST UPDATE</dt><dd>{formatArchiveDay(displaySummary.lastUpdate)}</dd></div>
      </dl>

      <div className="archive-hero-actions" aria-label="首页操作">
        <a className="primary-button" href="#archive-timeline"><ArrowDown />查看时间线</a>
        <button className="secondary-button" type="button" onClick={onImport}><ImagePlus />导入</button>
        <Link className="text-button archive-recent-link" to="/recent"><Clock3 />最近</Link>
      </div>
    </div>

    <div
      ref={stageRef}
      className="memory-aperture-stage"
      aria-hidden="true"
      onPointerMove={handlePointerMove}
      onPointerLeave={resetPointerDepth}
      onPointerCancel={resetPointerDepth}
    >
      <div className="archive-composition">
        <span className="archive-registration registration-a" />
        <span className="archive-registration registration-b" />
        <span className="archive-accession-label">PA / {String(displaySummary.assetCount).padStart(4, '0')}</span>
        <span className="archive-composition-rule" />
        <ArchiveFrame asset={previewAssets[2]} label="03" className="archive-frame-back" />
        <ArchiveFrame asset={previewAssets[1]} label="02" className="archive-frame-mid" />
        <ArchiveFrame asset={previewAssets[0]} label="01" className="archive-frame-front" eager />
        <span className="archive-contact-rail"><b>01</b><b>06</b><b>12</b><b>18</b><b>24</b></span>
        <span className="archive-index-note">CONTACT / TIME / MEMORY</span>
      </div>
    </div>
  </header>
}
