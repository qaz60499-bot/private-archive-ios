import { ArchiveGlyph } from './ArchiveGlyph'
import { useArchive } from '../context/ArchiveContext'

export function OfflineBadge() {
  const { online } = useArchive()
  return <span className={`offline-badge${online ? '' : ' visible'}`} role="status">{online ? '已连接' : '离线 · 将保存到本机'}</span>
}

export function UploadButton({ compact = false, label }: { compact?: boolean; label?: string }) {
  const { setUploadOpen } = useArchive()
  return (
    <button className={compact ? 'icon-button upload-icon' : 'primary-button'} type="button" onClick={() => setUploadOpen(true)}>
      <ArchiveGlyph name="upload" /><span>{label ?? (compact ? '上传' : '加入档案')}</span>
    </button>
  )
}
