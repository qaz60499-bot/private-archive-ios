import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { CheckCircle2, LoaderCircle, X, XCircle } from 'lucide-react'
import { useArchive } from '../context/ArchiveContext'
import { subscribeUploadScheduler } from '../lib/offline/processor'
import { listLocalUploads } from '../lib/offline/store'
import type { LocalUploadJob } from '../types'

// App-level import feedback. "Queued" means the bytes have been persisted in the
// browser recovery queue; it is deliberately distinct from Telegram confirmation.
// The toast follows the selected batch until each queued item is confirmed, physically
// deduplicated by reusing an existing Telegram object, or fails and needs attention.
export function ImportToast() {
  const { importStatus, dismissImportStatus } = useArchive()
  const [jobs, setJobs] = useState<LocalUploadJob[]>([])

  const batchId = importStatus?.batchId
  useEffect(() => {
    if (!batchId) return
    let disposed = false
    const reload = async () => {
      const all = await listLocalUploads()
      if (!disposed) setJobs(all.filter((job) => job.batchId === batchId))
    }
    void reload()
    const unsubscribe = subscribeUploadScheduler(() => void reload())
    const timer = window.setInterval(() => void reload(), 1500)
    return () => {
      disposed = true
      unsubscribe()
      window.clearInterval(timer)
    }
  }, [batchId])

  if (typeof document === 'undefined' || !importStatus) return null
  const { active, total, processed, queued, phase, error } = importStatus
  const percent = total ? Math.round((processed / total) * 100) : 0
  const doneRegistering = phase === 'complete'
  const confirmed = jobs.filter((job) => job.status === 'done').length
  const deduplicated = jobs.filter((job) => job.status === 'done' && job.deduplicated).length
  const failed = jobs.filter((job) => job.status === 'failed' && job.controlState !== 'canceled').length
  const canceled = jobs.filter((job) => job.controlState === 'canceled').length
  const unresolved = Math.max(0, queued - confirmed - canceled)
  const telegramSettled = doneRegistering && queued > 0 && unresolved === 0 && failed === 0

  const title = active
    ? '正在接收并写入本机恢复队列…'
    : error
      ? '部分文件未能写入本机队列'
      : failed
        ? 'Telegram 上传有失败项'
        : queued
          ? `已加入 ${queued} 项${telegramSettled ? ' · 云端已确认' : ' · Telegram 正在继续'}`
          : '没有可上传项目'

  let detail: string
  if (active) {
    detail = `本机已保存 ${queued}/${total} 项 · 已检查 ${processed}/${total}`
  } else if (error) {
    detail = `本机已保存 ${queued}/${total} 项 · ${error}`
  } else if (failed) {
    detail = `本机已保存 ${queued}/${total} 项 · 已确认 ${confirmed}/${queued} · ${failed} 项需要重试`
  } else if (!telegramSettled && queued) {
    detail = `本机已保存 ${queued}/${total} 项 · Telegram 已确认 ${confirmed}/${queued} · 剩余 ${unresolved} 项继续上传`
  } else if (queued) {
    detail = `Telegram 已确认 ${confirmed}/${queued}${deduplicated ? ` · ${deduplicated} 项复用已有 Telegram 原件` : ''}`
  } else {
    detail = '没有文件进入上传队列。'
  }

  const showSpinner = active || doneRegistering && !error && !failed && !telegramSettled && queued > 0
  const toast = (
    <div className={`import-toast${doneRegistering ? ' is-complete' : ''}${error || failed ? ' is-error' : ''}`} role="status" aria-live="polite">
      <span className="import-toast-icon" aria-hidden="true">
        {showSpinner ? <LoaderCircle className="spin" /> : error || failed ? <XCircle /> : <CheckCircle2 />}
      </span>
      <div className="import-toast-body">
        <strong>{title}</strong>
        <span>{detail}</span>
        {active && <div className="import-toast-bar"><i style={{ width: `${percent}%` }} /></div>}
      </div>
      {doneRegistering && <button type="button" className="import-toast-close" onClick={dismissImportStatus} aria-label="关闭提示"><X /></button>}
    </div>
  )
  return createPortal(toast, document.body)
}
