/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { api, ApiError } from '../lib/api'
import { setLocalUploadPrincipal } from '../lib/offline/store'
import { clearSensitivePrivateCaches } from '../lib/private-cache'
import { clearNativeMediaCache } from '../lib/native-media'
import type { AppAccount } from '../types'

const KNOWN_ACCOUNTS_KEY = 'private-archive:known-accounts'

interface KnownAccount {
  username: string
  displayName: string
}

interface AuthContextValue {
  loading: boolean
  initialized: boolean
  user: AppAccount | null
  accessError: boolean
  error: string | null
  knownAccounts: KnownAccount[]
  bootstrap: (username: string, displayName: string, password: string) => Promise<void>
  login: (username: string, password: string) => Promise<void>
  logout: () => Promise<void>
  switchAccount: () => Promise<void>
  refresh: () => Promise<void>
}

const AuthContext = createContext<AuthContextValue | null>(null)

function readKnownAccounts(): KnownAccount[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(KNOWN_ACCOUNTS_KEY) ?? '[]') as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter((item): item is KnownAccount => Boolean(
      item && typeof item === 'object'
      && typeof (item as KnownAccount).username === 'string'
      && typeof (item as KnownAccount).displayName === 'string',
    )).slice(0, 8)
  } catch {
    return []
  }
}

function rememberAccount(account: AppAccount): KnownAccount[] {
  const current = readKnownAccounts().filter((item) => item.username.toLowerCase() !== account.username.toLowerCase())
  const next = [{ username: account.username, displayName: account.displayName }, ...current].slice(0, 8)
  try { localStorage.setItem(KNOWN_ACCOUNTS_KEY, JSON.stringify(next)) } catch { /* best effort */ }
  return next
}

function friendlyAuthError(error: unknown): string {
  const code = error instanceof ApiError ? error.code : error instanceof Error ? error.message : ''
  switch (code) {
    case 'LOGIN_INVALID': return '用户名或密码不正确。'
    case 'LOGIN_RATE_LIMITED': return '登录尝试过多，请稍后再试。'
    case 'USERNAME_EXISTS': return '这个用户名已经存在。'
    case 'USERNAME_INVALID': return '用户名使用 3–40 个字母、数字、点、下划线或短横线。'
    case 'DISPLAY_NAME_INVALID': return '请输入有效的显示名称。'
    case 'PASSWORD_INVALID': return '密码至少需要 10 个字符。'
    case 'APP_ALREADY_INITIALIZED': return 'Owner 已经初始化，请直接登录。'
    case 'APP_NOT_INITIALIZED': return '还没有初始化 Owner 账号。'
    case 'APP_OWNER_REQUIRED': return '这个操作需要 Owner 账号。'
    default: return code || '登录服务暂时不可用。'
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [loading, setLoading] = useState(true)
  const [initialized, setInitialized] = useState(false)
  const [user, setUser] = useState<AppAccount | null>(null)
  const [accessError, setAccessError] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [knownAccounts, setKnownAccounts] = useState<KnownAccount[]>(() => readKnownAccounts())

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const status = await api.authStatus()
      setInitialized(status.initialized)
      setUser(status.user)
      setLocalUploadPrincipal(status.user?.id ?? null, { adoptLegacy: status.user?.role === 'OWNER' })
      setAccessError(false)
      if (status.user) setKnownAccounts(rememberAccount(status.user))
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'ACCESS_SIGN_IN_REQUIRED') {
        setAccessError(true)
        setUser(null)
        setLocalUploadPrincipal(null)
      } else {
        setError(friendlyAuthError(caught))
      }
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    let active = true
    void api.authStatus().then((status) => {
      if (!active) return
      setInitialized(status.initialized)
      setUser(status.user)
      setLocalUploadPrincipal(status.user?.id ?? null, { adoptLegacy: status.user?.role === 'OWNER' })
      setAccessError(false)
      setError(null)
      if (status.user) setKnownAccounts(rememberAccount(status.user))
    }).catch((caught) => {
      if (!active) return
      if (caught instanceof ApiError && caught.code === 'ACCESS_SIGN_IN_REQUIRED') {
        setAccessError(true)
        setUser(null)
        setLocalUploadPrincipal(null)
      } else {
        setError(friendlyAuthError(caught))
      }
    }).finally(() => {
      if (active) setLoading(false)
    })
    return () => { active = false }
  }, [])
  useEffect(() => {
    const onAuthRequired = () => {
      setUser(null)
      setLocalUploadPrincipal(null)
      void clearSensitivePrivateCaches().catch(() => undefined)
      clearNativeMediaCache()
      setError('登录会话已过期，请重新登录。')
    }
    window.addEventListener('private-archive:auth-required', onAuthRequired)
    return () => window.removeEventListener('private-archive:auth-required', onAuthRequired)
  }, [])

  const bootstrap = useCallback(async (username: string, displayName: string, password: string) => {
    setError(null)
    try {
      const result = await api.bootstrapAccount(username, displayName, password)
      setInitialized(true)
      setUser(result.user)
      setLocalUploadPrincipal(result.user.id, { adoptLegacy: result.user.role === 'OWNER' })
      setKnownAccounts(rememberAccount(result.user))
    } catch (caught) {
      setError(friendlyAuthError(caught))
      throw caught
    }
  }, [])

  const login = useCallback(async (username: string, password: string) => {
    setError(null)
    try {
      const result = await api.loginAccount(username, password)
      await clearSensitivePrivateCaches().catch(() => 0)
      clearNativeMediaCache()
      setInitialized(true)
      setUser(result.user)
      setLocalUploadPrincipal(result.user.id, { adoptLegacy: result.user.role === 'OWNER' })
      setAccessError(false)
      setKnownAccounts(rememberAccount(result.user))
    } catch (caught) {
      setError(friendlyAuthError(caught))
      throw caught
    }
  }, [])

  const logout = useCallback(async () => {
    try { await api.logoutAccount() } catch { /* local state still signs out */ }
    await clearSensitivePrivateCaches().catch(() => 0)
    clearNativeMediaCache()
    setUser(null)
    setLocalUploadPrincipal(null)
    setError(null)
  }, [])

  const switchAccount = useCallback(async () => {
    await logout()
  }, [logout])

  const value = useMemo<AuthContextValue>(() => ({
    loading, initialized, user, accessError, error, knownAccounts,
    bootstrap, login, logout, switchAccount, refresh,
  }), [accessError, bootstrap, error, initialized, knownAccounts, loading, login, logout, refresh, switchAccount, user])

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('AuthProvider is missing')
  return value
}
