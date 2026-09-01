import {
  Camera, CheckCircle2, FileUp, FolderOpen, LoaderCircle, LogOut, Pause, Play,
  RotateCcw, ShieldCheck, Trash2, UploadCloud, UserRound, Video, WifiOff, XCircle,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import { ImportToast } from '../components/ImportToast'
import { OfflineBadge } from '../components/UploadControls'
import { useArchive } from '../context/ArchiveContext'
import { api } from '../lib/api'
import { summarizeImportErrors } from '../lib/import-error-summary'
import { summarizeUploadBatches } from '../lib/offline/batch'
import {
  cancelLocalUpload, cancelUploadBatch, deleteUploadBatch, pauseLocalUpload, pauseUploadBatch, resumeLocalUpload,
  resumeUploadBatch, retryFailedUploadBatch, subscribeUploadScheduler,
} from '../lib/offline/processor'
import { listLocalUploads, removeLocalUpload } from '../lib/offline/store'
import { telegramUserGroupBridge } from '../lib/telegram-user-group'
import type { LocalUploadJob, StorageBackend } from '../types'

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / 1024 ** index
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
}

function metadataLabel(job: LocalUploadJob): string {
  if (job.prepareStatus === 'pending') return '等待读取'
  if (job.prepareStatus === 'preparing') return '读取中'
  if (job.prepareStatus === 'failed') return '读取失败'
  const metadata = job.metadata ?? {}
  const fields = [metadata.takenAt, metadata.latitude, metadata.longitude, metadata.width, metadata.height, metadata.metadata]
  return fields.some((value) => value !== undefined && value !== null) ? '已读取' : '已检查'
}

function hashLabel(job: LocalUploadJob): string {
  if (job.deduplicated) return '精确重复 · 已复用原件'
  if (!job.contentHash) return job.prepareStatus === 'failed' ? '未生成' : '计算中'
  return `${job.contentHash.slice(0, 10)}…`
}

function sourceLabel(job: LocalUploadJob): string {
  const media = job.mediaType === 'photo' ? '照片' : job.mediaType === 'video' ? '视频' : '文件'
  return `Web · ${media}`
}

function storageLabel(backend: StorageBackend): string {
  return backend === 'telegram_user_group' ? 'Telegram 私人群组' : 'Telegram Bot'
}

function jobStatusLabel(job: LocalUploadJob): string {
  if (job.controlState === 'canceled') return '已取消'
  if (job.controlState === 'paused') return '已暂停'
  if (job.status === 'failed') return job.error ?? '失败'
  if (job.status === 'done') return job.deduplicated ? '已完成 · 去重' : '已完成'
  if (job.nextAttemptAt) return `${job.error ?? '等待重试'} · ${new Date(job.nextAttemptAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`
  if (job.stage === 'preparing') return '读取元数据与 Hash'
  if (job.stage === 'reserving') return '核对重复内容'
  if (job.stage === 'original') return '上传原件'
  if (job.stage === 'preview') return '上传预览'
  return '等待处理'
}

function WebUploadQueue() {
  const [jobs, setJobs] = useState<LocalUploadJob[]>([])
  const reload = async () => setJobs(await listLocalUploads())

  useEffect(() => {
    void listLocalUploads().then(setJobs)
    const unsubscribe = subscribeUploadScheduler(() => void reload())
    const timer = window.setInterval(() => void reload(), 2_000)
    return () => { unsubscribe(); window.clearInterval(timer) }
  }, [])

  const batches = useMemo(() => summarizeUploadBatches(jobs), [jobs])
  if (!jobs.length) return <div className="web-queue-empty"><UploadCloud /><strong>还没有上传项目</strong><span>选择上方任一来源后，文件会先安全写入本机恢复队列。</span></div>

  return <div className="web-queue-list" aria-live="polite">
    {batches.map((batch) => {
      const unfinished = batch.total - batch.completed - batch.canceled
      return <section className="web-queue-batch" key={batch.id} aria-labelledby={`web-batch-${batch.id}`}>
        <header className="web-queue-batch-head">
          <div><strong id={`web-batch-${batch.id}`}>上传批次</strong><span>{new Date(batch.createdAt).toLocaleString('zh-CN')} · {batch.completed}/{batch.total} 完成{batch.failed ? ` · ${batch.failed} 失败` : ''}{batch.deduplicated ? ` · ${batch.deduplicated} 去重` : ''}</span></div>
          <b>{batch.progress}%</b>
        </header>
        <div className="web-queue-progress"><i style={{ width: `${batch.progress}%` }} /></div>
        <div className="web-queue-batch-actions">
          {unfinished > 0 && batch.paused < unfinished ? <button type="button" onClick={async () => { await pauseUploadBatch(batch.id); await reload() }}><Pause />暂停批次</button> : null}
          {batch.paused > 0 ? <button type="button" onClick={async () => { await resumeUploadBatch(batch.id); await reload() }}><Play />继续批次</button> : null}
          {batch.failed > 0 ? <button type="button" onClick={async () => { await retryFailedUploadBatch(batch.id); await reload() }}><RotateCcw />重试失败</button> : null}
          {unfinished > 0 ? <button type="button" onClick={async () => { await cancelUploadBatch(batch.id); await reload() }}><XCircle />取消未完成</button> : null}
          <button type="button" onClick={async () => {
            if (!window.confirm('删除这个上传批次的本机记录？未完成任务会先取消；已经成功保存到图库的文件不会被删除。')) return
            await deleteUploadBatch(batch.id)
            await reload()
          }}><Trash2 />删除批次</button>
        </div>
        <div className="web-queue-items">
          {batch.jobs.map((job) => <article className={`web-queue-item ${job.status}`} key={job.id}>
            <div className="web-queue-item-main">
              <span className="web-queue-state-icon">{job.status === 'done' ? <CheckCircle2 /> : ['uploading', 'retrying'].includes(job.status) || job.prepareStatus === 'preparing' ? <LoaderCircle className="spin" /> : job.controlState === 'paused' ? <Pause /> : <FileUp />}</span>
              <div className="web-queue-file"><strong title={job.fileName}>{job.fileName}</strong><span>{jobStatusLabel(job)}</span></div>
              <b className="web-queue-percent">{job.progress}%</b>
            </div>
            <div className="web-queue-progress item"><i style={{ width: `${job.progress}%` }} /></div>
            <dl className="web-queue-meta">
              <div><dt>大小</dt><dd>{formatBytes(job.sizeBytes)}</dd></div>
              <div><dt>来源</dt><dd>{sourceLabel(job)}</dd></div>
              <div><dt>存储</dt><dd>{storageLabel(job.storageBackend)}</dd></div>
              <div><dt>元数据</dt><dd>{metadataLabel(job)}</dd></div>
              <div><dt>Hash / 去重</dt><dd>{hashLabel(job)}</dd></div>
            </dl>
            <div className="web-queue-item-actions">
              {job.controlState === 'paused' || job.status === 'failed' && job.controlState !== 'canceled'
                ? <button type="button" onClick={async () => { await resumeLocalUpload(job.id); await reload() }}><Play />继续</button>
                : job.status !== 'done' && job.controlState !== 'canceled' ? <button type="button" onClick={async () => { await pauseLocalUpload(job.id); await reload() }}><Pause />暂停</button> : null}
              {job.status !== 'done' && job.controlState !== 'canceled' ? <button type="button" onClick={async () => { await cancelLocalUpload(job.id); await reload() }}><XCircle />取消</button> : null}
              {job.status === 'done' || job.controlState === 'canceled' ? <button type="button" onClick={async () => { await removeLocalUpload(job.id); await reload() }}><Trash2 />移除</button> : null}
            </div>
          </article>)}
        </div>
      </section>
    })}
  </div>
}

export function WebUploadPage() {
  const { online, importStatus, runImport } = useArchive()
  const [storageBackend, setStorageBackend] = useState<StorageBackend>('telegram_user_group')
  const [activeImports, setActiveImports] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const folderRef = useRef<HTMLInputElement>(null)
  const coarsePointer = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
  const compactViewport = typeof matchMedia === 'function' && matchMedia('(max-width: 900px)').matches
  const mobile = coarsePointer || compactViewport || navigator.maxTouchPoints > 1
  const userGroupUnavailable = storageBackend === 'telegram_user_group' && !telegramUserGroupBridge.available
  const directPickerDisabled = userGroupUnavailable
  const busy = activeImports > 0 || Boolean(importStatus?.active)

  useEffect(() => {
    let active = true
    void api.storagePreference().then((result) => {
      if (active) setStorageBackend(result.defaultStorageBackend)
    }).catch(() => undefined)
    return () => { active = false }
  }, [])

  useEffect(() => {
    if (!folderRef.current) return
    folderRef.current.setAttribute('webkitdirectory', '')
    folderRef.current.setAttribute('directory', '')
  }, [mobile])

  const addFiles = async (files: FileList | File[]) => {
    const selected = Array.from(files)
    if (!selected.length) return
    if (userGroupUnavailable) {
      setError('此浏览器不能直接写入 Telegram 私人群组。请先明确切换“本次上传”到 Telegram Bot，或把大文件分享到 Telegram 的 ai 私人群组。')
      return
    }
    setActiveImports((count) => count + 1)
    setError(null)
    try {
      const result = await runImport(selected, { mobile, storageBackend })
      if (result?.errors.length) setError(summarizeImportErrors(result.errors))
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '无法加入上传队列')
    } finally {
      setActiveImports((count) => Math.max(0, count - 1))
    }
  }

  const onInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.currentTarget.files ?? [])
    event.currentTarget.value = ''
    if (selected.length) void addFiles(selected)
  }

  return <main className="web-upload-shell">
    <section className="web-upload-card" aria-labelledby="web-upload-title">
      <header className="web-upload-head">
        <div className="web-upload-brand"><span className="web-upload-mark"><UploadCloud /></span><div><p className="eyebrow">PRIVATE ARCHIVE</p><h1 id="web-upload-title">Upload Portal</h1><p className="web-upload-subtitle">安全上传照片、视频和文件到私人档案。</p></div></div>
        <div className="web-upload-account">
          <span className="web-upload-user"><UserRound /><span><strong>Owner</strong><small>Cloudflare Access 已验证</small></span></span>
          <button className="secondary-button" type="button" onClick={() => { window.location.assign('/cdn-cgi/access/logout') }}><LogOut />退出 Access</button>
        </div>
      </header>

      <section className="web-upload-storage" aria-labelledby="web-storage-title">
        <div className="web-upload-section-title"><h2 id="web-storage-title">本次上传存储到</h2><p>不会因为浏览器能力不足而静默更换存储后端。</p></div>
        <div className="web-storage-options" role="radiogroup" aria-label="本次上传存储后端">
          <label className={storageBackend === 'telegram_user_group' ? 'active' : ''}><input type="radio" name="web-storage" checked={storageBackend === 'telegram_user_group'} onChange={() => { setStorageBackend('telegram_user_group'); setError(null) }} /><span><strong>Telegram 私人群组</strong><small>默认主存储 · Windows 客户端通过 Telegram Storage Bridge 直写</small></span></label>
          <label className={storageBackend === 'telegram_bot' ? 'active' : ''}><input type="radio" name="web-storage" checked={storageBackend === 'telegram_bot'} onChange={() => { setStorageBackend('telegram_bot'); setError(null) }} /><span><strong>Telegram Bot</strong><small>网页可直接上传 · 当前仅建议单文件 ≤20 MB</small></span></label>
        </div>
        {userGroupUnavailable ? <div className="web-storage-warning" role="status"><WifiOff /><div><strong>手机 / 普通浏览器无法直接写 Telegram 私人群组</strong><span>现有真实架构要求 Windows Telegram Storage Bridge。要在当前网页直接上传，请明确选择 Telegram Bot；大文件可分享到 Telegram 的 <b>ai</b> 私人群组，再由 Windows 客户端同步导入。</span></div><button type="button" className="secondary-button" onClick={() => { setStorageBackend('telegram_bot'); setError(null) }}>本次改用 Bot</button></div> : null}
      </section>

      <section className="web-upload-sources" aria-labelledby="web-sources-title">
        <div className="web-upload-section-title web-source-title"><div><h2 id="web-sources-title">选择上传来源</h2><p>页面本身就是上传器。无需打开其他菜单或弹窗。</p></div><OfflineBadge /></div>
        <div className={`web-source-grid${directPickerDisabled ? ' blocked' : ''}`}>
          <label className="web-source-card primary-source">
            <FileUp /><span><strong>照片 / iCloud Photos</strong><small>iPhone、iPad、Android 或电脑照片，多选；HEIC / HEIF / JPEG / PNG / WebP 等原件均可。</small></span>
            <input id="web-photo-input" type="file" multiple accept="image/*" disabled={directPickerDisabled} aria-label="选择照片 / iCloud Photos" onChange={onInput} />
          </label>
          <label className="web-source-card">
            <Video /><span><strong>视频</strong><small>从系统照片库或文件提供器多选视频，进入同一 Hash、恢复和重试队列。</small></span>
            <input id="web-video-input" type="file" multiple accept="video/*" disabled={directPickerDisabled} aria-label="选择视频" onChange={onInput} />
          </label>
          <label className="web-source-card">
            <FolderOpen /><span><strong>文件 / iCloud Drive</strong><small>不限制固定扩展名。iOS Files 可访问 iCloud Drive、本机和已接入的第三方文件提供器。</small></span>
            <input id="web-file-input" type="file" multiple disabled={directPickerDisabled} aria-label="选择文件 / iCloud Drive" onChange={onInput} />
          </label>
          {mobile ? <>
            <label className="web-source-card compact-source">
              <Camera /><span><strong>拍照</strong><small>调用设备后置相机。</small></span>
              <input id="web-camera-input" type="file" accept="image/*" capture="environment" disabled={directPickerDisabled} aria-label="拍照上传" onChange={onInput} />
            </label>
            <label className="web-source-card compact-source">
              <Video /><span><strong>录像</strong><small>调用设备后置摄像头。</small></span>
              <input id="web-record-input" type="file" accept="video/*" capture="environment" disabled={directPickerDisabled} aria-label="录像上传" onChange={onInput} />
            </label>
          </> : null}
        </div>

        {!mobile ? <div className="web-desktop-sources">
          <div className={`web-drop-zone${directPickerDisabled ? ' disabled' : ''}`} onDragOver={(event) => { if (!directPickerDisabled) event.preventDefault() }} onDrop={(event) => { if (directPickerDisabled) return; event.preventDefault(); void addFiles(event.dataTransfer.files) }}>
            <UploadCloud /><div><strong>拖拽文件到这里</strong><span>照片、视频、文档、压缩包及其他任意文件类型均可。</span></div>
          </div>
          <label className={`web-folder-picker${directPickerDisabled ? ' disabled' : ''}`}><FolderOpen /><span><strong>选择文件夹</strong><small>支持浏览器的目录选择，可直接选 Windows iCloud Photos 已同步目录或其他本地云盘目录。</small></span><input ref={folderRef} type="file" multiple disabled={directPickerDisabled} aria-label="选择文件夹" onChange={onInput} /></label>
        </div> : null}

        <div className="web-metadata-note"><ShieldCheck /><span><strong>原件元数据会在上传前读取</strong><small>优先 EXIF 拍摄时间，其次文件原始时间；保存可用 GPS 经纬度、高度、相机/镜头、方向、ISO、光圈、曝光、焦距、尺寸以及文件自身提供的地点字段。浏览器未暴露的 Apple Photos 相册归属、人物、Memories、Favorites 不会被伪造。</small></span></div>
        {!online ? <div className="web-offline-note"><WifiOff /><span><strong>当前离线</strong><small>选择的原件仍会先进入 IndexedDB / OPFS 本机恢复队列；联网后继续。</small></span></div> : null}
        {busy || importStatus ? <div className="web-import-status" role="status" aria-live="polite"><div><span>{busy ? <LoaderCircle className="spin" /> : <CheckCircle2 />}</span><div><strong>{importStatus?.phase === 'complete' ? importStatus.error ? '部分文件未加入队列' : '已写入本机恢复队列' : '正在写入本机恢复队列'}</strong><small>{importStatus ? `已选择 ${importStatus.total} 项 · 本机已保存 ${importStatus.queued} 项 · 已检查 ${importStatus.processed}/${importStatus.total}` : '正在准备文件…'}</small></div></div>{importStatus ? <div className="web-queue-progress"><i style={{ width: `${importStatus.total ? Math.round(importStatus.processed / importStatus.total * 100) : 0}%` }} /></div> : null}</div> : null}
        {error ? <p className="inline-error web-upload-error" role="alert">{error}</p> : null}
      </section>

      <section className="web-upload-queue" aria-label="上传队列">
        <div className="web-upload-section-title"><h2>上传队列</h2><p>显示大小、来源、元数据、Hash / 去重、进度和恢复控制。完成后原件临时 payload 会自动释放。</p></div>
        <WebUploadQueue />
      </section>
    </section>
    <ImportToast />
  </main>
}
