const SENSITIVE_CACHE_PREFIXES = [
  'archive-previews-',
] as const

export async function clearSensitivePrivateCaches(cacheStorage: CacheStorage | undefined = globalThis.caches): Promise<number> {
  if (!cacheStorage) return 0
  const names = await cacheStorage.keys()
  const sensitive = names.filter((name) => SENSITIVE_CACHE_PREFIXES.some((prefix) => name.startsWith(prefix)))
  const deleted = await Promise.all(sensitive.map((name) => cacheStorage.delete(name)))
  return deleted.filter(Boolean).length
}
