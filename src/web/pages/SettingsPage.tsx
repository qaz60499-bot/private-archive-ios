import { useEffect, useState } from 'react'
import { Bot, Check, Circle, Cloud, Copy, Database, HardDrive, KeyRound, Link2, LoaderCircle, LockKeyhole, Plus, RotateCw, ScanSearch, Send, ShieldCheck, Trash2, Unplug, UserRound, Workflow } from 'lucide-react'
import { PageIntro, SkeletonGrid } from '../components/States'
import { TelegramStorageSettings } from '../components/TelegramStorageSettings'
import { useAuth } from '../context/AuthContext'
import { api } from '../lib/api'
import { reauthenticateAccess } from '../lib/access-session'
import type { Album, AppAccessGrant, AppAccount, Asset, IntegrationStatus, ShareLink, TelegramDiscovery, TelegramSource } from '../types'

function StatusLine({ ok, label, detail, Icon }: { ok: boolean; label: string; detail: string; Icon: typeof Bot }) {
  return <li><span className={`status-dot${ok ? ' ok' : ''}`}>{ok ? <Check /> : <Circle />}</span><Icon /><div><strong>{label}</strong><small>{detail}</small></div></li>
}

function ConnectionSummary({ status }: { status: IntegrationStatus }) {
  const userGroupReady = status.storage?.userGroup.connectionStatus === 'connected' && status.storage.userGroup.storageChatTitle === 'ai'
  const botReady = status.telegram.tokenConfigured && status.telegram.storageChatConfigured
  const telegramReady = (status.storage?.defaultStorageBackend ?? 'telegram_user_group') === 'telegram_user_group' ? userGroupReady : botReady
  const archiveReady = telegramReady && status.d1.configured && status.access.configured
  return <div className="settings-connection-summary">
    <div className={`connection-state${archiveReady ? ' ready' : ''}`}><span>{archiveReady ? <Check /> : <Circle />}</span><div><p className="eyebrow">ARCHIVE CONNECTION</p><h2>{archiveReady ? '私人档案已连接' : '连接尚未完成'}</h2><small>{archiveReady ? '索引、私人存储与访问边界均已就绪。' : '展开高级诊断可查看具体缺少的绑定。'}</small></div></div>
    <dl>
      <div><dt>存储</dt><dd>{telegramReady ? 'Telegram · 已连接' : 'Telegram · 待配置'}</dd></div>
      <div><dt>索引</dt><dd>{status.d1.configured ? 'D1 · 正常' : 'D1 · 未连接'}</dd></div>
      <div><dt>访问</dt><dd>{status.access.configured ? 'Cloudflare Access · 已保护' : 'Access · 待配置'}</dd></div>
    </dl>
  </div>
}

export function SettingsPage() {
  const { user } = useAuth()
  const isOwner = user?.role === 'OWNER'
  const [status, setStatus] = useState<IntegrationStatus | null>(null)
  const [statusError, setStatusError] = useState<string | null>(null)
  const [discovery, setDiscovery] = useState<TelegramDiscovery | null>(null)
  const [discovering, setDiscovering] = useState(false)
  const [discoveryError, setDiscoveryError] = useState<string | null>(null)
  const [configuringChatId, setConfiguringChatId] = useState<string | null>(null)
  const [savingTrashPolicy, setSavingTrashPolicy] = useState(false)
  const [sources, setSources] = useState<TelegramSource[]>([])
  const [shares, setShares] = useState<ShareLink[]>([])
  const [albums, setAlbums] = useState<Album[]>([])
  const [shareAssets, setShareAssets] = useState<Asset[]>([])
  const [sourceName, setSourceName] = useState('')
  const [sourceToken, setSourceToken] = useState('')
  const [addingSource, setAddingSource] = useState(false)
  const [activeSourceDiscoveryId, setActiveSourceDiscoveryId] = useState<string | null>(null)
  const [sourceChats, setSourceChats] = useState<TelegramDiscovery['chats']>([])
  const [shareName, setShareName] = useState('')
  const [shareScopeType, setShareScopeType] = useState<'source' | 'album' | 'asset'>('source')
  const [shareScopeId, setShareScopeId] = useState('')
  const [shareDownload, setShareDownload] = useState(false)
  const [shareExpiry, setShareExpiry] = useState<1 | 7 | 30 | null>(7)
  const [shareUrl, setShareUrl] = useState<string | null>(null)
  const [savingShare, setSavingShare] = useState(false)
  const [accounts, setAccounts] = useState<AppAccount[]>([])
  const [accountUsername, setAccountUsername] = useState('')
  const [accountDisplayName, setAccountDisplayName] = useState('')
  const [accountPassword, setAccountPassword] = useState('')
  const [accountPreset, setAccountPreset] = useState<'FULL' | 'VIEWER' | 'UPLOAD_ONLY'>('VIEWER')
  const [savingAccount, setSavingAccount] = useState(false)
  const [savingAccessId, setSavingAccessId] = useState<string | null>(null)
  const [resetAllPassword, setResetAllPassword] = useState('')
  const [resettingAllPasswords, setResettingAllPasswords] = useState(false)
  const [accountResetMessage, setAccountResetMessage] = useState<string | null>(null)

  const loadStatus = async () => {
    setStatusError(null)
    try {
      setStatus(await api.settings())
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'SETTINGS_LOAD_FAILED')
    }
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

  useEffect(() => {
    if (!isOwner) return
    let active = true
    void Promise.all([
      api.listTelegramSources(),
      api.listShares(),
      api.listAlbums(),
      api.listAssets(new URLSearchParams({ limit: '60' })),
      api.listAccounts(),
    ]).then(([sourceResponse, shareResponse, albumResponse, assetResponse, accountResponse]) => {
      if (!active) return
      setSources(sourceResponse.items)
      setShares(shareResponse.items)
      setAlbums(albumResponse.items)
      setShareAssets(assetResponse.items)
      setAccounts(accountResponse.items)
      setShareScopeId(sourceResponse.items[0]?.id ?? '')
    }).catch((error) => {
      if (active) setStatusError(error instanceof Error ? error.message : 'SETTINGS_MANAGEMENT_LOAD_FAILED')
    })
    return () => { active = false }
  }, [isOwner])

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

  const refreshSources = async () => setSources((await api.listTelegramSources()).items)
  const refreshShares = async () => setShares((await api.listShares()).items)
  const refreshAccounts = async () => setAccounts((await api.listAccounts()).items)

  const createAccount = async () => {
    if (!accountUsername.trim() || !accountDisplayName.trim() || accountPassword.length < 9) return
    setSavingAccount(true)
    setStatusError(null)
    try {
      await api.createAccount(accountUsername.trim(), accountDisplayName.trim(), accountPassword, accountPreset)
      setAccountUsername('')
      setAccountDisplayName('')
      setAccountPassword('')
      setAccountPreset('VIEWER')
      await refreshAccounts()
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'ACCOUNT_CREATE_FAILED')
    } finally {
      setSavingAccount(false)
    }
  }

  const resetAllPasswords = async () => {
    if (resetAllPassword.length < 9) return
    setResettingAllPasswords(true)
    setStatusError(null)
    setAccountResetMessage(null)
    try {
      const result = await api.resetAllAccountPasswords(resetAllPassword)
      setResetAllPassword('')
      setAccountResetMessage(`已统一重置 ${result.count} 个账号密码，旧登录会话已失效。`)
      window.setTimeout(() => window.location.reload(), 700)
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'ACCOUNT_PASSWORD_RESET_FAILED')
    } finally {
      setResettingAllPasswords(false)
    }
  }

  const toggleAccountStatus = async (account: AppAccount) => {
    if (account.role === 'OWNER') return
    await api.updateAccount(account.id, { status: account.status === 'ACTIVE' ? 'DISABLED' : 'ACTIVE' })
    await refreshAccounts()
  }

  const saveAccountAccess = async (account: AppAccount, input: { accessPreset: 'FULL' | 'VIEWER' | 'UPLOAD_ONLY' } | { grants: AppAccessGrant[] }) => {
    if (account.role === 'OWNER') return
    setSavingAccessId(account.id)
    setStatusError(null)
    try {
      await api.updateAccountAccess(account.id, input)
      await refreshAccounts()
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'ACCOUNT_ACCESS_UPDATE_FAILED')
    } finally {
      setSavingAccessId(null)
    }
  }

  const accountHasGrant = (account: AppAccount, scopeType: AppAccessGrant['scopeType'], scopeId: string, permission: AppAccessGrant['permission']) => account.grants.some((grant) => grant.scopeType === scopeType && grant.scopeId === scopeId && grant.permission === permission)

  const toggleAccountCapability = async (account: AppAccount, permission: 'download' | 'upload' | 'edit' | 'delete') => {
    const exists = accountHasGrant(account, 'workspace', 'personal', permission)
    const grants = exists
      ? account.grants.filter((grant) => !(grant.scopeType === 'workspace' && grant.scopeId === 'personal' && grant.permission === permission))
      : [...account.grants, { scopeType: 'workspace' as const, scopeId: 'personal', permission }]
    await saveAccountAccess(account, { grants })
  }

  const toggleAllLibraryRead = async (account: AppAccount) => {
    const enabled = accountHasGrant(account, 'workspace', 'personal', 'read')
    const grants = account.grants.filter((grant) => grant.permission !== 'read')
    if (!enabled) grants.push({ scopeType: 'workspace', scopeId: 'personal', permission: 'read' })
    await saveAccountAccess(account, { grants })
  }

  const toggleReadScope = async (account: AppAccount, scopeType: 'source' | 'album', scopeId: string) => {
    const exists = accountHasGrant(account, scopeType, scopeId, 'read')
    const grants = account.grants.filter((grant) => !(grant.permission === 'read' && grant.scopeType === 'workspace'))
    const filtered = grants.filter((grant) => !(grant.permission === 'read' && grant.scopeType === scopeType && grant.scopeId === scopeId))
    if (!exists) filtered.push({ scopeType, scopeId, permission: 'read' })
    await saveAccountAccess(account, { grants: filtered })
  }

  const addTelegramSource = async () => {
    if (!sourceName.trim() || !sourceToken.trim()) return
    setAddingSource(true)
    setDiscoveryError(null)
    try {
      await api.createTelegramSource(sourceName.trim(), sourceToken.trim())
      setSourceName('')
      setSourceToken('')
      await refreshSources()
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'TELEGRAM_SOURCE_CREATE_FAILED')
    } finally {
      setAddingSource(false)
    }
  }

  const discoverSource = async (sourceId: string) => {
    setActiveSourceDiscoveryId(sourceId)
    setDiscoveryError(null)
    try {
      const result = await api.discoverTelegramSource(sourceId)
      setSourceChats(result.chats)
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'TELEGRAM_SOURCE_DISCOVERY_FAILED')
    }
  }

  const bindSource = async (sourceId: string, chatId: string) => {
    setConfiguringChatId(chatId)
    setDiscoveryError(null)
    try {
      await api.bindTelegramSource(sourceId, chatId)
      await refreshSources()
      setSourceChats([])
      setActiveSourceDiscoveryId(null)
    } catch (error) {
      setDiscoveryError(error instanceof Error ? error.message : 'TELEGRAM_SOURCE_BIND_FAILED')
    } finally {
      setConfiguringChatId(null)
    }
  }

  const toggleSource = async (source: TelegramSource) => {
    await api.setTelegramSourceEnabled(source.id, !source.enabled)
    await refreshSources()
  }

  const disconnectSource = async (source: TelegramSource) => {
    await api.disconnectTelegramSource(source.id)
    await refreshSources()
  }

  const createShare = async () => {
    if (!shareName.trim() || !shareScopeId) return
    setSavingShare(true)
    setStatusError(null)
    try {
      const result = await api.createShare({
        name: shareName.trim(), scopeType: shareScopeType, scopeId: shareScopeId,
        allowDownload: shareDownload, expiresInDays: shareExpiry,
      })
      setShareUrl(result.url)
      setShareName('')
      await refreshShares()
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'SHARE_CREATE_FAILED')
    } finally {
      setSavingShare(false)
    }
  }

  const scopeOptions = shareScopeType === 'source'
    ? sources.map((source) => ({ id: source.id, label: source.displayName }))
    : shareScopeType === 'album'
      ? albums.map((album) => ({ id: album.id, label: album.name }))
      : shareAssets.map((asset) => ({ id: asset.id, label: asset.originalName }))

  if (!status) {
    if (statusError) {
      const accessExpired = statusError === 'ACCESS_SIGN_IN_REQUIRED' || statusError === 'OWNER_AUTH_REQUIRED'
      return <div className="page"><PageIntro eyebrow="SETTINGS · PRIVATE ARCHIVE" title="设置" description={accessExpired ? '当前访问会话需要重新验证。' : '设置服务暂时没有成功返回；这不代表 Cloudflare Access 一定失效。'} /><section className="error-state" role="alert"><ShieldCheck /><h2>{accessExpired ? '需要重新验证访问权限' : '设置服务暂时不可用'}</h2><p>{statusError}</p><div className="settings-error-actions">{accessExpired ? <button className="primary-button" type="button" onClick={() => reauthenticateAccess()}>重新验证 Cloudflare Access</button> : null}<button className="secondary-button" type="button" onClick={() => void loadStatus()}>重新尝试</button></div></section></div>
    }
    return <div className="page"><SkeletonGrid /></div>
  }

  const usage = status.usage
  const trashRetention = status.trash?.retentionDays ?? null
  const updateTrashPolicy = async (value: 7 | 30 | 90 | 'never') => {
    setSavingTrashPolicy(true)
    setStatusError(null)
    try {
      const result = await api.setTrashPolicy(value)
      setStatus((current) => current ? { ...current, trash: { ...(current.trash ?? { retentionDays: null }), retentionDays: result.retentionDays } } : current)
      await loadStatus()
    } catch (error) {
      setStatusError(error instanceof Error ? error.message : 'TRASH_POLICY_UPDATE_FAILED')
    } finally {
      setSavingTrashPolicy(false)
    }
  }

  return <div className="page settings-page">
    <PageIntro eyebrow="SETTINGS · PRIVATE ARCHIVE" title="设置" description="日常只需要管理档案、存储和回收站。工程级绑定与诊断信息收在高级区域，不再占据设置首页。" />

    <nav className="settings-section-nav" aria-label="设置分区">
      <a href="#settings-archive">档案</a>{isOwner ? <><a href="#settings-storage">存储</a><a href="#settings-accounts">账号</a><a href="#settings-sources">Telegram 来源</a><a href="#settings-sharing">共享</a><a href="#settings-trash">回收站</a></> : null}<a href="#settings-connections">连接</a>{isOwner ? <a href="#settings-advanced">高级</a> : null}
    </nav>

    {statusError ? <p className="settings-inline-error" role="alert">设置更新未完成：{statusError}</p> : null}

    <div className="settings-product-layout">
      <section id="settings-archive" className="settings-product-section">
        <header><div><p className="eyebrow">ARCHIVE</p><h2>你的档案</h2></div><HardDrive /></header>
        {usage ? <><div className="usage-metrics"><div><strong>{usage.photoCount}</strong><span>照片</span></div><div><strong>{usage.fileCount}</strong><span>文件</span></div><div><strong>{(usage.storageBytes / 1024 / 1024).toFixed(1)}</strong><span>MB 原件索引</span></div><div><strong>{usage.uploadCount}</strong><span>累计导入</span></div></div><p className="settings-section-note">D1 只保存索引与关系；文件本体仍在私人 Telegram 存储中。</p></> : <p className="settings-section-note">当前没有可显示的使用量快照。</p>}
      </section>

      {isOwner ? <>
      <section id="settings-storage" className="settings-product-section">
        <header><div><p className="eyebrow">STORAGE</p><h2>Telegram 双存储</h2></div><Cloud /></header>
        <TelegramStorageSettings status={status} reloadStatus={loadStatus} />
        <p className="settings-section-note">D1 只保存后端类型、Telegram message identity、索引与权限元数据；Telegram User Session / API Hash 永远不进入 Worker、D1 或浏览器 bundle。</p>
      </section>

      <section id="settings-accounts" className="settings-product-section settings-account-section">
        <header><div><p className="eyebrow">ACCOUNTS</p><h2>应用账号</h2></div><UserRound /></header>
        <div className="account-create-grid">
          <label><span>用户名</span><input value={accountUsername} onChange={(event) => setAccountUsername(event.target.value)} placeholder="family" autoComplete="off" /></label>
          <label><span>显示名称</span><input value={accountDisplayName} onChange={(event) => setAccountDisplayName(event.target.value)} placeholder="Family" autoComplete="off" /></label>
          <label><span>初始密码</span><input value={accountPassword} onChange={(event) => setAccountPassword(event.target.value)} type="password" minLength={10} autoComplete="new-password" placeholder="至少 9 个字符" /></label>
          <label><span>初始权限</span><select value={accountPreset} onChange={(event) => setAccountPreset(event.target.value as 'FULL' | 'VIEWER' | 'UPLOAD_ONLY')}><option value="VIEWER">只读 · 可看全部</option><option value="UPLOAD_ONLY">仅上传 · 不可浏览</option><option value="FULL">完整成员 · 可读写</option></select></label>
          <button className="primary-button" type="button" disabled={savingAccount || !accountUsername.trim() || !accountDisplayName.trim() || accountPassword.length < 9} onClick={() => void createAccount()}>{savingAccount ? <LoaderCircle className="spin" /> : <Plus />}{savingAccount ? '创建中' : '创建账号'}</button>
        </div>
        <div className="account-create-grid">
          <label><span>统一新密码</span><input value={resetAllPassword} onChange={(event) => setResetAllPassword(event.target.value)} type="password" autoComplete="new-password" placeholder="至少 9 个字符，无其他复杂度要求" /></label>
          <button className="secondary-button" type="button" disabled={resettingAllPasswords || resetAllPassword.length < 9 || !accounts.length} onClick={() => void resetAllPasswords()}>{resettingAllPasswords ? <LoaderCircle className="spin" /> : <RotateCw />}{resettingAllPasswords ? '重置中' : '统一重置现有账号密码'}</button>
        </div>
        {accountResetMessage ? <p className="settings-section-note">{accountResetMessage}</p> : null}
        <p className="settings-section-note">统一重置会一次性更新全部应用账号，并让现有登录会话失效；密码仍只保存 PBKDF2-SHA256 哈希。Owner 始终拥有全部权限。新普通账号默认只读；查看、下载、上传、编辑、删除都由 Worker 强制校验，不只是在界面里隐藏按钮。</p>
        <div className="account-admin-list">{accounts.map((account) => {
          const savingAccess = savingAccessId === account.id
          const allLibrary = accountHasGrant(account, 'workspace', 'personal', 'read')
          const accessLabel = account.role === 'OWNER' ? 'Owner · 全部权限' : account.accessPreset === 'FULL' ? '完整成员' : account.accessPreset === 'VIEWER' ? '只读全部' : account.accessPreset === 'UPLOAD_ONLY' ? '仅上传' : '自定义范围'
          return <article key={account.id} className="account-admin-card">
            <div className="account-card-head"><div><span className="known-account-avatar"><UserRound /></span><div><strong>{account.displayName}</strong><small>@{account.username} · {accessLabel}</small></div></div><div><span className={`source-state ${account.status === 'ACTIVE' ? 'active' : 'disabled'}`}>{account.status}</span>{account.role !== 'OWNER' ? <button className="secondary-button" type="button" onClick={() => void toggleAccountStatus(account)}>{account.status === 'ACTIVE' ? '停用' : '启用'}</button> : null}</div></div>
            {account.role !== 'OWNER' ? <details className="account-access-editor">
              <summary><span><ShieldCheck />权限与可见范围</span><small>{savingAccess ? '保存中…' : accessLabel}</small></summary>
              <div className="account-access-body">
                <div className="account-preset-row"><span>快速模式</span><div><button type="button" className={account.accessPreset === 'VIEWER' ? 'active' : ''} disabled={savingAccess} onClick={() => void saveAccountAccess(account, { accessPreset: 'VIEWER' })}>只读</button><button type="button" className={account.accessPreset === 'UPLOAD_ONLY' ? 'active' : ''} disabled={savingAccess} onClick={() => void saveAccountAccess(account, { accessPreset: 'UPLOAD_ONLY' })}>仅上传</button><button type="button" className={account.accessPreset === 'FULL' ? 'active' : ''} disabled={savingAccess} onClick={() => void saveAccountAccess(account, { accessPreset: 'FULL' })}>完整成员</button></div></div>
                <div className="account-permission-grid"><label><input type="checkbox" checked={allLibrary} disabled={savingAccess} onChange={() => void toggleAllLibraryRead(account)} /><span>查看全部图库</span></label>{(['download', 'upload', 'edit', 'delete'] as const).map((permission) => <label key={permission}><input type="checkbox" checked={accountHasGrant(account, 'workspace', 'personal', permission)} disabled={savingAccess} onChange={() => void toggleAccountCapability(account, permission)} /><span>{permission === 'download' ? '下载原件' : permission === 'upload' ? '上传' : permission === 'edit' ? '编辑整理' : '删除/恢复'}</span></label>)}</div>
                <div className="account-scope-editor"><div><strong>指定可见范围</strong><small>选择下面任一来源或相册会自动关闭“查看全部图库”。能力权限只对这些可见资源生效。</small></div>{sources.length ? <div className="account-scope-group"><span>Telegram 来源</span><div>{sources.map((source) => <button key={source.id} type="button" className={accountHasGrant(account, 'source', source.id, 'read') && !allLibrary ? 'active' : ''} disabled={savingAccess} onClick={() => void toggleReadScope(account, 'source', source.id)}>{source.displayName}</button>)}</div></div> : null}{albums.length ? <div className="account-scope-group"><span>相册</span><div>{albums.map((album) => <button key={album.id} type="button" className={accountHasGrant(account, 'album', album.id, 'read') && !allLibrary ? 'active' : ''} disabled={savingAccess} onClick={() => void toggleReadScope(account, 'album', album.id)}>{album.name}</button>)}</div></div> : null}</div>
              </div>
            </details> : null}
          </article>
        })}</div>
      </section>

      <section id="settings-sources" className="settings-product-section settings-source-section">
        <header><div><p className="eyebrow">TELEGRAM SOURCES</p><h2>Telegram 来源</h2></div><Bot /></header>
        <div className="source-create-row">
          <label><span>显示名称</span><input value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="家庭照片" maxLength={80} /></label>
          <label><span>Bot Token</span><input value={sourceToken} onChange={(event) => setSourceToken(event.target.value)} placeholder="仅提交到 Worker，不会回显" type="password" autoComplete="off" /></label>
          <button className="primary-button" type="button" disabled={addingSource || !sourceName.trim() || !sourceToken.trim()} onClick={() => void addTelegramSource()}>{addingSource ? <LoaderCircle className="spin" /> : <Plus />}{addingSource ? '验证中' : '添加来源'}</button>
        </div>
        <p className="settings-section-note">新增 Bot 会先通过 Telegram getMe 验证身份，再生成独立 webhook secret。未绑定 Chat 前只做发现，不会写入资产。</p>
        <div className="source-card-list">{sources.map((source) => <article className="source-card" key={source.id}>
          <div className="source-card-main"><div><strong>{source.displayName}</strong><span>{source.botUsername ? `@${source.botUsername}` : source.id === 'telegram-legacy' ? 'Legacy production source' : 'Bot verified'}</span></div><span className={`source-state ${source.enabled ? 'active' : 'disabled'}`}>{source.connectionStatus}</span></div>
          <dl><div><dt>Chat</dt><dd>{source.chatId ?? '待绑定'}</dd></div><div><dt>资产</dt><dd>{source.assetCount}</dd></div><div><dt>Storage Objects</dt><dd>{source.storageObjectCount}</dd></div><div><dt>Last Sync</dt><dd>{source.lastSyncAt ? new Date(source.lastSyncAt).toLocaleString() : '—'}</dd></div></dl>
          {source.lastError ? <p className="settings-inline-error">{source.lastError}</p> : null}
          <div className="source-actions">
            {source.id !== 'telegram-legacy' ? <button className="secondary-button" type="button" onClick={() => void discoverSource(source.id)}><ScanSearch />发现 Chat</button> : null}
            <button className="secondary-button" type="button" onClick={() => void toggleSource(source)}>{source.enabled ? <Circle /> : <Check />}{source.enabled ? '停用' : '启用'}</button>
            {source.id !== 'telegram-legacy' ? <button className="secondary-button" type="button" onClick={() => void disconnectSource(source)}><Unplug />断开配置</button> : null}
          </div>
          {activeSourceDiscoveryId === source.id ? <div className="source-discovery-list">{sourceChats.length ? sourceChats.map((chat) => <button key={chat.id} className="source-chat-option" type="button" disabled={configuringChatId === chat.id} onClick={() => void bindSource(source.id, chat.id)}><span>{chat.title ?? chat.firstName ?? chat.username ?? chat.id}</span><small>{chat.type} · {chat.id}</small>{configuringChatId === chat.id ? <LoaderCircle className="spin" /> : <Check />}</button>) : <p>还没有发现 Chat。先给这个 Bot 发 /start，或在目标群组 / 频道发送一条消息。</p>}</div> : null}
        </article>)}</div>
      </section>

      <section id="settings-sharing" className="settings-product-section settings-sharing-section">
        <header><div><p className="eyebrow">SHARING & ACCESS</p><h2>共享与访问</h2></div><Link2 /></header>
        <div className="share-create-grid">
          <label><span>共享名称</span><input value={shareName} onChange={(event) => setShareName(event.target.value)} placeholder="Family viewer" maxLength={80} /></label>
          <label><span>范围</span><select value={shareScopeType} onChange={(event) => { const next = event.target.value as 'source' | 'album' | 'asset'; setShareScopeType(next); const nextOptions = next === 'source' ? sources : next === 'album' ? albums : shareAssets; setShareScopeId(nextOptions[0]?.id ?? '') }}><option value="source">Telegram Source</option><option value="album">Album</option><option value="asset">Asset</option></select></label>
          <label><span>对象</span><select value={shareScopeId} onChange={(event) => setShareScopeId(event.target.value)}>{scopeOptions.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}</select></label>
          <label><span>有效期</span><select value={shareExpiry === null ? 'never' : String(shareExpiry)} onChange={(event) => setShareExpiry(event.target.value === 'never' ? null : Number(event.target.value) as 1 | 7 | 30)}><option value="1">1 天</option><option value="7">7 天</option><option value="30">30 天</option><option value="never">永久</option></select></label>
          <label className="share-download-toggle"><input type="checkbox" checked={shareDownload} onChange={(event) => setShareDownload(event.target.checked)} /><span>允许下载原件</span></label>
          <button className="primary-button" type="button" disabled={savingShare || !shareName.trim() || !shareScopeId} onClick={() => void createShare()}>{savingShare ? <LoaderCircle className="spin" /> : <Link2 />}{savingShare ? '生成中' : '生成共享链接'}</button>
        </div>
        {shareUrl ? <div className="share-url-result"><code>{shareUrl}</code><button className="secondary-button" type="button" onClick={() => void navigator.clipboard.writeText(shareUrl)}><Copy />复制</button></div> : null}
        <p className="settings-section-note">链接原始 Token 只在首次生成/轮换时出现，并放在 URL fragment 中；服务端只保存 Token hash。访客换取 HttpOnly session 后按 Worker 查询层 default-deny 过滤。</p>
        <div className="share-list">{shares.map((share) => <article key={share.id} className="share-card"><div><strong>{share.name}</strong><span>{share.scopeType} · {share.scopeId}</span></div><small>{share.revoked ? '已撤销' : share.expiresAt ? `到期 ${new Date(share.expiresAt).toLocaleString()}` : '永久'} · {share.permissions.includes('download') ? 'Read + Download' : 'Read only'}</small><div className="source-actions"><button className="secondary-button" type="button" disabled={share.revoked} onClick={() => void api.rotateShare(share.id).then(async (result) => { setShareUrl(result.url); await refreshShares() })}><RotateCw />轮换链接</button><button className="secondary-button" type="button" disabled={share.revoked} onClick={() => void api.revokeShare(share.id).then(refreshShares)}><LockKeyhole />撤销</button></div></article>)}</div>
      </section>

      <section id="settings-trash" className="settings-product-section">
        <header><div><p className="eyebrow">TRASH</p><h2>回收站保留</h2></div><Trash2 /></header>
        <div className="trash-policy-options">{([7, 30, 90, 'never'] as const).map((value) => <button type="button" key={String(value)} className={(value === 'never' ? trashRetention === null : trashRetention === value) ? 'active' : ''} disabled={savingTrashPolicy} onClick={() => void updateTrashPolicy(value)}>{value === 'never' ? '永久保留' : `${value} 天`}</button>)}</div>
        <p className="settings-section-note">到期只代表“允许清理”。永久删除仍要经过物理对象最后引用检查，不会因为保留期限自动误删 Telegram 原件。</p>
      </section>

      </> : null}

      <section id="settings-connections" className="settings-product-section settings-connections-section">
        <header><div><p className="eyebrow">CONNECTIONS</p><h2>连接</h2></div><Bot /></header>
        <ConnectionSummary status={status} />
      </section>
    </div>

    {isOwner ? <details id="settings-advanced" className="settings-advanced">
      <summary><span><p className="eyebrow">ADVANCED / DIAGNOSTICS</p><strong>高级与诊断</strong></span><small>Worker、D1、Telegram、Queue、AI 与 Access 的工程状态</small></summary>
      <div className="settings-advanced-body">
        <section className="setup-panel"><header><Bot /><div><p className="eyebrow">Runtime diagnostics</p><h2>{status.mockMode ? 'Mock 模式' : '生产绑定'}</h2></div></header><ol className="setup-list">
          <StatusLine ok={status.telegram.tokenConfigured} Icon={KeyRound} label="Bot Token" detail={status.telegram.tokenConfigured ? '已通过 Secret 配置' : '未配置 Secret'} />
          <StatusLine ok={status.telegram.ownerConfigured} Icon={ShieldCheck} label="Owner User ID" detail="只接受本人私聊消息" />
          <StatusLine ok={status.telegram.storageChatConfigured} Icon={Send} label="Storage Channel" detail="原件与可用预览进入私人存储" />
          <StatusLine ok={status.telegram.webhookSecretConfigured} Icon={LockKeyhole} label="Webhook Secret" detail="验证 Telegram Secret Header" />
          <StatusLine ok={status.d1.configured} Icon={Database} label="D1" detail="只保存索引与关系，无媒体 Blob" />
          <StatusLine ok={status.queue.configured} Icon={Workflow} label="Queue" detail="异步分析、重试与归一化" />
          <StatusLine ok={status.ai.configured} Icon={Cloud} label="Workers AI" detail="只分析小尺寸 preview" />
          <StatusLine ok={status.access.configured} Icon={ShieldCheck} label="Cloudflare Access" detail="校验签名、AUD、Team Domain 与 Owner 邮箱" />
        </ol></section>

        <section className="telegram-discovery"><div><p className="eyebrow">Telegram discovery</p><h3>存储连接发现</h3><p>Webhook 会持续记录 Bot 收到的私聊与频道。给 Bot 发 /start；私人频道发一条消息后，可在这里刷新并绑定。不会停用 Webhook，也不会调用 getUpdates。</p></div><button className="secondary-button" type="button" onClick={() => void discoverTelegram()} disabled={discovering}>{discovering ? <LoaderCircle className="spin" /> : <ScanSearch />}{discovering ? '刷新中' : '刷新 Telegram'}</button>{discoveryError ? <p className="telegram-discovery-error" role="alert">{discoveryError}</p> : null}{discovery ? <div className="telegram-discovery-result"><strong>Bot：{discovery.bot.username ? `@${discovery.bot.username}` : discovery.bot.firstName ?? discovery.bot.id}</strong>{discovery.chats.length ? <ul>{discovery.chats.map((chat) => <li key={chat.id}><span>{chat.type === 'private' ? '私聊' : chat.type}</span><code>{chat.id}</code><small>{chat.title ?? chat.firstName ?? chat.username ?? '未命名'}</small><div className="telegram-chat-actions">{chat.type === 'private' ? <button className="secondary-button" type="button" disabled={configuringChatId === chat.id} onClick={() => void configureTelegram(chat.id, 'both')}>{configuringChatId === chat.id ? <LoaderCircle className="spin" /> : <Check />}设为本人 + 存储</button> : <button className="secondary-button" type="button" disabled={configuringChatId === chat.id} onClick={() => void configureTelegram(chat.id, 'storage')}>{configuringChatId === chat.id ? <LoaderCircle className="spin" /> : <Send />}设为存储位置</button>}</div></li>)}</ul> : <p>暂时没有发现聊天。给 Bot 发 /start 或在私人频道发送一条消息后再刷新。</p>}</div> : null}</section>
      </div>
    </details> : null}
  </div>
}
