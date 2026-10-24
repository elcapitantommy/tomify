// Jellyfin sign-in for Tomifin Downloader. The agent talks to Jellyfin on the box (TOMIFY_JELLYFIN_URL: HTTPS, or
// plain HTTP to an address of this machine itself, such as 127.0.0.1 or the box's own LAN address that a Docker
// container publishes Jellyfin on), so Jellyfin need not be reachable from the internet. Only Jellyfin administrators may use Tomifin.
// The agent never stores a password: it hands Jellyfin's access token back to the Worker, which keeps it in an
// HttpOnly cookie, and checks that token with Jellyfin (cached for 30 seconds) on every Tomifin request.
import { randomUUID } from 'node:crypto'
import { networkInterfaces } from 'node:os'

const CHECK_CACHE_MS = 30_000
const CACHE_LIMIT = 200
const TOKEN = /^[A-Za-z0-9-]{16,128}$/

export class JellyfinAuthError extends Error {
  constructor(code, message) { super(message); this.name = 'JellyfinAuthError'; this.code = code }
}

function text(value) { return String(value ?? '').trim() }

// The IP addresses of this machine's own network interfaces. Traffic to them never leaves the machine.
function ownAddresses() {
  return Object.values(networkInterfaces()).flat().filter(Boolean).map((entry) => entry.address.toLowerCase())
}

export function jellyfinConfig(env = process.env, { localAddresses = ownAddresses } = {}) {
  const raw = text(env.TOMIFY_JELLYFIN_URL)
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { throw new Error('TOMIFY_JELLYFIN_URL must be a URL.') }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  // Plain HTTP is allowed only to this machine itself, so the password never crosses the network unencrypted.
  const local = ['localhost', '::1'].includes(host) || /^127\./.test(host) || localAddresses().includes(host)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) throw new Error('TOMIFY_JELLYFIN_URL must use HTTPS, or plain HTTP to an address of this machine (127.0.0.1 or its own LAN address).')
  if (url.username || url.password) throw new Error('TOMIFY_JELLYFIN_URL must not contain a username or password.')
  return { url: url.toString().replace(/\/$/, '') }
}

function header({ token, deviceId } = {}) {
  const parts = ['Client="Tomifin Downloader"', 'Device="Tomifin"', `DeviceId="${deviceId || 'tomifin'}"`, 'Version="1.0.0"']
  if (token) parts.push(`Token="${token}"`)
  return `MediaBrowser ${parts.join(', ')}`
}

function account(user) {
  return { id: text(user?.Id), name: text(user?.Name).slice(0, 128), isAdmin: user?.Policy?.IsAdministrator === true, disabled: user?.Policy?.IsDisabled === true }
}

export function createJellyfinAuth(config, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  const checked = new Map()

  async function call(path, { method = 'GET', token, body, deviceId } = {}) {
    if (!config) throw new JellyfinAuthError('not-configured', 'Jellyfin sign-in is not set up on the media server (TOMIFY_JELLYFIN_URL).')
    let response
    try {
      response = await fetchImpl(`${config.url}${path}`, {
        method, signal: AbortSignal.timeout(15_000),
        headers: { accept: 'application/json', authorization: header({ token, deviceId }), ...(body ? { 'content-type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      })
    } catch { throw new JellyfinAuthError('jellyfin-unavailable', 'Jellyfin could not be reached from the media server.') }
    return response
  }

  async function revoke(token) {
    checked.delete(token)
    await call('/Sessions/Logout', { method: 'POST', token }).catch(() => {})
  }

  return {
    configured: Boolean(config),

    // Signs in with a Jellyfin username and password. Anyone who is not a Jellyfin administrator is refused, and
    // the session Jellyfin opened for them is closed again straight away.
    async login(body) {
      const username = text(body?.username)
      const password = String(body?.password ?? '')
      if (!username || username.length > 128) throw new JellyfinAuthError('invalid-login', 'Enter your Jellyfin username.')
      if (password.length > 512) throw new JellyfinAuthError('invalid-login', 'That password is too long.')
      const response = await call('/Users/AuthenticateByName', { method: 'POST', body: { Username: username, Pw: password }, deviceId: `tomifin-${randomUUID()}` })
      if (response.status === 401 || response.status === 403) throw new JellyfinAuthError('invalid-login', 'Jellyfin did not accept that username and password.')
      if (!response.ok) throw new JellyfinAuthError('jellyfin-unavailable', `Jellyfin sign-in returned HTTP ${response.status}.`)
      const payload = await response.json().catch(() => null)
      const token = text(payload?.AccessToken)
      const user = account(payload?.User)
      if (!TOKEN.test(token)) throw new JellyfinAuthError('jellyfin-unavailable', 'Jellyfin did not return a session.')
      if (!user.isAdmin || user.disabled) { await revoke(token); throw new JellyfinAuthError('forbidden', 'Only Jellyfin administrators can use Tomifin Downloader.') }
      checked.set(token, { at: now(), user })
      return { token, user: { name: user.name } }
    },

    // Checks a session token with Jellyfin, and that its user is still an administrator.
    async verify(token) {
      const value = text(token)
      if (!TOKEN.test(value)) throw new JellyfinAuthError('unauthorized', 'Sign in with your Jellyfin account.')
      const cached = checked.get(value)
      if (cached && now() - cached.at < CHECK_CACHE_MS) return cached.user
      const response = await call('/Users/Me', { token: value })
      if (response.status === 401 || response.status === 403) { checked.delete(value); throw new JellyfinAuthError('unauthorized', 'Your Jellyfin session has ended. Sign in again.') }
      if (!response.ok) throw new JellyfinAuthError('jellyfin-unavailable', `Jellyfin returned HTTP ${response.status}.`)
      const user = account(await response.json().catch(() => null))
      if (!user.isAdmin || user.disabled) { checked.delete(value); throw new JellyfinAuthError('forbidden', 'Only Jellyfin administrators can use Tomifin Downloader.') }
      checked.set(value, { at: now(), user })
      while (checked.size > CACHE_LIMIT) checked.delete(checked.keys().next().value)
      return user
    },

    async logout(token) {
      if (TOKEN.test(text(token))) await revoke(text(token))
      return { signedOut: true }
    },
  }
}

// Asks Jellyfin to scan its libraries (POST /Library/Refresh) after Tomifin has published something, so it shows up
// without waiting for Jellyfin's own schedule. Off unless TOMIFY_JELLYFIN_API_KEY holds an API key made in Jellyfin's
// dashboard (Administration → API Keys). The key stays in the agent: it is sent only to TOMIFY_JELLYFIN_URL and never
// logged. Several publications close together lead to one scan, delayMs after the first.
export function createJellyfinLibraryRefresh(config, { apiKey = process.env.TOMIFY_JELLYFIN_API_KEY, fetchImpl = fetch, delayMs = 10_000, log = () => {} } = {}) {
  const key = text(apiKey)
  if (!config || !key) return null
  if (!/^[A-Za-z0-9]{16,128}$/.test(key)) { log('Jellyfin library scans after Tomifin downloads are off: TOMIFY_JELLYFIN_API_KEY is not a Jellyfin API key.'); return null }
  let pending = null
  return function refreshLibrary() {
    if (pending) return pending
    pending = new Promise((done) => setTimeout(done, delayMs)).then(async () => {
      pending = null
      const response = await fetchImpl(`${config.url}/Library/Refresh`, { method: 'POST', signal: AbortSignal.timeout(15_000), headers: { authorization: header({ token: key }) } })
      if (!response.ok) throw new Error(`Jellyfin answered HTTP ${response.status} to the library scan.`)
      log('Tomifin asked Jellyfin to scan its libraries')
    })
    return pending
  }
}
