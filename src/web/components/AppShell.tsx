import { useEffect, useState } from 'react'
import { LogOut, Repeat2, UserRound } from 'lucide-react'
import { createPortal } from 'react-dom'
import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useArchive } from '../context/ArchiveContext'
import { useAuth } from '../context/AuthContext'
import { MediaViewer } from '../features/viewer/MediaViewer'
import { UploadSheet } from '../features/upload/UploadSheet'
import { ArchiveAtmosphere } from './ArchiveAtmosphere'
import { ArchiveGlyph, type ArchiveGlyphName } from './ArchiveGlyph'
import { ImportToast } from './ImportToast'
import { MotionDirector } from './MotionDirector'
import { OfflineBadge, UploadButton } from './UploadControls'

const desktopGroups = [
  [['/', '时间线', 'library'], ['/discover', '发现', 'discover'], ['/albums', '相册', 'albums']],
  [['/people', '人物', 'people'], ['/places', '地点', 'places'], ['/favorites', '收藏', 'favorites'], ['/videos', '视频', 'videos'], ['/files', '文件', 'files']],
  [['/recent', '最近', 'recent'], ['/archive', '归档', 'historyArchive'], ['/trash', '回收站', 'recycle'], ['/activity', '活动', 'activity']],
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

function useVisualViewportAnchor() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const root = document.documentElement
    let raf = 0
    const apply = () => {
      raf = 0
      // The strip of layout viewport sitting *below* the visible visual viewport.
      // Non-zero while the mobile address bar is shown or during overscroll; the
      // dock CSS translates up by this amount to stay pinned to the real bottom.
      const overshoot = Math.max(0, window.innerHeight - vv.height - vv.offsetTop)
      root.style.setProperty('--vv-offset', `${overshoot}px`)
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(apply) }
    apply()
    vv.addEventListener('resize', schedule)
    vv.addEventListener('scroll', schedule)
    window.addEventListener('orientationchange', schedule)
    return () => {
      if (raf) cancelAnimationFrame(raf)
      vv.removeEventListener('resize', schedule)
      vv.removeEventListener('scroll', schedule)
      window.removeEventListener('orientationchange', schedule)
      root.style.removeProperty('--vv-offset')
    }
  }, [])
}

function MobileBottomNav() {
  const { setUploadOpen } = useArchive()
  const [moreOpen, setMoreOpen] = useState(false)
  useVisualViewportAnchor()
  const primary: ReadonlyArray<readonly [string, string, ArchiveGlyphName]> = [['/', '图库', 'library'], ['/discover', '发现', 'discover'], ['/albums', '相册', 'albums']]
  const moreContent: ReadonlyArray<readonly [string, string, ArchiveGlyphName]> = [['/files', '文件', 'files'], ['/favorites', '收藏', 'favorites'], ['/recent', '最近', 'recent'], ['/archive', '归档', 'historyArchive']]
  const moreManage: ReadonlyArray<readonly [string, string, ArchiveGlyphName]> = [['/trash', '回收站', 'recycle'], ['/activity', '活动', 'activity'], ['/queue', '待整理', 'queue'], ['/settings', '设置', 'settings']]
  const dock = (
    <>
      {moreOpen ? <button type="button" className="mobile-more-scrim" aria-label="关闭更多导航" onClick={() => setMoreOpen(false)} /> : null}
      <div className="mobile-nav-dock">
        {moreOpen ? <div className="mobile-more-menu" role="dialog" aria-modal="true" aria-label="更多导航">
          <span className="mobile-more-handle" aria-hidden="true" />
          <header><div><small>Navigation</small><strong>更多</strong></div><button type="button" onClick={() => setMoreOpen(false)}>完成</button></header>
          <section><span>内容</span><div className="mobile-more-grid">{moreContent.map(([path, label, glyph]) => <NavLink key={path} to={path} onClick={() => setMoreOpen(false)}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}</div></section>
          <section><span>管理</span><div className="mobile-more-list">{moreManage.map(([path, label, glyph]) => <NavLink key={path} to={path} onClick={() => setMoreOpen(false)}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}</div></section>
        </div> : null}
        <nav className="mobile-bottom-nav" aria-label="移动端导航">
          {primary.slice(0, 2).map(([path, label, glyph]) => <NavLink key={label} to={path} end={path === '/'}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}
          <button type="button" className="mobile-upload" onClick={() => setUploadOpen(true)} aria-label="上传媒体"><ArchiveGlyph name="upload" /></button>
          {primary.slice(2).map(([path, label, glyph]) => <NavLink key={label} to={path}><ArchiveGlyph name={glyph} /><span>{label}</span></NavLink>)}
          <button type="button" className={moreOpen ? 'mobile-more-trigger active' : 'mobile-more-trigger'} onClick={() => setMoreOpen((value) => !value)} aria-expanded={moreOpen}><ArchiveGlyph name="more" /><span>更多</span></button>
        </nav>
      </div>
    </>
  )
  return typeof document === 'undefined' ? null : createPortal(dock, document.body)
}

function AccountMenu() {
  const { user, switchAccount, logout } = useAuth()
  const [open, setOpen] = useState(false)
  const runAccountAction = (action: () => Promise<void>) => {
    setOpen(false)
    void action()
  }
  if (!user) return null
  return <div className="account-menu-wrap">
    <button className="account-menu-trigger" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} aria-label={`当前账号 ${user.displayName}`}>
      <span className="account-avatar"><UserRound /></span><span className="account-trigger-copy"><strong>{user.displayName}</strong><small>{user.role === 'OWNER' ? 'Owner' : `@${user.username}`}</small></span>
    </button>
    {open ? <div className="account-popover" role="menu">
      <div className="account-popover-head"><strong>{user.displayName}</strong><span>@{user.username} · {user.role}</span></div>
      <button type="button" role="menuitem" onClick={() => runAccountAction(switchAccount)}><Repeat2 />切换账号</button>
      <button type="button" role="menuitem" onClick={() => runAccountAction(logout)}><LogOut />退出登录</button>
    </div> : null}
  </div>
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
          <AccountMenu />
        </header>
        <main id="main-content" className="main-content"><Outlet /></main>
      </div>
      <MotionDirector />
      <MobileBottomNav />
      <MediaViewer />
      <UploadSheet />
      <ImportToast />
    </div>
  )
}
