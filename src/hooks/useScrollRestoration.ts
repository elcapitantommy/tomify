import { useEffect, useLayoutEffect, useRef } from 'react'
import { useLocation, useNavigationType } from 'react-router-dom'

const STORAGE_KEY = 'tomify:scroll-positions'
const MAX_ENTRIES = 100
export const RESTORE_TIMEOUT_MS = 5000

// Scroll positions per history entry (location.key). Kept in memory and saved to
// sessionStorage when the page is hidden, so a reload can restore them too.
const positions = new Map<string, number>(readStored())

function readStored(): Array<[string, number]> {
  try {
    const parsed: unknown = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((entry): entry is [string, number] => Array.isArray(entry) && typeof entry[0] === 'string' && typeof entry[1] === 'number') : []
  } catch { return [] }
}

function persist() {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...positions].slice(-MAX_ENTRIES))) } catch { /* storage unavailable */ }
}

function remember(key: string, y: number) {
  positions.delete(key)
  positions.set(key, y)
  if (positions.size > MAX_ENTRIES) positions.delete(positions.keys().next().value as string)
}

export function resetScrollPositions() {
  positions.clear()
  try { sessionStorage.removeItem(STORAGE_KEY) } catch { /* storage unavailable */ }
}

const maxScrollY = () => Math.max(0, document.documentElement.scrollHeight - window.innerHeight)

/**
 * Restores the window scroll position when the user goes Back or Forward, and
 * starts new pages at the top. Pages load their data after mounting, so a saved
 * position may be further down than the page is tall at first: we wait until
 * the page is long enough (or the user scrolls themselves, or a timeout passes).
 */
export function useScrollRestoration() {
  const location = useLocation()
  const navigationType = useNavigationType()
  const keyRef = useRef(location.key)
  const restoringRef = useRef(false)

  useEffect(() => {
    if (!('scrollRestoration' in window.history)) return
    const previous = window.history.scrollRestoration
    window.history.scrollRestoration = 'manual'
    return () => { window.history.scrollRestoration = previous }
  }, [])

  useEffect(() => {
    const onScroll = () => { if (!restoringRef.current) remember(keyRef.current, window.scrollY) }
    window.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('pagehide', persist)
    return () => {
      window.removeEventListener('scroll', onScroll)
      window.removeEventListener('pagehide', persist)
      persist()
    }
  }, [])

  useLayoutEffect(() => {
    keyRef.current = location.key
    restoringRef.current = false
    if (navigationType === 'PUSH') { window.scrollTo(0, 0); return }
    if (navigationType === 'REPLACE') { remember(location.key, window.scrollY); return }
    const target = positions.get(location.key)
    if (!target) return

    restoringRef.current = true
    const key = location.key
    const started = Date.now()
    let frame = 0
    const finish = () => {
      if (frame) cancelAnimationFrame(frame)
      frame = 0
      for (const type of cancelEvents) window.removeEventListener(type, finish)
      if (keyRef.current === key) {
        restoringRef.current = false
        remember(key, window.scrollY)
      }
    }
    const attempt = () => {
      frame = 0
      if (maxScrollY() >= target - 1) {
        window.scrollTo(0, target)
        finish()
        return
      }
      if (Date.now() - started >= RESTORE_TIMEOUT_MS) {
        window.scrollTo(0, Math.min(target, maxScrollY()))
        finish()
        return
      }
      frame = requestAnimationFrame(attempt)
    }
    // The user taking over (scrolling, tapping, typing) cancels a pending restore.
    const cancelEvents = ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const
    for (const type of cancelEvents) window.addEventListener(type, finish, { passive: true })
    attempt()
    return finish
  }, [location.key]) // eslint-disable-line react-hooks/exhaustive-deps
}
