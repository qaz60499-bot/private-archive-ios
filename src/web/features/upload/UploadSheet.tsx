import { useEffect, useRef, useState } from 'react'
import { CheckCircle2, FileUp, LoaderCircle, Pause, Play, RotateCcw, Trash2, Video, WifiOff, X, XCircle } from 'lucide-react'
import { useArchive } from '../../context/ArchiveContext'
import { importFiles, type ImportFilesProgress } from '../../lib/import-files'
import { summarizeUploadBatches, type UploadBatchSummary } from '../../lib/offline/batch'
import { listLocalUploads, removeLocalUpload } from '../../lib/offline/store'
import {
  cancelLocalUpload, cancelUploadBatch, pauseLocalUpload, pauseUploadBatch, resumeLocalUpload, resumeUploadBatch,
  retryFailedUploadBatch, subscribeUploadScheduler,
} from '../../lib/offline/processor'
import type { LocalUploadJob } from '../../types'

const stageLabels: Record<LocalUploadJob['stage'], string> = {
  registered: '等待准备', preparing: '读取元数据与指纹', reserving: '核对精确重复', preview: '保存预览', original: '保存 Telegram 原件', completed: '已完成',
}

function jobDescription(job: LocalUploadJob): string {
  if (job.controlState === 'canceled') return job.error ?? '已取消'
  if (job.controlState === 'paused') return job.error ?? '已暂停'
  if (job.status === 'failed') return job.error ?? '上传失败'
  if (job.status === 'done') return job.deduplicated ? '已存在相同文件，已跳过重复原件' : '已保存，正在整理'
  if (job.nextAttemptAt) return `${job.error ?? '稍后重试'} · ${new Date(job.nextAttemptAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`
  return `${stageLabels[job.stage]} · ${job.progress}%`
}

function JobRow({ job, reload }: { job: LocalUploadJob; reload: () => Promise<void> }) {
  const working = job.prepareStatus === 'preparing' || ['uploading', 'retrying'].includes(job.status) && job.controlState === 'active'
  return <article className={`upload-job ${job.status}`}>
    <div className="job-icon">{job.status === 'done' ? <CheckCircle2 /> : job.controlState === 'paused' ? <WifiOff /> : working ? <LoaderCircle className="spin" /> : <FileUp />}</div>
    <div><strong>{job.fileName}</strong><span>{jobDescription(job)}</span><div className="progress"><i style={{ width: `${job.progress}%` }} /></div></div>
    <div className="job-actions">
      {job.controlState === 'paused' || job.status === 'failed' && job.controlState !== 'canceled'
        ? <button type="button" aria-label={`继续 ${job.fileName}`} onClick={async () => { await resumeLocalUpload(job.id); await reload() }}><Play /></button>
        : job.status !== 'done' && job.controlState !== 'canceled' ? <button type="button" aria-label={`暂停 ${job.fileName}`} onClick={async () => { await pauseLocalUpload(job.id); await reload() }}><Pause /></button> : null}
      {job.status !== 'done' && job.controlState !== 'canceled' && <button type="button" aria-label={`取消 ${job.fileName}`} onClick={async () => { await cancelLocalUpload(job.id); await reload() }}><XCircle /></button>}
      {(job.status === 'done' || job.controlState === 'canceled') && <button type="button" aria-label={`移除 ${job.fileName}`} onClick={async () => { await removeLocalUpload(job.id); await reload() }}><Trash2 /></button>}
    </div>
  </article>
}

function BatchSection({ batch, compact, reload }: { batch: UploadBatchSummary; compact: boolean; reload: () => Promise<void> }) {
  const unfinished = batch.total - batch.completed - batch.canceled
  return <section className="upload-batch" aria-labelledby={`batch-${batch.id}`}>
    <header>
      <div><strong id={`batch-${batch.id}`}>批次 · {new Date(batch.createdAt).toLocaleString('zh-CN')}</strong><span>{batch.completed}/{batch.total} 完成{batch.deduplicated ? ` · ${batch.deduplicated} 项精确重复` : ''}{batch.failed ? ` · ${batch.failed} 项失败` : ''}</span></div>
      <span className="batch-progress-label">{batch.progress}%</span>
    </header>
    <div className="progress batch-progress"><i style={{ width: `${batch.progress}%` }} /></div>
    <div className="batch-actions">
      {unfinished > 0 && batch.paused < unfinished && <button type="button" onClick={async () => { await pauseUploadBatch(batch.id); await reload() }}><Pause />暂停全部</button>}
      {batch.paused > 0 && <button type="button" onClick={async () => { await resumeUploadBatch(batch.id); await reload() }}><Play />继续全部</button>}
      {batch.failed > 0 && <button type="button" onClick={async () => { await retryFailedUploadBatch(batch.id); await reload() }}><RotateCcw />重试失败</button>}
      {unfinished > 0 && <button type="button" onClick={async () => { await cancelUploadBatch(batch.id); await reload() }}><XCircle />取消未完成</button>}
    </div>
    <div className="upload-batch-jobs">{batch.jobs.slice(0, compact ? 8 : undefined).map((job) => <JobRow key={job.id} job={job} reload={reload} />)}</div>
    {compact && batch.jobs.length > 8 && <p className="batch-overflow-note">另有 {batch.jobs.length - 8} 项可在“上传队列”页面查看。</p>}
  </section>
}

export function UploadQueue({ compact = false, suspended = false }: { compact?: boolean; suspended?: boolean }) {
  const [jobs, setJobs] = useState<LocalUploadJob[]>([])
  const reload = async () => setJobs(await listLocalUploads())
  useEffect(() => {
    if (suspended) return
    void listLocalUploads().then(setJobs)
    const unsubscribe = subscribeUploadScheduler(() => void reload())
    const timer = window.setInterval(() => void reload(), 2_000)
    return () => { unsubscribe(); window.clearInterval(timer) }
  }, [suspended])
  if (suspended) return null
  const batches = summarizeUploadBatches(jobs)
  if (!jobs.length) return compact ? null : <p className="queue-empty">本机暂无待上传项目。</p>
  return <div className={`upload-queue${compact ? ' compact' : ''}`} aria-live="polite">{batches.slice(0, compact ? 1 : undefined).map((batch) => <BatchSection key={batch.id} batch={batch} compact={compact} reload={reload} />)}</div>
}

export function UploadSheet() {
  const { uploadOpen, setUploadOpen, online } = useArchive()
  const [activeImports, setActiveImports] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [importProgress, setImportProgress] = useState<ImportFilesProgress | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const mobile = typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches
  useEffect(() => {
    if (!uploadOpen) return
    const previous = document.activeElement as HTMLElement | null
    closeRef.current?.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setUploadOpen(false)
      if (event.key === 'Tab') {
        const dialog = document.querySelector('.upload-sheet')
        const focusables = dialog?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')
        if (focusables?.length) {
          const first = focusables[0]; const last = focusables[focusables.length - 1]
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus() }
  }, [uploadOpen, setUploadOpen])
  useEffect(() => {
    if (!uploadOpen) return
    document.body.classList.add('upload-open')
    return () => document.body.classList.remove('upload-open')
  }, [uploadOpen])
  const addFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files)
    if (!selected.length) return
    setActiveImports((count) => count + 1)
    setError(null)
    setImportProgress(null)
    try {
      const result = await importFiles(selected, online, { onProgress: setImportProgress })
      if (result.errors.length) setError(result.errors.join('；'))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加入上传队列')
    } finally {
      setActiveImports((count) => Math.max(0, count - 1))
    }
  }
  const busy = activeImports > 0
  if (!uploadOpen) return null
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setUploadOpen(false)}>
    <section className="upload-sheet" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header><div><p className="eyebrow">New accession</p><h2 id="upload-title">加入私人档案</h2></div><button ref={closeRef} className="icon-button" type="button" onClick={() => setUploadOpen(false)} aria-label="关闭"><X /></button></header>
      {mobile ? <div className="mobile-native-import">
        <div className={`drop-zone mobile-photo-picker${busy ? ' is-importing' : ''}`}>
          {busy ? <LoaderCircle className="spin" /> : <FileUp />}<strong>{busy ? '后台正在加入，可继续选择更多照片' : '从手机相册选择照片'}</strong><span>直接导入原图；网页会读取 EXIF 拍摄时间、地点和文件时间。照片选完返回网页后会自动回到图库并继续后台上传。</span>
          <input id="archive-upload-input" ref={inputRef} className="mobile-native-file-control" type="file" multiple accept="image/*" aria-label="选择照片、视频或文件" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} />
        </div>
        <div className="mobile-video-row"><Video /><span>视频单独选择，避免系统相册把大量照片和视频一起准备而卡住。</span><input id="archive-video-upload-input" className="mobile-native-video-control" type="file" multiple accept="video/*" aria-label="选择视频" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} /></div>
      </div> : <div className={`drop-zone${busy ? ' is-importing' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files) }}>
        {busy ? <LoaderCircle className="spin" /> : <FileUp />}<strong>{busy ? '后台正在加入，可继续选择更多文件' : '选择照片、视频或文件'}</strong><span>文件会进入后台上传队列，支持连续多批选择。</span>
        <input id="archive-upload-input" ref={inputRef} className="drop-zone-input" type="file" multiple accept="image/*,video/*,.pdf,.txt,.zip" aria-label="选择照片、视频或文件" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (selected.length) void addFiles(selected) }} />
      </div>}
      {importProgress && <div className="import-progress" role="status" aria-live="polite">
        <div><strong>{activeImports > 1 ? '正在接收多批选择' : importProgress.phase === 'complete' ? '全部文件已加入后台队列' : `正在添加第 ${importProgress.window}/${importProgress.windows} 批`}</strong><span>本次已选择 {importProgress.total} 项 · 已安全加入 {importProgress.queued} 项 · 已检查 {importProgress.processed}/{importProgress.total}</span></div>
        <div className="progress"><i style={{ width: `${importProgress.total ? Math.round(importProgress.processed / importProgress.total * 100) : 0}%` }} /></div>
      </div>}
      <div className="size-policy"><div><b>≤20 MB</b><span>网页完整读取</span></div><div><b>20–48 MB</b><span>预览 + Telegram 原件</span></div><div><b>&gt;48 MB</b><span>明确阻止</span></div></div>
      {!online && <p className="offline-notice"><WifiOff />当前离线。文件已进入本机队列，恢复网络并打开 PWA 后会继续。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <UploadQueue compact />
    </section>
  </div>
}
