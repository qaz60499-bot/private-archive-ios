import { useCallback, useEffect, useRef, useState } from 'react'
import type { RefObject, SyntheticEvent, TouchEvent as ReactTouchEvent, WheelEvent as ReactWheelEvent } from 'react'
import { Album, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, Heart, ImageOff, Maximize2, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { useArchive } from '../../context/ArchiveContext'
import { api } from '../../lib/api'
import { assetSourceLabel, formatArchiveDate, formatBytes } from '../../lib/asset-display'
import { usePrivateMediaUrl } from '../../lib/native-media'
import { isNativeApp } from '../../lib/native-platform'
import type { Album as AlbumType, Asset, DiscoverModule } from '../../types'

export function MetadataPanel({ expanded, onToggle }: { expanded: boolean; onToggle: () => void }) {
  const { viewerAsset: asset, setAssetCategory } = useArchive()
  const [albums, setAlbums] = useState<AlbumType[]>([])
  const [added, setAdded] = useState<string | null>(null)
  const [modules, setModules] = useState<DiscoverModule[]>([])
  const [categorySaving, setCategorySaving] = useState(false)
  useEffect(() => {
    let active = true
    void api.listDiscoverModules().then(({ items }) => {
      if (active) setModules(items.filter((item) => item.kind === 'category'))
    }).catch(() => null)
    return () => { active = false }
  }, [])
  if (!asset) return null
  const aiModuleName = modules.find((item) => item.slug === asset.aiCategory)?.name ?? asset.aiCategory ?? '其他'
  return (
    <aside className="metadata-panel" aria-label="媒体信息">
      <button type="button" className="metadata-sheet-handle" onClick={onToggle} aria-expanded={expanded} aria-label={expanded ? '收起档案信息' : '展开档案信息'}>
        <span aria-hidden="true" />
        <strong>{expanded ? '收起详情' : '查看详情'}</strong>
        {expanded ? <ChevronDown aria-hidden="true" /> : <ChevronUp aria-hidden="true" />}
      </button>
      <p className="eyebrow">Archive record</p>
      <h2>{asset.originalName}</h2>
      <dl>
        <div><dt>拍摄时间</dt><dd>{formatArchiveDate(asset.takenAt)}</dd></div>
        <div><dt>来源</dt><dd>{assetSourceLabel(asset.source)}</dd></div>
        <div><dt>导入时间</dt><dd>{formatArchiveDate(asset.uploadedAt)}</dd></div>
        {asset.deletedAt ? <div><dt>删除时间</dt><dd>{formatArchiveDate(asset.deletedAt)}</dd></div> : null}
        <div><dt>原路径</dt><dd>{asset.logicalPath || '/'}</dd></div>
        <div><dt>文件</dt><dd>{asset.mimeType} · {formatBytes(asset.sizeBytes)}</dd></div>
        <div><dt>整理状态</dt><dd>{asset.analysisStatus === 'limited' ? '仅基础整理' : asset.analysisStatus}</dd></div>
        {asset.albumNames?.length ? <div><dt>相册</dt><dd>{asset.albumNames.join('、')}</dd></div> : null}
        {asset.latitude !== null && <div><dt>坐标</dt><dd>{asset.latitude.toFixed(4)}, {asset.longitude?.toFixed(4)} · 待解析</dd></div>}
      </dl>
      <div className="tag-list">{asset.tags?.map((tag) => <span key={tag.slug}>{tag.name}</span>) ?? <span>{asset.primaryCategory ?? '未分类'}</span>}</div>
      {asset.status !== 'trashed' ? <div className="viewer-category-control">
        <label htmlFor={`asset-module-${asset.id}`}>所属模块</label>
        <select
          id={`asset-module-${asset.id}`}
          value={asset.categoryOverride ?? ''}
          disabled={categorySaving}
          onChange={(event) => {
            const next = event.target.value || null
            setCategorySaving(true)
            void setAssetCategory(asset, next).finally(() => setCategorySaving(false))
          }}
        >
          <option value="">自动 · {aiModuleName}</option>
          {modules.map((module) => <option key={module.slug} value={module.slug}>{module.name}</option>)}
        </select>
        <small>{asset.categorySource === 'manual' ? '手动归类优先，AI 不会覆盖。' : '当前由 AI 自动归类；可随时手动移动。'}</small>
      </div> : null}
      {asset.status !== 'trashed' ? <div className="viewer-album">
        <button type="button" className="text-button" onClick={async () => setAlbums((await api.listAlbums()).items)}><Album />加入相册</button>
        {albums.length > 0 && <div className="album-options">{albums.map((item) => <button key={item.id} type="button" onClick={async () => { await api.addToAlbum(item.id, asset.id); setAdded(item.name) }}>{added === item.name ? '已加入 ' : '+ '}{item.name}</button>)}</div>}
      </div> : null}
      {asset.status === 'trashed' ? <p className="viewer-note">此项目位于回收站。这里仅用于确认内容与元数据；恢复或永久删除请回到回收站操作。</p> : null}
      {!asset.originalAvailableInApp && <p className="viewer-note">原文件当前不能从网页直接读取；这里使用可用的小预览浏览。</p>}
    </aside>
  )
}

function fitImageToStage(stage: HTMLElement, image: HTMLImageElement): void {
  if (!image.naturalWidth || !image.naturalHeight) return
  const style = getComputedStyle(stage)
  const horizontalPadding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight)
  const verticalPadding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom)
  const availableWidth = Math.max(1, stage.clientWidth - horizontalPadding)
  const availableHeight = Math.max(1, stage.clientHeight - verticalPadding)
  const scale = Math.min(availableWidth / image.naturalWidth, availableHeight / image.naturalHeight)
  image.style.width = `${Math.max(1, Math.floor(image.naturalWidth * scale))}px`
  image.style.height = `${Math.max(1, Math.floor(image.naturalHeight * scale))}px`
}

interface PhotoTransform {
  scale: number
  x: number
  y: number
}

function ViewerPhoto({ asset, stageRef, transform }: { asset: Asset; stageRef: RefObject<HTMLDivElement | null>; transform: PhotoTransform }) {
  const native = isNativeApp()
  const [source, setSource] = useState(asset.previewUrl)
  const [failed, setFailed] = useState(false)
  const loadingFull = useRef(false)
  const nativePreview = usePrivateMediaUrl(asset.previewUrl, { enabled: native && asset.previewSupported })
  const nativeFull = usePrivateMediaUrl(asset.mediaUrl, {
    enabled: native && asset.originalAvailableInApp && Boolean(asset.mediaUrl) && asset.sizeBytes <= 20 * 1024 * 1024,
    cache: false,
  })
  const displayedSource = native ? (nativeFull.url ?? nativePreview.url) : source

  const onLoad = (event: SyntheticEvent<HTMLImageElement>) => {
    setFailed(false)
    if (stageRef.current) fitImageToStage(stageRef.current, event.currentTarget)
    if (native || source !== asset.previewUrl || !asset.originalAvailableInApp || !asset.mediaUrl || asset.sizeBytes > 20 * 1024 * 1024 || loadingFull.current) return
    loadingFull.current = true
    const full = new Image()
    full.decoding = 'async'
    full.onload = () => setSource(asset.mediaUrl as string)
    full.onerror = () => { loadingFull.current = false }
    full.src = asset.mediaUrl
  }

  if (asset.status === 'pending_upload' && !asset.previewSupported) return <div className="viewer-preview-unavailable viewer-preview-pending" role="status"><ImageOff /><strong>原件正在上传</strong><span>服务器已经登记这项内容，但原件还没有写入 Telegram。完成后这里会自动获得预览。</span></div>
  if (asset.status === 'failed' && !asset.previewSupported) return <div className="viewer-preview-unavailable" role="status"><ImageOff /><strong>原件上传未完成</strong><span>请回到上传队列重试；其它档案不受影响。</span></div>
  if (failed || nativePreview.failed || !asset.previewSupported) return <div className="viewer-preview-unavailable" role="status"><ImageOff /><strong>预览不可用</strong><span>这只影响当前项目；其它档案仍可继续浏览。</span></div>
  if (!displayedSource) return <div className="viewer-preview-unavailable" role="status"><strong>正在加载</strong><span>正在安全读取私有媒体。</span></div>

  return <img
    src={displayedSource}
    alt={asset.originalName}
    draggable={false}
    onLoad={onLoad}
    onError={() => setFailed(true)}
    style={{ transform: `translate3d(${transform.x}px, ${transform.y}px, 0) scale(${transform.scale})` }}
  />
}

function ViewerVideo({ asset }: { asset: Asset }) {
  const native = isNativeApp()
  const nativeVideo = usePrivateMediaUrl(asset.mediaUrl, { enabled: native && asset.originalAvailableInApp && Boolean(asset.mediaUrl), cache: false })
  const nativePoster = usePrivateMediaUrl(asset.previewUrl, { enabled: native && asset.previewSupported })
  const source = native ? nativeVideo.url : (asset.mediaUrl ?? asset.previewUrl)
  const poster = native ? nativePoster.url ?? undefined : asset.previewUrl
  if (native && nativeVideo.failed) return <div className="viewer-preview-unavailable" role="status"><ImageOff /><strong>视频读取失败</strong><span>请检查网络后重试。</span></div>
  if (!source) return <div className="viewer-preview-unavailable" role="status"><strong>正在加载</strong><span>正在安全读取私有视频。</span></div>
  return <video src={source} poster={poster} controls autoPlay={false} />
}

interface GestureState {
  startX: number
  startY: number
  lastX: number
  lastY: number
  startScale: number
  startTranslateX: number
  startTranslateY: number
  pinchDistance: number
  pinch: boolean
  moved: boolean
}

const initialGesture = (): GestureState => ({
  startX: 0,
  startY: 0,
  lastX: 0,
  lastY: 0,
  startScale: 1,
  startTranslateX: 0,
  startTranslateY: 0,
  pinchDistance: 0,
  pinch: false,
  moved: false,
})

const distance = (touches: ReactTouchEvent<HTMLDivElement>['touches']): number => {
  if (touches.length < 2) return 0
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)
}

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))

export function MediaViewer() {
  const { viewerAsset: asset, assets, closeViewer, openViewer, toggleFavorite, trashAsset } = useArchive()
  const closeRef = useRef<HTMLButtonElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const gestureRef = useRef<GestureState>(initialGesture())
  const lastTapRef = useRef(0)
  const suppressClickRef = useRef(false)
  const [photoTransform, setPhotoTransform] = useState<PhotoTransform>({ scale: 1, x: 0, y: 0 })
  const [uiHidden, setUiHidden] = useState(false)
  const [metadataExpanded, setMetadataExpanded] = useState(false)
  const index = asset ? assets.findIndex((item) => item.id === asset.id) : -1

  const resetPhoto = useCallback(() => setPhotoTransform({ scale: 1, x: 0, y: 0 }), [])
  const setScale = useCallback((nextScale: number) => {
    setPhotoTransform((current) => {
      const scale = clamp(nextScale, 1, 4)
      return scale === 1 ? { scale: 1, x: 0, y: 0 } : { ...current, scale }
    })
  }, [])

  const move = useCallback((direction: number) => {
    if (index < 0 || !assets.length) return
    openViewer(assets[(index + direction + assets.length) % assets.length])
  }, [assets, index, openViewer])

  useEffect(() => {
    const timer = window.setTimeout(() => {
      resetPhoto()
      setUiHidden(false)
      setMetadataExpanded(false)
    }, 0)
    return () => window.clearTimeout(timer)
  }, [asset?.id, resetPhoto])

  useEffect(() => {
    if (!asset || index < 0 || assets.length < 2 || isNativeApp()) return
    const neighbors = [assets[(index - 1 + assets.length) % assets.length], assets[(index + 1) % assets.length]]
    for (const neighbor of neighbors) {
      if (neighbor.mediaType === 'file') continue
      const preview = new Image()
      preview.decoding = 'async'
      preview.src = neighbor.previewUrl
    }
  }, [asset, assets, index])

  useEffect(() => {
    if (!asset || asset.mediaType === 'video') return
    const stage = stageRef.current
    if (!stage) return
    const refit = () => {
      const image = stage.querySelector<HTMLImageElement>(':scope > img')
      if (image) fitImageToStage(stage, image)
    }
    const observer = new ResizeObserver(refit)
    observer.observe(stage)
    refit()
    window.addEventListener('resize', refit)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', refit)
    }
  }, [asset])

  useEffect(() => {
    if (!asset) return
    const previous = document.activeElement as HTMLElement | null
    document.body.classList.add('viewer-open')
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeViewer()
      if (event.key === 'ArrowLeft') move(-1)
      if (event.key === 'ArrowRight') move(1)
      if (event.key === '+' || event.key === '=') setScale(photoTransform.scale + 0.4)
      if (event.key === '-') setScale(photoTransform.scale - 0.4)
      if (event.key === '0') resetPhoto()
      if (event.key === 'Tab') {
        const dialog = document.querySelector('.media-viewer')
        const focusables = dialog?.querySelectorAll<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')
        if (focusables?.length) {
          const first = focusables[0]
          const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      document.body.classList.remove('viewer-open')
      window.removeEventListener('keydown', onKey)
      previous?.focus()
    }
  }, [asset, closeViewer, move, photoTransform.scale, resetPhoto, setScale])

  const handleTouchStart = (event: ReactTouchEvent<HTMLDivElement>) => {
    if (!asset) return
    suppressClickRef.current = true
    const current = gestureRef.current
    if (event.touches.length >= 2 && asset.mediaType === 'photo') {
      current.pinch = true
      current.pinchDistance = distance(event.touches)
      current.startScale = photoTransform.scale
      current.moved = true
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    gestureRef.current = {
      startX: touch.clientX,
      startY: touch.clientY,
      lastX: touch.clientX,
      lastY: touch.clientY,
      startScale: photoTransform.scale,
      startTranslateX: photoTransform.x,
      startTranslateY: photoTransform.y,
      pinchDistance: 0,
      pinch: false,
      moved: false,
    }
  }

  const handleTouchMove = (event: ReactTouchEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current
    if (gesture.pinch && event.touches.length >= 2 && asset?.mediaType === 'photo') {
      event.preventDefault()
      const ratio = distance(event.touches) / Math.max(1, gesture.pinchDistance)
      setScale(gesture.startScale * ratio)
      return
    }
    const touch = event.touches[0]
    if (!touch) return
    gesture.lastX = touch.clientX
    gesture.lastY = touch.clientY
    const dx = touch.clientX - gesture.startX
    const dy = touch.clientY - gesture.startY
    if (Math.hypot(dx, dy) > 8) gesture.moved = true
    if (photoTransform.scale > 1 && asset?.mediaType === 'photo') {
      event.preventDefault()
      const stage = stageRef.current
      const maxX = (stage?.clientWidth ?? window.innerWidth) * (photoTransform.scale - 1) * 0.45
      const maxY = (stage?.clientHeight ?? window.innerHeight) * (photoTransform.scale - 1) * 0.45
      setPhotoTransform((current) => ({
        ...current,
        x: clamp(gesture.startTranslateX + dx, -maxX, maxX),
        y: clamp(gesture.startTranslateY + dy, -maxY, maxY),
      }))
    }
  }

  const handleTouchEnd = () => {
    const gesture = gestureRef.current
    if (gesture.pinch) {
      gestureRef.current = initialGesture()
      if (photoTransform.scale < 1.08) resetPhoto()
      return
    }
    const dx = gesture.lastX - gesture.startX
    const dy = gesture.lastY - gesture.startY
    const absX = Math.abs(dx)
    const absY = Math.abs(dy)

    if (!gesture.moved) {
      const now = Date.now()
      if (now - lastTapRef.current < 300 && asset?.mediaType === 'photo') {
        setScale(photoTransform.scale > 1.1 ? 1 : 2.25)
        lastTapRef.current = 0
      } else {
        lastTapRef.current = now
        setUiHidden((hidden) => !hidden)
      }
    } else if (photoTransform.scale <= 1.05) {
      if (absX > 54 && absX > absY * 1.15) move(dx < 0 ? 1 : -1)
      else if (dy > 78 && absY > absX * 1.12) closeViewer()
    }
    gestureRef.current = initialGesture()
    window.setTimeout(() => { suppressClickRef.current = false }, 80)
  }

  const handleWheel = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (asset?.mediaType !== 'photo' || (!event.ctrlKey && photoTransform.scale === 1)) return
    event.preventDefault()
    setScale(photoTransform.scale - event.deltaY * 0.004)
  }

  const nativeDownload = usePrivateMediaUrl(asset?.mediaUrl, { enabled: Boolean(asset?.originalAvailableInApp && asset?.mediaUrl), cache: false })

  if (!asset) return null
  const downloadUrl = isNativeApp() ? nativeDownload.url : asset.mediaUrl
  const zoomable = asset.mediaType === 'photo'
  const trashed = asset.status === 'trashed'
  const canNavigate = index >= 0 && assets.length > 1
  return (
    <div className={`media-viewer${uiHidden ? ' viewer-ui-hidden' : ''}${photoTransform.scale > 1 ? ' viewer-zoomed' : ''}${metadataExpanded ? ' viewer-metadata-expanded' : ''}`} role="dialog" aria-modal="true" aria-label={`查看 ${asset.originalName}`}>
      <div className="viewer-toolbar">
        <button ref={closeRef} type="button" onClick={closeViewer} aria-label="关闭"><X /><span>关闭</span></button>
        <div>
          {zoomable ? <>
            <button type="button" onClick={() => setScale(photoTransform.scale - 0.5)} aria-label="缩小"><ZoomOut /><span>缩小</span></button>
            <button type="button" onClick={resetPhoto} aria-label="适合窗口"><Maximize2 /><span>适合</span></button>
            <button type="button" onClick={() => setScale(photoTransform.scale + 0.5)} aria-label="放大"><ZoomIn /><span>放大</span></button>
          </> : null}
          {!trashed ? <button type="button" onClick={() => void toggleFavorite(asset)} aria-label={asset.favorite ? '取消收藏' : '收藏'} aria-pressed={asset.favorite}><Heart fill={asset.favorite ? 'currentColor' : 'none'} /><span>收藏</span></button> : null}
          {asset.originalAvailableInApp && downloadUrl && <a href={downloadUrl} download={asset.originalName} aria-label={`下载 ${asset.originalName}`}><Download /><span>下载</span></a>}
          {!trashed ? <button className="danger-button" type="button" aria-label="移入回收站" onClick={() => { if (window.confirm(`将“${asset.originalName}”移入回收站？Telegram 中的原文件不会被删除。`)) void trashAsset(asset) }}><Trash2 /><span>回收站</span></button> : null}
        </div>
      </div>
      <div
        ref={stageRef}
        className="viewer-stage"
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
        onWheel={handleWheel}
        onClick={(event) => {
          if (suppressClickRef.current) return
          const target = event.target as HTMLElement
          if (target === event.currentTarget || target.tagName === 'IMG') setUiHidden((hidden) => !hidden)
        }}
      >
        {canNavigate ? <button type="button" className="viewer-arrow left" onClick={(event) => { event.stopPropagation(); move(-1) }} aria-label="上一项"><ChevronLeft /></button> : null}
        {asset.mediaType === 'video' && asset.originalAvailableInApp
          ? <ViewerVideo asset={asset} />
          : <ViewerPhoto key={asset.id} asset={asset} stageRef={stageRef} transform={photoTransform} />}
        {canNavigate ? <button type="button" className="viewer-arrow right" onClick={(event) => { event.stopPropagation(); move(1) }} aria-label="下一项"><ChevronRight /></button> : null}
      </div>
      <MetadataPanel expanded={metadataExpanded} onToggle={() => { setUiHidden(false); setMetadataExpanded((value) => !value) }} />
    </div>
  )
}
