import { useEffect, useState } from 'react'
import { Bot, Check, Circle, Cloud, Database, KeyRound, LoaderCircle, LockKeyhole, ScanSearch, Send, ShieldCheck, Workflow } from 'lucide-react'
import { api } from '../lib/api'
import type { IntegrationStatus, TelegramDiscovery } from '../types'
import { PageIntro, SkeletonGrid } from '../components/States'

function StatusLine({ ok, label, detail, Icon }: { ok: boolean; label: string; detail: string; Icon: typeof Bot }) {
  return <li><span className={`status-dot${ok ? ' ok' : ''}`}>{ok ? <Check /> : <Circle />}</span><Icon /><div><strong>{label}</strong><small>{detail}</small></div></li>
}

export function SettingsPage() {
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<TelegramDiscovery | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [configuringChatId, setConfiguringChatId] = useState<string | null>(null)

  const loadStatus = async () => {
    setStatusError(null)
    try {
      setStatus(await api.settings())
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'SETTINGS_LOAD_FAILED')
    }
  }

  const reauthenticateAccess = async () => {
    if ('serviceWorker' in navigator) {
      const registrations = await navigator.serviceWorker.getRegistrations()
      await Promise.all(registrations.map((registration) => registration.unregister()))
    }
    if ('caches' in window) {
      const cacheNames = await caches.keys()
      await Promise.all(cacheNames.map((cacheName) => caches.delete(cacheName)))
    }
    window.location.reload()
  }

  useEffect(() => {
    let active = true
    void api.settings().then((nextStatus) => {
      if (active) setStatus(nextStatus)
    }).catch((error) => {
      if (active) setStatusError(error instanceof Error ? error.message : 'SETTINGS_LOAD_FAILED')
    })
    return () => { active = false }
  }, [])

  const configureTelegram = async (chatId: string, role: 'owner' | 'storage' | 'both') => {
    setConfiguringChatId(chatId)
    setDiscoveryError(null)
    try {
      await api.configureTelegram(chatId, role)
      setStatus(await api.settings())
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'TELEGRAM_CONFIGURE_FAILED')
    } finally {
      setConfiguringChatId(null)
    }
  }

  const discoverTelegram = async () => {
    setDiscovering(true)
    setDiscoveryError(null)
    try {
      setDiscovery(await api.discoverTelegram())
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'TELEGRAM_DISCOVERY_FAILED')
    } finally {
      setDiscovering(false)
    }
  }
  if (!status) {
    if (statusError) return <div className="page"><PageIntro eyebrow="System · 10" title="私人档案的边界" description="设置接口没有成功返回。开启 Cloudflare Access 后，旧的 PWA 缓存可能仍在提供页面外壳。" /><section className="error-state" role="alert"><ShieldCheck /><h2>需要重新验证访问权限</h2><p>{statusError}</p><div className="settings-error-actions"><button className="primary-button" type="button" onClick={() => void reauthenticateAccess()}>重新验证 Cloudflare Access</button><button className="secondary-button" type="button" onClick={() => void loadStatus()}>重新尝试</button></div></section></div>
    return <div className="page"><SkeletonGrid /></div>
  }
  const telegramReady = Object.values(status.telegram).every(Boolean)
  return <div className="page"><PageIntro eyebrow="System · 10" title="私人档案的边界" description="这里展示绑定状态，不接受、不保存也不回显 Bot Token。真实凭据只能从 Cloudflare Secret 注入。" /><div className="settings-layout"><section className="setup-panel"><header><Bot /><div><p className="eyebrow">Telegram bridge</p><h2>{status.mockMode ? 'Mock 模式' : telegramReady ? '已连接' : '等待配置'}</h2></div></header><ol className="setup-list">
    <StatusLine ok={status.telegram.tokenConfigured} Icon={KeyRound} label="Bot Token" detail={status.telegram.tokenConfigured ? '已通过 Secret 配置' : '运行 wrangler secret put TELEGRAM_BOT_TOKEN'} />
    <StatusLine ok={status.telegram.ownerConfigured} Icon={ShieldCheck} label="Owner User ID" detail="只接受本人私聊消息" />
    <StatusLine ok={status.telegram.storageChatConfigured} Icon={Send} label="Storage Channel" detail="原件与小预览存入私人频道" />
    <StatusLine ok={status.telegram.webhookSecretConfigured} Icon={LockKeyhole} label="Webhook Secret" detail="验证 Telegram Secret Header" />
    <StatusLine ok={status.d1.configured} Icon={Database} label="D1 migrations" detail="只保存索引与关系，无媒体 Blob" />
    <StatusLine ok={status.queue.configured} Icon={Workflow} label="Queue" detail="异步分析、重试与归一化" />
    <StatusLine ok={status.ai.configured} Icon={Cloud} label="Workers AI" detail="仅分析小尺寸 preview" />
    <StatusLine ok={status.access.configured} Icon={ShieldCheck} label="Cloudflare Access JWT" detail="校验签名、AUD、Team Domain 与 Owner 邮箱" />
  </ol><div className="telegram-discovery"><div><p className="eyebrow">Telegram discovery</p><p>Webhook 会持续记录 Bot 收到的私聊与频道。先给 Bot 发 /start；私人频道则发一条消息，再点刷新即可。这里不会停用 Webhook，也不会调用 getUpdates。</p></div><button className="secondary-button" type="button" onClick={() => void discoverTelegram()} disabled={discovering}>{discovering ? <LoaderCircle className="spin" /> : <ScanSearch />}{discovering ? '刷新中' : '刷新 Telegram'}</button>{discoveryError ? <p className="telegram-discovery-error" role="alert">{discoveryError}</p> : null}{discovery ? <div className="telegram-discovery-result"><strong>Bot：{discovery.bot.username ? `@${discovery.bot.username}` : discovery.bot.firstName ?? discovery.bot.id}</strong>{discovery.chats.length ? <ul>{discovery.chats.map((chat) => <li key={chat.id}><span>{chat.type === 'private' ? '私聊' : chat.type}</span><code>{chat.id}</code><small>{chat.title ?? chat.firstName ?? chat.username ?? '未命名'}</small><div className="telegram-chat-actions">{chat.type === 'private' ? <button className="secondary-button" type="button" disabled={configuringChatId === chat.id} onClick={() => void configureTelegram(chat.id, 'both')}>{configuringChatId === chat.id ? <LoaderCircle className="spin" /> : <Check />}设为本人 + 存储</button> : <button className="secondary-button" type="button" disabled={configuringChatId === chat.id} onClick={() => void configureTelegram(chat.id, 'storage')}>{configuringChatId === chat.id ? <LoaderCircle className="spin" /> : <Send />}设为存储位置</button>}</div></li>)}</ul> : <p>暂时没有发现聊天。给 Bot 发 /start；如果要使用私人频道，把 Bot 加入频道并发一条消息，然后再刷新。</p>}</div> : null}</div></section><section className="policy-panel"><p className="eyebrow">Storage contract</p><h2>清楚的容量策略</h2><div className="policy-scale"><div><strong>20</strong><span>MB 内网页完整读取</span></div><i /><div><strong>48</strong><span>MB 内 Telegram 保存</span></div></div><ul><li>Telegram 私人频道不是 Secret Chat。</li><li>Cloudflare Access 应保护整个生产域名。</li><li>Token 不进入前端、Git 或 D1。</li><li>首版不做文件级端到端加密。</li></ul></section></div></div>
}
