import { useCallback } from 'react'
import { useSearchParams } from 'react-router-dom'

/**
 * A choice (tab, sort order) kept in the page's URL, so going Back to the page
 * shows the same choice and the saved scroll position still lines up.
 * The default value is left out of the URL.
 */
export function useSearchParamState<T extends string>(name: string, fallback: T, allowed: readonly T[]) {
  const [params, setParams] = useSearchParams()
  const raw = params.get(name)
  const value = raw !== null && (allowed as readonly string[]).includes(raw) ? raw as T : fallback
  const setValue = useCallback((next: T) => {
    setParams((current) => {
      const updated = new URLSearchParams(current)
      if (next === fallback) updated.delete(name)
      else updated.set(name, next)
      return updated
    }, { replace: true, preventScrollReset: true })
  }, [fallback, name, setParams])
  return [value, setValue] as const
}
