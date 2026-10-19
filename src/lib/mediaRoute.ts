// Short-lived media sessions and LAN-direct streaming (roadmap 3.5; worker/features/media-session.ts,
// recovery-agent/lan.mjs). Once the Worker hands out media tokens, stream URLs carry `mt=<token>`
// instead of the Subsonic login. When the Worker also names the box's address on the home network
// and the box answers there quickly, streams come straight from the box; anything else streams
// through the Worker exactly as before.

export interface MediaGrant { token: string; expiresAt: number; lanOrigin: string | null }
// `origin` null means this origin (the Worker).
export interface MediaRoute { token: string; origin: string | null }
interface MediaLogin { username: string; token: string; salt: string }

export const LAN_PROBE_TIMEOUT_MS = 1500
// A token this close to expiry is no longer put in new URLs (a track may play for a while).
const USABLE_FOR_AT_LEAST_MS = 10 * 60_000
const NOT_CONFIGURED_RETRY_MS = 30 * 60_000
const FAILURE_RETRY_MS = 60_000
const LAN_RETRY_MS = 5 * 60_000

interface State { username: string; grant: MediaGrant | null; lan: boolean; recheckLan(): void; refreshSoon(): void }
let state: State | null = null

export function mediaRoute(username: string, now = Date.now()): MediaRoute | null {
  const grant = state?.username === username ? state.grant : null
  if (!grant || grant.expiresAt - now < USABLE_FOR_AT_LEAST_MS) return null
  return { token: grant.token, origin: state!.lan ? grant.lanOrigin : null }
}

export function isLanUrl(url: string | undefined) {
  const origin = state?.grant?.lanOrigin
  return Boolean(origin && url?.startsWith(`${origin}/`))
}

// A stream failed. If it came from the box (left home, box restarting), use the Worker until the box
// answers again; true tells the player it was a LAN stream. A failed token URL also asks for a new
// token soon, in case the key changed or the Worker stopped handing them out.
export function mediaStreamFailed(url: string | undefined) {
  if (!state || !url) return false
  if (state.grant && url.includes('mt=')) state.refreshSoon()
  if (!isLanUrl(url)) return false
  if (state.lan) { state.lan = false; state.recheckLan() }
  return true
}

// Only an https origin can be used: the app is served over HTTPS, so anything else is mixed content.
export function lanOriginFrom(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash ? url.origin : null
  } catch { return null }
}

// The box's LAN listener answers /lan/ping with CORS headers; a timeout or any failure means "not here".
export async function probeLan(origin: string, fetcher: typeof fetch, timeoutMs = LAN_PROBE_TIMEOUT_MS) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetcher(`${origin}/lan/ping`, { signal: controller.signal, cache: 'no-store', credentials: 'omit', mode: 'cors' })
    return response.ok
  } catch { return false } finally { clearTimeout(timer) }
}

function grantFrom(body: unknown): MediaGrant | null {
  const value = body as Partial<Record<keyof MediaGrant, unknown>> | null
  if (!value || typeof value.token !== 'string' || !value.token || typeof value.expiresAt !== 'number') return null
  return { token: value.token, expiresAt: value.expiresAt, lanOrigin: lanOriginFrom(value.lanOrigin) }
}

// Keeps a media session for this login while it is signed in; returns the function that stops it.
export function startMediaRoute(login: MediaLogin, fetcher: typeof fetch = window.fetch.bind(window)): () => void {
  let stopped = false
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let lanTimer: ReturnType<typeof setTimeout> | undefined
  let lastRefresh = 0
  const current: State = {
    username: login.username, grant: null, lan: false,
    recheckLan: () => { clearTimeout(lanTimer); lanTimer = setTimeout(checkLan, LAN_RETRY_MS) },
    refreshSoon: () => { if (Date.now() - lastRefresh >= FAILURE_RETRY_MS) void refresh() },
  }
  state = current

  async function checkLan() {
    clearTimeout(lanTimer)
    const origin = current.grant?.lanOrigin
    if (!origin) { current.lan = false; return }
    const reachable = await probeLan(origin, fetcher)
    if (stopped || current.grant?.lanOrigin !== origin) return
    current.lan = reachable
    if (!reachable) current.recheckLan()
  }

  function refreshIn(ms: number) {
    clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => void refresh(), ms)
  }

  async function refresh() {
    lastRefresh = Date.now()
    try {
      const response = await fetcher('/api/media-session', {
        method: 'POST',
        cache: 'no-store',
        headers: { 'x-tomify-user': login.username, 'x-tomify-token': login.token, 'x-tomify-salt': login.salt },
      })
      if (stopped) return
      // 404: the Worker has no TOMIFY_MEDIA_KEY, so stream URLs keep the login, as before. 401: the login no longer works.
      if (response.status === 404 || response.status === 401) { current.grant = null; current.lan = false; refreshIn(response.status === 404 ? NOT_CONFIGURED_RETRY_MS : FAILURE_RETRY_MS); return }
      const grant = response.ok ? grantFrom(await response.json().catch(() => null)) : null
      if (stopped) return
      if (!grant) { refreshIn(FAILURE_RETRY_MS); return }
      const lanChanged = grant.lanOrigin !== current.grant?.lanOrigin
      current.grant = grant
      if (lanChanged) current.lan = false
      refreshIn(Math.max(FAILURE_RETRY_MS, (grant.expiresAt - Date.now()) / 2))
      void checkLan()
    } catch {
      if (!stopped) refreshIn(FAILURE_RETRY_MS)
    }
  }

  // Joining or leaving a network: look for the box again.
  const networkChanged = () => { if (!stopped) void checkLan() }
  const connection = (navigator as Navigator & { connection?: EventTarget }).connection
  window.addEventListener('online', networkChanged)
  connection?.addEventListener?.('change', networkChanged)
  void refresh()

  return () => {
    stopped = true
    clearTimeout(refreshTimer)
    clearTimeout(lanTimer)
    window.removeEventListener('online', networkChanged)
    connection?.removeEventListener?.('change', networkChanged)
    if (state === current) state = null
  }
}
