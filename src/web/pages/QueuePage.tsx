import { Wifi } from 'lucide-react'
import { PageIntro } from '../components/States'
import { UploadQueue } from '../features/upload/UploadSheet'

export function QueuePage() {
  return <div className="page"><PageIntro eyebrow="Local queue · 09" title="网络中断，不中断收集" description="任务状态保存在 IndexedDB，文件优先保存到 OPFS；恢复网络或重新打开 PWA 时继续。iOS 后台上传不被虚假承诺。" /><div className="queue-banner"><Wifi /><div><strong>前台恢复策略已启用</strong><span>支持 Background Sync 的浏览器还会注册一次同步请求。</span></div></div><UploadQueue /></div>
}
