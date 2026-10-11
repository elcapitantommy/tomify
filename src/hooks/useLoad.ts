import { useCallback, useEffect, useState } from 'react'

export function useLoad<T>(loader: (signal: AbortSignal) => Promise<T>, deps: React.DependencyList = []) {
  const [data, setData] = useState<T | null>(null); const [error, setError] = useState<string | null>(null); const [loading, setLoading] = useState(true); const [nonce, setNonce] = useState(0)
  const retry = useCallback(() => setNonce((value) => value + 1), [])
  useEffect(() => { const controller = new AbortController(); setLoading(true); setError(null); loader(controller.signal).then(setData).catch((reason) => { if (reason?.name !== 'AbortError') setError(reason instanceof Error ? reason.message : 'Something went wrong.') }).finally(() => { if (!controller.signal.aborted) setLoading(false) }); return () => controller.abort() }, [...deps, nonce]) // eslint-disable-line react-hooks/exhaustive-deps
  return { data, error, loading, retry }
}
