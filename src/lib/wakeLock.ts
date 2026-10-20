// Keeps the screen on (Screen Wake Lock API) while car mode is open. The browser drops the lock when the
// page is hidden, so it is taken again when the page comes back. Browsers without the API just let it sleep.
interface WakeLockSentinelLike { release(): Promise<void> }
type WakeLockNavigator = Navigator & { wakeLock?: { request(type: 'screen'): Promise<WakeLockSentinelLike> } }

export function keepScreenOn(): () => void {
  const wakeLock = (navigator as WakeLockNavigator).wakeLock
  if (!wakeLock) return () => {}
  let sentinel: WakeLockSentinelLike | null = null
  let stopped = false
  const take = () => {
    if (stopped || document.visibilityState !== 'visible') return
    wakeLock.request('screen').then((lock) => { if (stopped) void lock.release().catch(() => undefined); else sentinel = lock }).catch(() => undefined)
  }
  document.addEventListener('visibilitychange', take)
  take()
  return () => {
    stopped = true
    document.removeEventListener('visibilitychange', take)
    void sentinel?.release().catch(() => undefined)
    sentinel = null
  }
}
