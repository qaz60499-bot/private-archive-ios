export type ArchiveGlyphName =
  | 'archive'
  | 'library'
  | 'discover'
  | 'people'
  | 'places'
  | 'albums'
  | 'videos'
  | 'files'
  | 'favorites'
  | 'queue'
  | 'settings'
  | 'search'
  | 'upload'

const corePaths: Record<ArchiveGlyphName, ReactNode> = {
  archive: <><path d="M10 10.5h12v11H10z" /><path d="M8.5 7.5h15M13 14h6M16 14v4" /></>,
  library: <><path d="M8.5 9.5h12v14h-12z" /><path d="M12 6.5h11.5v13" /><path d="M12 13.5h5M12 17h7" /></>,
  discover: <><path d="M16 8.2c2.8 0 5 2.2 5 5 0 4.2-5 10.4-5 10.4s-5-6.2-5-10.4c0-2.8 2.2-5 5-5Z" /><path d="m16 11.5 1.4 3.1 3.1 1.4-3.1 1.4-1.4 3.1-1.4-3.1-3.1-1.4 3.1-1.4Z" /></>,
  people: <><circle cx="13" cy="12" r="3.1" /><circle cx="20.5" cy="14.2" r="2.1" /><path d="M7.8 23c.6-4 2.4-6 5.2-6s4.6 2 5.2 6M18.2 18.3c2.8-.6 4.8 1 5.5 4.1" /></>,
  places: <><path d="M7.5 22.5c3.6-2.1 6.8-2.1 9.8 0s5.4 1.8 7.2-.5M7.8 17.8c2.8-1.4 5.2-1.4 7.3 0" /><circle cx="19" cy="12" r="3.2" /><path d="M19 6.5v2.2M19 15.3v2.2M13.5 12h2.2M22.3 12h2.2" /></>,
  albums: <><rect x="8" y="10" width="15" height="12" rx="1.5" /><path d="m11 10 2-3h7l2 3M11.5 18.5l3.3-3.4 2.5 2.4 1.8-1.6 2.4 2.6" /></>,
  videos: <><path d="M8 10.5h11v11H8z" /><path d="m19 14 5-2.3v8.6L19 18M12.4 14v4l3.6-2Z" /></>,
  files: <><path d="M10 7.5h8l4 4v13H10z" /><path d="M18 7.5v4h4M13 16h6M13 19.5h5" /></>,
  favorites: <><path d="M16 23.5S8.5 19 8.5 13.7c0-2.6 1.8-4.5 4.2-4.5 1.5 0 2.7.8 3.3 2 .6-1.2 1.8-2 3.3-2 2.4 0 4.2 1.9 4.2 4.5C23.5 19 16 23.5 16 23.5Z" /><path d="M11.5 13.4c.3-1.1 1-1.7 2-1.8" /></>,
  queue: <><path d="M9 17.5a7 7 0 1 1 5.5 5.3" /><path d="m8 13 1 4.5 4.4-1.4M16 10v6l4 2" /><circle cx="10.5" cy="22" r="1" /></>,
  settings: <><path d="M16 8.5 19.5 10l3.2 3.5-.7 4.6-3 3.4-4.6.7-3.9-2.5-1.2-4.5 1.8-4.2Z" /><circle cx="16" cy="15.5" r="3.3" /><path d="m19.5 10-1.7 3M22 18.1l-3.5-.8M14.4 22.2l.1-3.5M10.5 19.7l2.3-2.5M11.1 11l3 2" /></>,
  search: <><circle cx="14" cy="14" r="6" /><path d="m18.5 18.5 5 5M11 14h6M14 11v6" /></>,
  upload: <><path d="M8.5 20v3.5h15V20M16 20V7.5M11.5 12l4.5-4.5 4.5 4.5" /></>,
}

export function ArchiveGlyph({ name, className = '' }: { name: ArchiveGlyphName; className?: string }) {
  return (
    <svg className={`archive-glyph glyph-${name} ${className}`} viewBox="0 0 32 32" fill="none" aria-hidden="true">
      <circle className="glyph-orbit" cx="16" cy="16" r="13" />
      <g className="glyph-core">{corePaths[name]}</g>
      <circle className="glyph-dot" cx="26.5" cy="9" r="1.35" />
    </svg>
  )
}
import type { ReactNode } from 'react'
