import { useEffect, useRef, useState } from 'react'
import { Camera, CheckCircle2, CloudDownload, FileUp, FolderOpen, LoaderCircle, Pause, Play, RotateCcw, Trash2, Video, WifiOff, X, XCircle } from 'lucide-react'
import { useArchive } from '../../context/ArchiveContext'
import { api } from '../../lib/api'
import { telegramUserGroupBridge } from '../../lib/telegram-user-group'
import { summarizeImportErrors } from '../../lib/import-error-summary'
import { canUseIosBackgroundUpload } from '../../lib/native-background-upload'
import { isNativeApp, nativePlatform } from '../../lib/native-platform'
import { summarizeUploadBatches, type UploadBatchSummary } from '../../lib/offline/batch'
import { listLocalUploads, removeLocalUpload } from '../../lib/offline/store'
import {
  cancelLocalUpload, cancelUploadBatch, pauseLocalUpload, pauseUploadBatch, resumeLocalUpload, resumeUploadBatch,
  retryFailedUploadBatch, subscribeUploadScheduler,
} from '../../lib/offline/processor'
import type { LocalUploadJob, StorageBackend } from '../../types'

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
  const { uploadOpen, setUploadOpen, online, importStatus, runImport } = useArchive()
  const [activeImports, setActiveImports] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [storageBackend, setStorageBackend] = useState<StorageBackend>(() => telegramUserGroupBridge.available ? 'telegram_user_group' : 'telegram_bot')
  const inputRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const mobileFileRef = useRef<HTMLInputElement>(null)
  const mobileVideoRef = useRef<HTMLInputElement>(null)
  const cameraPhotoRef = useRef<HTMLInputElement>(null)
  const cameraVideoRef = useRef<HTMLInputElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const nativeIos = isNativeApp() && nativePlatform() === 'ios'
  const mobile = nativeIos || typeof matchMedia === 'function' && matchMedia('(max-width: 767px)').matches
  useEffect(() => {
    if (!uploadOpen) return
    let active = true
    void api.storagePreference().then((result) => {
      if (!active) return
      const preferred = result.defaultStorageBackend
      setStorageBackend(preferred === 'telegram_user_group' && !telegramUserGroupBridge.available ? 'telegram_bot' : preferred)
    }).catch(() => undefined)
    return () => { active = false }
  }, [uploadOpen])
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
    if (folderRef.current) {
      folderRef.current.setAttribute('webkitdirectory', '')
      folderRef.current.setAttribute('directory', '')
    }
  }, [uploadOpen])
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
    try {
      // Delegate to the app-level importer so feedback stays visible even after the
      // sheet (or the whole picker flow on mobile) closes — the global toast reads the
      // same importStatus. The durable enqueue loop is unchanged.
      const result = await runImport(selected, { mobile, storageBackend })
      if (result?.errors.length) setError(summarizeImportErrors(result.errors))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加入上传队列')
    } finally {
      setActiveImports((count) => Math.max(0, count - 1))
    }
  }
  const busy = activeImports > 0 || Boolean(importStatus?.active)
  if (!uploadOpen) return null
  return <div className="sheet-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && setUploadOpen(false)}>
    <section className="upload-sheet" role="dialog" aria-modal="true" aria-labelledby="upload-title">
      <header><div><p className="eyebrow">New accession</p><h2 id="upload-title">加入私人档案</h2></div><button ref={closeRef} className="icon-button" type="button" onClick={() => setUploadOpen(false)} aria-label="关闭"><X /></button></header>
      <div className="storage-backend-picker" role="radiogroup" aria-label="上传存储后端">
        <span>存储到</span>
        <label className={storageBackend === 'telegram_user_group' ? 'active' : ''}><input type="radio" name="upload-storage-backend" value="telegram_user_group" checked={storageBackend === 'telegram_user_group'} onChange={() => setStorageBackend('telegram_user_group')} /><strong>Telegram 私人群组</strong><small>默认 · 使用你的用户账号上传到 ai 群</small></label>
        <label className={storageBackend === 'telegram_bot' ? 'active' : ''}><input type="radio" name="upload-storage-backend" value="telegram_bot" checked={storageBackend === 'telegram_bot'} onChange={() => setStorageBackend('telegram_bot')} /><strong>Telegram Bot</strong><small>兼容 / 备用 · 新文件仅建议 ≤20 MB</small></label>
      </div>
      {storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available ? <p className="offline-notice"><WifiOff />私人群组上传需要 Windows 客户端里的 Telegram Storage Bridge。手机端请直接把文件分享到 Telegram 的 <b>ai</b> 私人群组，Windows 客户端会自动补扫导入；也可以手动切换到 Bot 存储小文件。</p> : null}
      {canUseIosBackgroundUpload(storageBackend) ? <p className="native-background-note"><CheckCircle2 />Bot 上传已使用 iOS 原生后台传输。锁屏或切换到其他 App 后可继续；如果从多任务界面强制划掉 Private Archive，iOS 会停止后台任务，重新打开后会恢复。</p> : null}
      {mobile ? <div className="mobile-native-import">
        <div className={`drop-zone mobile-photo-picker${busy ? ' is-importing' : ''}`}>
          {busy ? <LoaderCircle className="spin" /> : <FileUp />}<strong>{busy ? '后台正在加入，可继续选择更多照片' : '照片 / iCloud Photos'}</strong><span>从系统照片库多选。原图里存在的拍摄时间、GPS、尺寸和相机信息会在上传准备阶段读取并保留。</span>
          <button className="secondary-button mobile-picker-button" type="button" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => inputRef.current?.click()}>选择照片</button>
          <input id="archive-upload-input" ref={inputRef} className="mobile-picker-input" type="file" multiple accept="image/*" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="选择照片" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} />
        </div>
        <div className="mobile-source-row"><Video /><span><strong>视频</strong><small>从“照片”或系统视频来源多选，读取尺寸、时长与可用文件时间。</small></span><button className="secondary-button mobile-picker-button" type="button" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => mobileVideoRef.current?.click()}>选择视频</button><input id="archive-video-upload-input" ref={mobileVideoRef} className="mobile-picker-input" type="file" multiple accept="video/*" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="选择视频" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} /></div>
        <div className="mobile-source-row"><FolderOpen /><span><strong>文件 / iCloud Drive</strong><small>打开 iOS“文件”选择器，可从 iCloud Drive、本机以及已接入 Files 的云盘选择任意文件类型。</small></span><button className="secondary-button mobile-picker-button" type="button" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => mobileFileRef.current?.click()}>选择文件</button><input ref={mobileFileRef} className="mobile-picker-input" type="file" multiple disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="从文件或 iCloud Drive 选择" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} /></div>
        <div className="mobile-source-row mobile-camera-row"><Camera /><span><strong>直接拍摄</strong><small>可直接调用相机拍照或录像，新生成文件进入同一队列、去重和断网恢复流程。</small></span><div className="mobile-capture-actions"><button className="secondary-button" type="button" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => cameraPhotoRef.current?.click()}>拍照</button><button className="secondary-button" type="button" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => cameraVideoRef.current?.click()}>录像</button></div><input ref={cameraPhotoRef} className="mobile-capture-input" type="file" accept="image/*" capture="environment" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="拍照上传" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} /><input ref={cameraVideoRef} className="mobile-capture-input" type="file" accept="video/*" capture="environment" disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="录像上传" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (!selected.length) return; setUploadOpen(false); void addFiles(selected) }} /></div>
      </div> : <div className="desktop-import-stack">
        <div className={`drop-zone${busy ? ' is-importing' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void addFiles(event.dataTransfer.files) }}>
          {busy ? <LoaderCircle className="spin" /> : <FileUp />}<strong>{busy ? '后台正在加入，可继续选择更多文件' : '选择或拖入任意文件'}</strong><span>照片、视频、文档、压缩包及其他文件类型都可进入同一上传队列；媒体原件中的可用时间、GPS 和技术元数据会被读取。</span>
          <input id="archive-upload-input" ref={inputRef} className="drop-zone-input" type="file" multiple disabled={storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} aria-label="选择照片、视频或文件" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (selected.length) void addFiles(selected) }} />
        </div>
        <div className="icloud-folder-import">
          <div><CloudDownload /><span><strong>文件夹 / iCloud Photos</strong><small>可选择 Windows 已同步的 iCloud Photos，也可选择普通文件夹。目录结构会尽量保留，所有项目统一执行 Hash 去重。</small></span></div>
          <button className="secondary-button" type="button" disabled={busy || storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available} onClick={() => folderRef.current?.click()}>选择文件夹</button>
          <input ref={folderRef} className="icloud-folder-input" type="file" multiple aria-label="选择文件夹或 iCloud Photos" onChange={(event) => { const selected = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = ''; if (selected.length) void addFiles(selected) }} />
        </div>
      </div>}
      <p className="upload-metadata-note">元数据策略：优先使用照片原件 EXIF 拍摄时间和 GPS；没有时再使用文件时间，最后才使用上传时间。浏览器没有暴露的 iOS 相册归属、人物识别等 Photos 内部数据库信息不会被伪造。</p>
      {importStatus && <div className="import-progress" role="status" aria-live="polite">
        <div><strong>{importStatus.phase === 'complete' ? (importStatus.error ? '部分文件未能写入本机队列' : '全部文件已写入本机恢复队列') : '正在写入本机恢复队列…'}</strong><span>本次已选择 {importStatus.total} 项 · 本机已保存 {importStatus.queued} 项 · 已检查 {importStatus.processed}/{importStatus.total}</span></div>
        <div className="progress"><i style={{ width: `${importStatus.total ? Math.round(importStatus.processed / importStatus.total * 100) : 0}%` }} /></div>
      </div>}
      {storageBackend === 'telegram_user_group' ? <div className="size-policy"><div><b>MTProto</b><span>原件不经过 Bot getFile</span></div><div><b>大文件</b><span>适用当前 Telegram 账户限制</span></div><div><b>恢复</b><span>由本机 Bridge 下载</span></div></div> : <div className="size-policy"><div><b>≤20 MB</b><span>Bot 存储可上传 / 恢复</span></div><div><b>&gt;20 MB</b><span>请切换私人群组</span></div><div><b>无 fallback</b><span>不会静默改存储后端</span></div></div>}
      {!online && <p className="offline-notice"><WifiOff />当前离线。文件已进入本机队列，恢复网络并打开 PWA 后会继续。</p>}
      {error && <p className="inline-error" role="alert">{error}</p>}
      <UploadQueue compact />
    </section>
  </div>
}
