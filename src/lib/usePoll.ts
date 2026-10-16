import { useEffect, useRef } from 'react'

// Runs `tick` every `intervalMs` while `active`, and again as soon as the page becomes visible. A tick that has not
// finished is not started twice, and a failed or stalled tick does not stop the polling: the next interval tries again.
// Status checks used to chain one timeout after each answer, so one request that never answered (common when a phone
// suspends the app mid-request) left the button spinning until the page was refreshed.
export function usePoll(active: boolean, tick: (signal: AbortSignal) => Promise<void>, intervalMs: number, timeoutMs = 15000) {
  const latest = useRef(tick)
  latest.current = tick
  useEffect(() => {
    if (!active) return
    let running: AbortController | null = null
    let stopped = false
    const run = () => {
      if (stopped || running) return
      const controller = new AbortController()
      running = controller
      // Give up on a tick that outlives the timeout even if it ignores the abort, so the next interval can run.
      const timer = window.setTimeout(() => { controller.abort(); if (running === controller) running = null }, timeoutMs)
      void latest.current(controller.signal).catch(() => {}).finally(() => { window.clearTimeout(timer); if (running === controller) running = null })
    }
    const interval = window.setInterval(run, intervalMs)
    const onVisible = () => { if (document.visibilityState === 'visible') { running?.abort(); running = null; run() } }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => { stopped = true; running?.abort(); window.clearInterval(interval); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('focus', onVisible) }
  }, [active, intervalMs, timeoutMs])
}
