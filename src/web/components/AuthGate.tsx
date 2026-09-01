import { useState, type FormEvent, type ReactNode } from 'react'
import { KeyRound, LoaderCircle, LockKeyhole, ShieldCheck, UserRound } from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { reauthenticateAccess } from '../lib/access-session'

export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuth()
  const localDesktop = typeof window !== 'undefined' && (window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost')
  const [username, setUsername] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      if (auth.initialized) await auth.login(username, password)
      else await auth.bootstrap(username, displayName, password)
      setPassword('')
    } catch {
      // AuthContext exposes the user-facing error.
    } finally {
      setSubmitting(false)
    }
  }

  if (auth.loading) return <main className="owner-login-shell"><LoaderCircle className="owner-auth-loader spin" aria-label="正在检查登录状态" /></main>
  if (auth.accessError) return <main className="owner-login-shell"><section className="owner-login-card">
    <div className="owner-login-mark"><ShieldCheck /></div>
    <p className="eyebrow">PRIVATE ARCHIVE · ACCESS</p>
    <h1>需要重新验证访问</h1>
    <p className="owner-login-copy">Cloudflare Access 会话已经过期。完成外围验证后，会回到应用账号登录。</p>
    <button className="primary-button owner-login-submit" type="button" onClick={() => reauthenticateAccess()}><ShieldCheck />重新验证 Cloudflare Access</button>
  </section></main>
  if (auth.user) return <>{children}</>

  const title = auth.initialized ? '登录私人档案' : '初始化 Owner 账号'
  const copy = auth.initialized
    ? '选择已使用过的账号，或输入另一个账号。登录后会保持 7 天会话。'
    : '这是第一次启用应用账号。创建 Owner 后，可以在设置里继续添加其他账号。'

  return <main className="owner-login-shell"><section className="owner-login-card">
    <div className="owner-login-mark"><LockKeyhole /></div>
    <p className="eyebrow">PRIVATE ARCHIVE · ACCOUNT</p>
    <h1>{title}</h1>
    <p className="owner-login-copy">{copy}</p>

    {auth.initialized && auth.knownAccounts.length ? <div className="known-account-list" aria-label="已保存账号">
      {auth.knownAccounts.map((account) => <button key={account.username} type="button" className={`known-account${username.toLowerCase() === account.username.toLowerCase() ? ' active' : ''}`} onClick={() => setUsername(account.username)}>
        <span className="known-account-avatar"><UserRound /></span>
        <span><strong>{account.displayName}</strong><small>@{account.username}</small></span>
      </button>)}
    </div> : null}

    <form onSubmit={(event) => void submit(event)}>
      <label htmlFor="account-username"><UserRound />用户名</label>
      <div className="owner-password-field"><UserRound /><input id="account-username" name="username" autoComplete="username" value={username} onChange={(event) => setUsername(event.currentTarget.value)} placeholder="例如 owner" required /></div>
      {!auth.initialized ? <><label htmlFor="account-display-name" className="account-second-label"><UserRound />显示名称</label><div className="owner-password-field"><UserRound /><input id="account-display-name" name="displayName" autoComplete="name" value={displayName} onChange={(event) => setDisplayName(event.currentTarget.value)} placeholder="例如 Joye" required /></div></> : null}
      <label htmlFor="account-password" className="account-second-label"><KeyRound />密码</label>
      <div className="owner-password-field"><KeyRound /><input id="account-password" name="password" type="password" autoComplete={auth.initialized ? 'current-password' : 'new-password'} value={password} onChange={(event) => setPassword(event.currentTarget.value)} minLength={10} required /></div>
      <button className="primary-button owner-login-submit" type="submit" disabled={submitting}>{submitting ? <LoaderCircle className="spin" /> : <LockKeyhole />}{submitting ? '处理中' : auth.initialized ? '登录' : '创建 Owner 并进入'}</button>
      {auth.error ? <p className="owner-login-error" role="alert">{auth.error}</p> : null}
    </form>
    <p className="owner-login-footnote">{localDesktop ? '应用账号密码只保存强哈希；登录会话使用本机 HttpOnly Cookie。桌面端只连接 Private Archive API 后端。' : '应用账号密码只保存强哈希；登录会话使用 HttpOnly Cookie。Cloudflare Access 仍然保留在外层。'}</p>
  </section></main>
}
