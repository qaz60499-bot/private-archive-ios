import { useEffect, useMemo, useState } from 'react'
import { isNativeApp, nativePlatform } from './native-platform'

const NATIVE_API_ORIGIN = 'https://api.photo.joye.cc.cd'
const MAX_CACHED_MEDIA = 64
const MAX_CONCURRENT_NATIVE_MEDIA = 4

export type NativeMediaPriority = 'high' | 'normal' | 'low'

let activeNativeMediaRequests = 0
const nativeMediaWaiters: Array<{ release: () => void; priority: NativeMediaPriority }> = []
const nativeMediaPriorityRank: Record<NativeMediaPriority, number> = { high: 0, normal: 1, low: 2 }

async function acquireNativeMediaSlot(signal: AbortSignal, priority: NativeMediaPriority): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  if (activeNativeMediaRequests < MAX_CONCURRENT_NATIVE_MEDIA) {
    activeNativeMediaRequests += 1
    return
  }
  await new Promise<void>((resolve, reject) => {
    const releaseWaiter = () => {
      signal.removeEventListener('abort', onAbort)
      activeNativeMediaRequests += 1
      resolve()
    }
    const onAbort = () => {
      const index = nativeMediaWaiters.findIndex((waiter) => waiter.release === releaseWaiter)
      if (index >= 0) nativeMediaWaiters.splice(index, 1)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    nativeMediaWaiters.push({ release: releaseWaiter, priority })
    nativeMediaWaiters.sort((left, right) => nativeMediaPriorityRank[left.priority] - nativeMediaPriorityRank[right.priority])
  })
}

function releaseNativeMediaSlot(): void {
  activeNativeMediaRequests = Math.max(0, activeNativeMediaRequests - 1)
  const next = nativeMediaWaiters.shift()
  if (next) next.release()
}

interface CachedMedia {
  objectUrl: string
  lastUsed: number
}

const cache = new Map<string, CachedMedia>()
const inflight = new Map<string, Promise<string>>()

function isNativePrivateUrl(source: string | null | undefined): source is string {
  return Boolean(source && isNativeApp() && source.startsWith(`${NATIVE_API_ORIGIN}/api/`))
}

function evictOldest(): void {
  while (cache.size > MAX_CACHED_MEDIA) {
    let oldestKey: string | null = null
    let oldestTime = Number.POSITIVE_INFINITY
    for (const [key, value] of cache) {
      if (value.lastUsed < oldestTime) {
        oldestTime = value.lastUsed
        oldestKey = key
      }
    }
    if (!oldestKey) return
    const item = cache.get(oldestKey)
    if (item) URL.revokeObjectURL(item.objectUrl)
    cache.delete(oldestKey)
  }
}

async function fetchNativePrivateMedia(source: string, signal: AbortSignal, cacheResult: boolean, priority: NativeMediaPriority): Promise<{ objectUrl: string; cached: boolean }> {
  if (cacheResult) {
    const existing = cache.get(source)
    if (existing) {
      existing.lastUsed = Date.now()
      return { objectUrl: existing.objectUrl, cached: true }
    }
    const existingRequest = inflight.get(source)
    if (existingRequest) return { objectUrl: await existingRequest, cached: true }
  }

  const request = (async () => {
    await acquireNativeMediaSlot(signal, priority)
    try {
      const response = await fetch(source, {
        method: 'GET',
        credentials: 'include',
        signal,
        headers: {
          'X-Requested-With': 'XMLHttpRequest',
          'X-Private-Archive-Native': nativePlatform() ?? 'ios',
        },
      })
      if (!response.ok) throw new Error(`PRIVATE_MEDIA_${response.status}`)
      const blob = await response.blob()
      return URL.createObjectURL(blob)
    } finally {
      releaseNativeMediaSlot()
    }
  })()

  if (cacheResult) inflight.set(source, request)
  try {
    const objectUrl = await request
    if (cacheResult) {
      cache.set(source, { objectUrl, lastUsed: Date.now() })
      evictOldest()
    }
    return { objectUrl, cached: cacheResult }
  } finally {
    if (cacheResult) inflight.delete(source)
  }
}

export function usePrivateMediaUrl(source: string | null | undefined, options: { enabled?: boolean; cache?: boolean; retryKey?: number; priority?: NativeMediaPriority } = {}) {
  const enabled = options.enabled ?? true
  const cacheResult = options.cache ?? true
  const retryKey = options.retryKey ?? 0
  const priority = options.priority ?? 'normal'
  const nativePrivate = useMemo(() => isNativePrivateUrl(source), [source])
  const [state, setState] = useState<{ source: string | null; retryKey: number; url: string | null; failed: boolean; loading: boolean }>(() => ({
    source: source ?? null,
    retryKey,
    url: enabled && !nativePrivate ? source ?? null : null,
    failed: false,
    loading: Boolean(enabled && nativePrivate && source),
  }))

  useEffect(() => {
    const normalized = source ?? null
    if (!enabled || !normalized || !isNativePrivateUrl(normalized)) return

    const controller = new AbortController()
    let active = true
    let ownedObjectUrl: string | null = null
    void fetchNativePrivateMedia(normalized, controller.signal, cacheResult, priority).then(({ objectUrl, cached }) => {
      if (!active) {
        if (!cached) URL.revokeObjectURL(objectUrl)
        return
      }
      if (!cached) ownedObjectUrl = objectUrl
      setState({ source: normalized, retryKey, url: objectUrl, failed: false, loading: false })
    }).catch((error) => {
      if (!active || controller.signal.aborted) return
      console.warn('Private media load failed', error instanceof Error ? error.message : 'unknown')
      setState({ source: normalized, retryKey, url: null, failed: true, loading: false })
    })

    return () => {
      active = false
      controller.abort()
      if (ownedObjectUrl) URL.revokeObjectURL(ownedObjectUrl)
    }
  }, [cacheResult, enabled, priority, retryKey, source])

  const normalized = source ?? null
  if (!enabled || !normalized) return { url: null, failed: false, loading: false }
  if (!nativePrivate) return { url: normalized, failed: false, loading: false }
  const stale = state.source !== normalized || state.retryKey !== retryKey
  return {
    url: stale ? null : state.url,
    failed: stale ? false : state.failed,
    loading: stale ? true : state.loading,
  }
}

export function clearNativeMediaCache(): void {
  for (const item of cache.values()) URL.revokeObjectURL(item.objectUrl)
  cache.clear()
  inflight.clear()
}
