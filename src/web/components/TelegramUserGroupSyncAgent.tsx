import { useEffect } from 'react'
import { useArchive } from '../context/ArchiveContext'
import { useAuth } from '../context/AuthContext'
import {
  flushUserGroupPendingIntoArchive,
  publishUserGroupRuntime,
  syncUserGroupIntoArchive,
  telegramUserGroupBridge,
} from '../lib/telegram-user-group'

const CATCH_UP_INTERVAL_MS = 60_000
const PENDING_POLL_INTERVAL_MS = 5_000

export function TelegramUserGroupSyncAgent() {
  const { user } = useAuth()
  const { refresh } = useArchive()

  useEffect(() => {
    if (user?.role !== 'OWNER' || !telegramUserGroupBridge.available) return
    let disposed = false
    let running = false
    let lastCatchUp = 0

    const tick = async (forceCatchUp = false) => {
      if (disposed || running || !navigator.onLine || document.visibilityState !== 'visible') return
      running = true
      try {
        const status = await telegramUserGroupBridge.status()
        if (disposed) return
        if (status.connectionStatus !== 'connected' && status.connectionStatus !== 'syncing') {
          await publishUserGroupRuntime(status).catch(() => undefined)
          return
        }
        let changed = false
        if (forceCatchUp || Date.now() - lastCatchUp >= CATCH_UP_INTERVAL_MS) {
          const result = await syncUserGroupIntoArchive()
          lastCatchUp = Date.now()
          changed = result.created > 0 || result.duplicate > 0
        } else if (status.pendingCount > 0) {
          const result = await flushUserGroupPendingIntoArchive()
          changed = result.created > 0 || result.duplicate > 0
        }
        if (changed && !disposed) await refresh()
      } catch {
        // The settings screen exposes the classified Bridge/Telegram error. Background
        // polling stays silent so a temporary network/authorization issue never floods UI.
      } finally {
        running = false
      }
    }

    void tick(true)
    const timer = window.setInterval(() => void tick(false), PENDING_POLL_INTERVAL_MS)
    const onFocus = () => void tick(true)
    const onVisibility = () => { if (document.visibilityState === 'visible') void tick(true) }
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [refresh, user?.role])

  return null
}
