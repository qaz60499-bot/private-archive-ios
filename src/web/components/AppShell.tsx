import { createPortal } from 'react-dom'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useArchive } from '../context/ArchiveContext'
import { MediaViewer } from '../features/viewer/MediaViewer'
import { UploadSheet } from '../features/upload/UploadSheet'
import { ArchiveAtmosphere } from './ArchiveAtmosphere'
import { ArchiveGlyph, type ArchiveGlyphName } from './ArchiveGlyph'
import { MotionDirector } from './MotionDirector'

const desktopGroups = [
  [['/', '时间线', 'library'], ['/discover', '发现', 'discover'], ['/albums', '相册', 'albums']],
  [['/people', '人物', 'people'], ['/places', '地点', 'places'], ['/favorites', '收藏', 'favorites'], ['/videos', '视频', 'videos'], ['/files', '文件', 'files']],
  [['/queue', '待整理', 'queue'], ['/settings', '设置', 'settings']],
] as const

function DesktopSidebar() {
  return (
    <aside className="desktop-sidebar" aria-label="主导航">
      <NavLink to="/" className="archive-mark" aria-label="Private Archive 首页"><ArchiveGlyph name="archive" /></NavLink>
      <nav>
        {desktopGroups.map((items, groupIndex) => (
          <div className="rail-group" key={groupIndex}>
            {items.map(([path, label, glyph]) => (
              <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => `rail-link${isActive ? ' active' : ''}`}>
                <ArchiveGlyph name={glyph} /><span>{label}</span>
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  )
}

export function SearchBar() {
  const navigate = useNavigate()
  return (
    <form className="search-bar" role="search" onSubmit={(event) => {
      event.preventDefault()
      const data = new FormData(event.currentTarget)
      const query = String(data.get('q') ?? '').trim()
      navigate(query ? `/?q=${encodeURIComponent(query)}` : '/')
    }}>
      <ArchiveGlyph name="search" />
      <label className="sr-only" htmlFor="archive-search">搜索私人影像库</label>
      <input id="archive-search" name="q" type="search" placeholder="搜索日期、文件名、场景或标签" autoComplete="off" />
      <kbd aria-hidden="true">⌘ K</kbd>
    </form>
  )
}

export function OfflineBadge() {
  const { online } = useArchive()
  return <span className={`offline-badge${online ? '' : ' visible'}`} role="status">{online ? '已连接' : '离线 · 将保存到本机'}</span>
}

export function UploadButton({ compact = false }: { compact?: boolean }) {
  const { setUploadOpen } = useArchive()
  return (
    <button className={compact ? 'icon-button upload-icon' : 'primary-button'} type="button" onClick={() => setUploadOpen(true)}>
      <ArchiveGlyph name="upload" /><span>{compact ? '上传' : '加入档案'}</span>
    </button>
  )
}

function MobileBottomNav() {
  const { setUploadOpen } = useArchive()
  const items: ReadonlyArray<readonly [string, string, ArchiveGlyphName]> = [['/', '图库', 'library'], ['/discover', '发现', 'discover'], ['/albums', '相册', 'albums'], ['/?focus=search', '搜索', 'search']]
  const dock = (
    <div className="mobile-nav-dock">
      <nav className="mobile-bottom-nav" aria-label="移动端导航">
        {items.slice(0, 2).map(([path, label, glyph]) => <NavLink key={label} to={path} end={path === '/'}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}
        <button type="button" className="mobile-upload" onClick={() => setUploadOpen(true)} aria-label="上传媒体"><ArchiveGlyph name="upload" /></button>
        {items.slice(2).map(([path, label, glyph]) => <NavLink key={label} to={path}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}
      </nav>
    </div>
  )
  return typeof document === 'undefined' ? null : createPortal(dock, document.body)
}

export function AppShell() {
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">跳到主要内容</a>
      <ArchiveAtmosphere />
      <DesktopSidebar />
      <div className="app-column">
        <header className="topbar">
          <NavLink to="/" className="mobile-brand"><ArchiveGlyph name="archive" /><span>Private Archive</span></NavLink>
          <SearchBar />
          <OfflineBadge />
          <UploadButton />
        </header>
        <main id="main-content" className="main-content"><Outlet /></main>
      </div>
      <MotionDirector />
      <MobileBottomNav />
      <MediaViewer />
      <UploadSheet />
    </div>
  )
}
