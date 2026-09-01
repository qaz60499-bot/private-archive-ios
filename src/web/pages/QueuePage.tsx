import { Wifi } from 'lucide-react'
import { PageIntro } from '../components/States'
import { UploadQueue } from '../features/upload/UploadSheet'

export function QueuePage() {
  return <div className="page"><PageIntro eyebrow="Local queue · 09" title="网络中断，不中断收集" description="任务状态保存在本机恢复队列。iOS App 的 Bot 上传交给系统后台传输；网页和 Windows 继续使用断网恢复队列。" /><div className="queue-banner"><Wifi /><div><strong>恢复队列已启用</strong><span>iOS 可在锁屏或切换 App 后继续 Bot 上传；手动强制结束 App 后会在下次打开时恢复。</span></div></div><UploadQueue /></div>
}
