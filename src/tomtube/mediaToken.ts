// TomTube's media token. Players (<video>, <audio>, <img>, the lock screen) can't send headers, so
// every media URL carries a short-lived token (`mt`) from /api/media-session instead. The Navidrome
// login is never put in a TomTube URL: without a token there is no media URL, and the player waits.
//
// URLs are built synchronously (the next queued track starts inside the `ended` event, with no await),
// so the token is fetched ahead of time and renewed at half its life, and again whenever the app comes
// back to the foreground in case timers were paused.

export type MediaTokenStatus = 'pending' | 'ready' | 'not-configured' | 'unavailable'
interface Login { username: string; token: string; salt: string }
interface Grant { username: string; token: string; expiresAt: number }

// A token with less than this left is not put in new URLs. Playlists are re-signed by the Worker with
// a fresh four-hour token, so only the first request needs the one built here.
export const MIN_TOKEN_LIFE_MS = 2 * 60_000
const RETRY_MS = 30_000
const NOT_CONFIGURED_RETRY_MS = 10 * 60_000

let grant: Grant | null = null
let status: MediaTokenStatus = 'pending'
const listeners = new Set<() => void>()

function set(next: { grant?: Grant | null; status: MediaTokenStatus }) {
  if (next.grant !== undefined) grant = next.grant
  status = next.status
  listeners.forEach((listener) => listener())
}

export function mediaToken(username: string, now = Date.now()): string | null {
  return grant && grant.username === username && grant.expiresAt - now > MIN_TOKEN_LIFE_MS ? grant.token : null
}

export function mediaTokenStatus(): MediaTokenStatus { return status }

export function onMediaTokenChange(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

// Tests and the first render can seed a grant directly.
export function setMediaGrant(next: Grant | null) { set({ grant: next, status: next ? 'ready' : 'pending' }) }

// Keeps a token for this login while TomTube is open; returns the function that stops it.
export function startMediaTokens(login: Login, fetcher: typeof fetch = window.fetch.bind(window)): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let inFlight = false
  let renewAt = 0
  if (grant?.username !== login.username) set({ grant: null, status: 'pending' })

  const later = (ms: number) => { clearTimeout(timer); timer = setTimeout(() => void refresh(), ms) }

  async function refresh() {
    if (stopped || inFlight) return
    inFlight = true
    try {
      const response = await fetcher('/api/media-session', {
        method: 'POST',
        cache: 'no-store',
        credentials: 'omit',
        headers: { 'x-tomify-user': login.username, 'x-tomify-token': login.token, 'x-tomify-salt': login.salt },
      })
      if (stopped) return
      // 404: the Worker has no TOMIFY_MEDIA_KEY, which TomTube requires.
      if (response.status === 404) { set({ grant: null, status: 'not-configured' }); later(NOT_CONFIGURED_RETRY_MS); return }
      const body = response.ok ? await response.json().catch(() => null) as { token?: unknown; expiresAt?: unknown } | null : null
      if (stopped) return
      if (!body || typeof body.token !== 'string' || !body.token || typeof body.expiresAt !== 'number') {
        // Keep a still-valid token; the next attempt may succeed.
        set({ status: mediaToken(login.username) ? 'ready' : 'unavailable' })
        later(RETRY_MS)
        return
      }
      set({ grant: { username: login.username, token: body.token, expiresAt: body.expiresAt }, status: 'ready' })
      const wait = Math.max(RETRY_MS, (body.expiresAt - Date.now()) / 2)
      renewAt = Date.now() + wait
      later(wait)
    } catch {
      if (stopped) return
      set({ status: mediaToken(login.username) ? 'ready' : 'unavailable' })
      later(RETRY_MS)
    } finally { inFlight = false }
  }

  // Back in the foreground (timers may have been paused): renew if past half-life or missing.
  const visible = () => {
    if (document.visibilityState !== 'visible') return
    if (!mediaToken(login.username) || Date.now() >= renewAt) void refresh()
  }
  document.addEventListener('visibilitychange', visible)
  window.addEventListener('online', visible)
  void refresh()

  return () => {
    stopped = true
    clearTimeout(timer)
    document.removeEventListener('visibilitychange', visible)
    window.removeEventListener('online', visible)
  }
}
