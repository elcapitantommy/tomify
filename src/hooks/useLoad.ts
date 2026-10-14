import { useCallback, useEffect, useRef, useState } from 'react'

const loadCache = new Map<string, unknown>()

export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: React.DependencyList = [], cacheKey?: string) {
  const cached = cacheKey ? loadCache.get(cacheKey) as T | undefined : undefined
  const [data, setData] = useState<T | null>(cached ?? null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(cached === undefined)
  const [nonce, setNonce] = useState(0)
  const silentNext = useRef(false)

  const retry = useCallback(() => {
    silentNext.current = false
    setNonce((value) => value + 1)
  }, [])

  const refresh = useCallback(() => {
    silentNext.current = true
    setNonce((value) => value + 1)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    const silent = data !== null && (silentNext.current || Boolean(cacheKey))
    silentNext.current = false

    if (!silent) setLoading(true)
    setError(null)

    loader(controller.signal)
      .then((value) => {
        if (cacheKey) loadCache.set(cacheKey, value)
        setData(value)
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Something went wrong.')
      })
      .finally(() => {
        if (!controller.signal.aborted && !silent) setLoading(false)
      })

    return () => controller.abort()
  }, [...deps, nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  return { data, error, loading, retry, refresh }
}
