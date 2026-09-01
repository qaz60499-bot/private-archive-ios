import { useEffect, useMemo, useState } from 'react'
import { Bot, Check, Circle, HardDrive, LoaderCircle, RefreshCw, Send, ShieldCheck } from 'lucide-react'
import { api } from '../lib/api'
import {
  publishUserGroupRuntime,
  syncUserGroupIntoArchive,
  telegramUserGroupBridge,
  type TelegramUserGroupBridgeStatus,
} from '../lib/telegram-user-group'
import type { IntegrationStatus, StorageBackend } from '../types'

function statusLabel(status: TelegramUserGroupBridgeStatus | null): string {
  if (!telegramUserGroupBridge.available) return 'Windows Bridge 不在当前页面'
  if (!status) return '正在读取本机 Bridge'
  if (status.connectionStatus === 'connected') return '已连接'
  if (status.connectionStatus === 'syncing') return '同步中'
  if (status.connectionStatus === 'auth_required') return '需要授权'
  if (status.connectionStatus === 'error') return '连接错误'
  return '已离线'
}

export function TelegramStorageSettings({ status, reloadStatus }: { status: IntegrationStatus; reloadStatus: () => Promise<void> }) {
  const [bridgeStatus, setBridgeStatus] = useState<TelegramUserGroupBridgeStatus | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [password, setPassword] = useState('')

  const defaultBackend = status.storage?.defaultStorageBackend ?? 'telegram_user_group'
  const userGroupRuntime = status.storage?.userGroup
  const bridgeConnected = bridgeStatus?.connectionStatus === 'connected'
  const botConfigured = status.telegram.tokenConfigured && status.telegram.storageChatConfigured
  const storageReady = defaultBackend === 'telegram_user_group' ? bridgeConnected : botConfigured

  const refreshBridge = async () => {
    if (!telegramUserGroupBridge.available) {
      setBridgeStatus(null)
      return null
    }
    const next = await telegramUserGroupBridge.status()
    setBridgeStatus(next)
    await publishUserGroupRuntime(next).catch(() => undefined)
    await reloadStatus().catch(() => undefined)
    return next
  }

  useEffect(() => {
    let active = true
    if (!telegramUserGroupBridge.available) return
    void telegramUserGroupBridge.status().then(async (next) => {
      if (!active) return
      setBridgeStatus(next)
      await publishUserGroupRuntime(next).catch(() => undefined)
      if (active) await reloadStatus().catch(() => undefined)
    }).catch((caught) => {
      if (active) setError(caught instanceof Error ? caught.message : 'TELEGRAM_STORAGE_BRIDGE_OFFLINE')
    })
    return () => { active = false }
    // reloadStatus is intentionally not a dependency: this should probe once per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const chooseDefault = async (backend: StorageBackend) => {
    setBusy(`default:${backend}`)
    setError(null)
    setMessage(null)
    try {
      await api.setStoragePreference(backend)
      await reloadStatus()
      setMessage(backend === 'telegram_user_group' ? '默认存储已设为 Telegram 私人群组。' : '默认存储已设为 Telegram Bot；单次上传仍可覆盖。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'STORAGE_PREFERENCE_UPDATE_FAILED')
    } finally {
      setBusy(null)
    }
  }

  const syncUserGroup = async () => {
    setBusy('sync-user-group')
    setError(null)
    setMessage(null)
    try {
      const result = await syncUserGroupIntoArchive()
      await refreshBridge()
      setMessage(`私人群组同步完成：扫描 ${result.scanned} 条，新建 ${result.created} 项，重复 ${result.duplicate} 项，待处理 ${result.pending} 项。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SYNC_FAILED')
    } finally {
      setBusy(null)
    }
  }

  const syncBot = async () => {
    setBusy('sync-bot')
    setError(null)
    setMessage(null)
    try {
      await api.listTelegramSources()
      await reloadStatus()
      setMessage('Bot 来源状态已刷新。Bot 文件继续由现有 webhook 实时入库；不会为了“手动同步”调用 getUpdates 干扰生产 webhook。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'BOT_SYNC_FAILED')
    } finally {
      setBusy(null)
    }
  }

  const syncAll = async () => {
    setBusy('sync-all')
    setError(null)
    setMessage(null)
    try {
      let userSummary = '私人群组 Bridge 未连接'
      if (telegramUserGroupBridge.available) {
        const current = await telegramUserGroupBridge.status()
        setBridgeStatus(current)
        if (current.connectionStatus === 'connected') {
          const result = await syncUserGroupIntoArchive()
          userSummary = `私人群组新建 ${result.created} / 重复 ${result.duplicate}`
        } else {
          await publishUserGroupRuntime(current).catch(() => undefined)
        }
      }
      await api.listTelegramSources()
      await reloadStatus()
      setMessage(`全部同步完成：${userSummary}；Bot 来源状态已刷新。`)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SYNC_FAILED')
    } finally {
      setBusy(null)
    }
  }

  const sendCode = async () => {
    if (!phone.trim()) return
    setBusy('auth-phone')
    setError(null)
    try {
      await telegramUserGroupBridge.sendCode(phone.trim())
      await refreshBridge()
      setMessage('验证码已发送到 Telegram。验证码不会写入日志或云端。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AUTH_REQUIRED')
    } finally {
      setBusy(null)
    }
  }

  const confirmCode = async () => {
    if (!code.trim()) return
    setBusy('auth-code')
    setError(null)
    try {
      const result = await telegramUserGroupBridge.confirmCode(code.trim())
      setCode('')
      await refreshBridge()
      setMessage(result.passwordRequired ? '该 Telegram 账号启用了 2FA，请输入密码完成授权。' : 'Telegram 用户账号授权完成。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AUTH_CODE_INVALID')
    } finally {
      setBusy(null)
    }
  }

  const confirmPassword = async () => {
    if (!password) return
    setBusy('auth-password')
    setError(null)
    try {
      await telegramUserGroupBridge.confirmPassword(password)
      setPassword('')
      await refreshBridge()
      setMessage('Telegram 用户账号授权完成，独立 storage session 已生效。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AUTH_PASSWORD_INVALID')
    } finally {
      setBusy(null)
    }
  }

  const reauthorize = async () => {
    setBusy('reauthorize')
    setError(null)
    setPhone('')
    setCode('')
    setPassword('')
    try {
      const next = await telegramUserGroupBridge.reauthorize()
      setBridgeStatus(next)
      await publishUserGroupRuntime(next).catch(() => undefined)
      await reloadStatus()
      setMessage('现有 storage session 已退出；可以重新授权。')
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'SESSION_REVOKED')
    } finally {
      setBusy(null)
    }
  }

  const authStep = bridgeStatus?.authStep
  const groupDetails = useMemo(() => {
    const chat = bridgeStatus?.storageChatTitle ?? userGroupRuntime?.storageChatTitle
    const chatId = bridgeStatus?.storageChatId ?? userGroupRuntime?.storageChatId
    const lastSync = bridgeStatus?.lastSyncAt ?? userGroupRuntime?.lastSyncAt
    return { chat, chatId, lastSync }
  }, [bridgeStatus, userGroupRuntime])

  return <div className="telegram-storage-settings">
    <div className={`storage-overview${storageReady ? ' ready' : ''}`}>
      <span>{storageReady ? <Check /> : <Circle />}</span>
      <div><strong>{storageReady ? '默认存储可用' : '默认存储需要处理'}</strong><small>新文件默认：{defaultBackend === 'telegram_user_group' ? 'Telegram 私人群组' : 'Telegram Bot'}</small></div>
    </div>

    <fieldset className="storage-default-choice">
      <legend>默认存储后端</legend>
      <label className={defaultBackend === 'telegram_user_group' ? 'active' : ''}><input type="radio" name="default-storage-backend" checked={defaultBackend === 'telegram_user_group'} disabled={Boolean(busy)} onChange={() => void chooseDefault('telegram_user_group')} /><HardDrive /><span><strong>Telegram 私人群组</strong><small>默认主存储 · 用户账号 / MTProto · 支持大文件</small></span></label>
      <label className={defaultBackend === 'telegram_bot' ? 'active' : ''}><input type="radio" name="default-storage-backend" checked={defaultBackend === 'telegram_bot'} disabled={Boolean(busy)} onChange={() => void chooseDefault('telegram_bot')} /><Bot /><span><strong>Telegram Bot</strong><small>兼容 / 备用 · 新文件仅允许安全可恢复范围</small></span></label>
    </fieldset>

    <div className="storage-backend-cards">
      <article className="storage-backend-card">
        <header><div><strong>Telegram 私人群组</strong><small>ai · User Group Storage</small></div><span className={`source-state ${bridgeConnected ? 'active' : 'disabled'}`}>{statusLabel(bridgeStatus)}</span></header>
        <dl><div><dt>账号</dt><dd>{bridgeStatus?.authorized ? '已授权' : '待授权'}</dd></div><div><dt>存储群</dt><dd>{groupDetails.chat ?? 'ai · 待 resolve'}</dd></div><div><dt>Chat ID</dt><dd>{groupDetails.chatId ?? '—'}</dd></div><div><dt>最后同步</dt><dd>{groupDetails.lastSync ? new Date(groupDetails.lastSync).toLocaleString() : '—'}</dd></div></dl>
        {!telegramUserGroupBridge.available ? <p className="settings-section-note">当前不是 Windows 本地客户端页面。私人群组原件上传/恢复依赖本机 Bridge；手机端可直接把文件发到 Telegram 的 ai 群。</p> : null}
        {telegramUserGroupBridge.available && authStep === 'phone' ? <div className="telegram-auth-row"><label><span>Telegram 手机号</span><input value={phone} onChange={(event) => setPhone(event.target.value)} autoComplete="tel" placeholder="+1… / +86…" /></label><button className="secondary-button" type="button" disabled={busy === 'auth-phone' || !phone.trim()} onClick={() => void sendCode()}>{busy === 'auth-phone' ? <LoaderCircle className="spin" /> : <Send />}发送验证码</button></div> : null}
        {telegramUserGroupBridge.available && authStep === 'code' ? <div className="telegram-auth-row"><label><span>Telegram 验证码</span><input value={code} onChange={(event) => setCode(event.target.value)} inputMode="numeric" autoComplete="one-time-code" placeholder="验证码" /></label><button className="secondary-button" type="button" disabled={busy === 'auth-code' || !code.trim()} onClick={() => void confirmCode()}>{busy === 'auth-code' ? <LoaderCircle className="spin" /> : <ShieldCheck />}确认验证码</button></div> : null}
        {telegramUserGroupBridge.available && authStep === 'password' ? <div className="telegram-auth-row"><label><span>Telegram 2FA 密码</span><input value={password} onChange={(event) => setPassword(event.target.value)} type="password" autoComplete="current-password" placeholder="仅发送到本机 Bridge" /></label><button className="secondary-button" type="button" disabled={busy === 'auth-password' || !password} onClick={() => void confirmPassword()}>{busy === 'auth-password' ? <LoaderCircle className="spin" /> : <ShieldCheck />}完成授权</button></div> : null}
        <div className="source-actions"><button className="secondary-button" type="button" disabled={!bridgeStatus?.authorized || Boolean(busy)} onClick={() => void syncUserGroup()}>{busy === 'sync-user-group' ? <LoaderCircle className="spin" /> : <RefreshCw />}{bridgeConnected ? '同步私人群组' : '重新解析 ai 群'}</button><button className="secondary-button" type="button" disabled={!telegramUserGroupBridge.available || Boolean(busy)} onClick={() => void reauthorize()}><ShieldCheck />重新授权</button></div>
      </article>

      <article className="storage-backend-card">
        <header><div><strong>Telegram Bot</strong><small>Legacy / optional storage</small></div><span className={`source-state ${botConfigured ? 'active' : 'disabled'}`}>{botConfigured ? '可用' : '待配置'}</span></header>
        <p className="settings-section-note">旧文件继续按 Bot Adapter 读取。新 Bot 文件超过安全恢复能力时会明确要求切换私人群组，不会自动 fallback，也不会产生“上传成功但无法恢复”的新数据。</p>
        <div className="source-actions"><button className="secondary-button" type="button" disabled={Boolean(busy)} onClick={() => void syncBot()}>{busy === 'sync-bot' ? <LoaderCircle className="spin" /> : <RefreshCw />}同步 Bot</button></div>
      </article>
    </div>

    <div className="storage-sync-actions"><button className="primary-button" type="button" disabled={Boolean(busy)} onClick={() => void syncAll()}>{busy === 'sync-all' ? <LoaderCircle className="spin" /> : <RefreshCw />}全部同步</button></div>
    {message ? <p className="settings-sync-message" role="status">{message}</p> : null}
    {error ? <p className="settings-inline-error" role="alert">{error}</p> : null}
  </div>
}
