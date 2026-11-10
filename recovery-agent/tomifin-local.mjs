// Tomifin Downloader's front door on the tailnet (docs/TOMIFIN.md, "On the tailnet"). A second HTTP listener on
// 127.0.0.1 only, which Caddy on the box reaches as https://down.tn.tomdixon.uk. It serves the page built by
// `pnpm build:tomifin` (the release's tomifin-web/ folder), signs in with Jellyfin administrator accounts and answers
// /api/tomifin/* by calling the Tomifin handlers (handleTomifinRequest in recovery-agent/tomifin.mjs) in this process:
// no Recovery token, no Cloudflare Access headers, no agent version check. Nothing but Tomifin is reachable through
// it, and this is the only way to reach Tomifin: the Recovery listener, which the Cloudflare tunnel reaches, does not
// serve /v1/tomifin/*.
//
// The session cookie holds the Jellyfin access token sealed with TOMIFY_TOMIFIN_SESSION_SECRET (AES-256-GCM) and an
// expiry, so the page never sees the token, a cookie cannot be forged or extended, and sessions outlive a restart.
// Jellyfin still checks the token on every request (recovery-agent/jellyfin.mjs).
import { createServer } from 'node:http'
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, join, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'

export const LOCAL_HOST = '127.0.0.1'
export const DEFAULT_LOCAL_ORIGIN = 'https://down.tn.tomdixon.uk'
export const COOKIE = 'tomifin_session'
export const SESSION_HOURS = 12
// 32 random bytes as base64 (`openssl rand -base64 32`) is 44 characters.
const MINIMUM_SECRET_LENGTH = 44
const LOGIN_FAILURES_PER_MINUTE = 5
const LOGIN_CLIENTS_TRACKED = 1000

const DESTINATIONS = new Set(['family', 'private'])
const KINDS = new Set(['video', 'movies', 'tv'])
const RESULT_ID = /^[a-f0-9]{64}$/
const JOB_ROUTE = /^\/api\/tomifin\/downloads\/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})\/(pause|resume|force-start|retry|trackers|cancel)$/
const STATUS_FOR_CODE = {
  unauthorized: 401, 'invalid-login': 401, forbidden: 403, duplicate: 409, 'result-expired': 409, busy: 409, 'not-retryable': 409, 'not-startable': 409, 'private-torrent': 409, 'not-a-torrent': 409, 'trackers-unavailable': 502, unconfirmed: 504, 'not-configured': 503, 'usenet-unavailable': 503,
  'jellyfin-unavailable': 502, 'sabnzbd-refused': 502, 'indexer-unavailable': 502, 'indexer-refused': 502, 'too-large': 413,
}
const MAX_LINK_LENGTH = 8000
const MAX_UPLOAD_BASE64 = Math.ceil((10 * 1024 * 1024) / 3) * 4 + 4
const SMALL_BODY = 64 * 1024
const LINK_BODY = 16 * 1024 * 1024

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json', '.woff2': 'font/woff2', '.map': 'application/json',
}
// The page loads only its own scripts, styles, fonts and images (fonts are bundled, nothing comes from Google). React
// sets some inline styles.
const PAGE_HEADERS = {
  'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  'x-robots-tag': 'noindex, nofollow', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff',
}

function text(value) { return String(value ?? '').trim() }

// Off (with no problem) unless TOMIFY_TOMIFIN_LOCAL_PORT is set. The host is always 127.0.0.1: Caddy is the way in.
export function tomifinLocalConfig(env = process.env, { recoveryToken = '', defaultWebDir = '' } = {}) {
  const rawPort = text(env.TOMIFY_TOMIFIN_LOCAL_PORT)
  const secret = text(env.TOMIFY_TOMIFIN_SESSION_SECRET)
  const rawOrigin = text(env.TOMIFY_TOMIFIN_LOCAL_ORIGIN) || DEFAULT_LOCAL_ORIGIN
  const webDir = resolve(text(env.TOMIFY_TOMIFIN_WEB_DIR) || defaultWebDir || 'tomifin-web')
  const config = { enabled: false, problem: null, host: LOCAL_HOST, port: 0, secret, origin: '', webDir }
  if (!rawPort) return config
  const port = Number(rawPort)
  if (!/^\d+$/.test(rawPort) || !Number.isInteger(port) || port < 1 || port > 65535) return { ...config, problem: 'TOMIFY_TOMIFIN_LOCAL_PORT must be a port number.' }
  if (secret.length < MINIMUM_SECRET_LENGTH) return { ...config, port, problem: `TOMIFY_TOMIFIN_SESSION_SECRET must hold at least 32 random bytes (${MINIMUM_SECRET_LENGTH}+ characters; openssl rand -base64 48).` }
  if (recoveryToken && secret === text(recoveryToken)) return { ...config, port, problem: 'TOMIFY_TOMIFIN_SESSION_SECRET must not be the Recovery token.' }
  let origin
  try { origin = new URL(rawOrigin) } catch { return { ...config, port, problem: 'TOMIFY_TOMIFIN_LOCAL_ORIGIN must be a URL such as https://down.tn.tomdixon.uk.' } }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== rawOrigin.replace(/\/$/, '')) return { ...config, port, problem: 'TOMIFY_TOMIFIN_LOCAL_ORIGIN must be an https origin with no path, such as https://down.tn.tomdixon.uk.' }
  return { ...config, enabled: true, port, origin: origin.origin }
}

function sessionKey(secret) { return createHash('sha256').update('tomifin-local-session\0').update(secret).digest() }

// `base64url(iv).base64url(ciphertext+tag)` over JSON [1, expiresAt, token].
export function sealSession(secret, token, expiresAt) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', sessionKey(secret), iv)
  const data = Buffer.concat([cipher.update(JSON.stringify([1, expiresAt, token]), 'utf8'), cipher.final(), cipher.getAuthTag()])
  return `${iv.toString('base64url')}.${data.toString('base64url')}`
}

// The session, or null for anything that was not sealed with this secret. An expired session is returned with
// expired: true, so its Jellyfin token can be signed out.
export function openSession(secret, value, now = Date.now()) {
  try {
    const [iv, sealed, extra] = String(value || '').split('.')
    const nonce = Buffer.from(iv || '', 'base64url')
    const data = Buffer.from(sealed || '', 'base64url')
    if (extra !== undefined || nonce.length !== 12 || data.length <= 16 || !secret) return null
    const decipher = createDecipheriv('aes-256-gcm', sessionKey(secret), nonce)
    decipher.setAuthTag(data.subarray(data.length - 16))
    const [version, expiresAt, token] = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8'))
    if (version !== 1 || !Number.isFinite(expiresAt) || typeof token !== 'string' || !token) return null
    return { token, expiresAt, expired: !(expiresAt > now) }
  } catch { return null }
}

function cookieValue(request) {
  for (const part of String(request.headers.cookie || '').split(';')) {
    const [name, ...value] = part.trim().split('=')
    if (name === COOKIE) { try { return decodeURIComponent(value.join('=')) || null } catch { return null } }
  }
  return null
}

// Host-only (no Domain), so only down.tn gets it, and only for the API.
function sessionCookie(value) {
  return value
    ? `${COOKIE}=${encodeURIComponent(value)}; Path=/api/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_HOURS * 3600}`
    : `${COOKIE}=; Path=/api/tomifin; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

// The client's address as Caddy saw it. Caddy trusts no incoming X-Forwarded-For by default and sets its own, and
// only Caddy can reach 127.0.0.1, so the last entry is the client.
function clientAddress(request) {
  const forwarded = String(request.headers['x-forwarded-for'] || '').split(',').map((entry) => entry.trim()).filter(Boolean)
  return forwarded.at(-1) || request.socket?.remoteAddress || 'unknown'
}

// At most LOGIN_FAILURES_PER_MINUTE failed sign-ins per client in any minute.
export function createLoginLimiter({ now = Date.now, limit = LOGIN_FAILURES_PER_MINUTE, windowMs = 60_000 } = {}) {
  const failures = new Map()
  const recent = (client) => (failures.get(client) || []).filter((at) => now() - at < windowMs)
  return {
    blocked(client) { return recent(client).length >= limit },
    failed(client) {
      const kept = [...recent(client), now()]
      // Re-inserted, so the client seen longest ago is dropped first when too many are tracked.
      failures.delete(client)
      failures.set(client, kept)
      while (failures.size > LOGIN_CLIENTS_TRACKED) failures.delete(failures.keys().next().value)
    },
  }
}

class BodyError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code }
}

async function readJson(request, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of request) {
    size += chunk.length
    if (size > limit) throw new BodyError(413, 'too-large', 'The request is too large.')
    chunks.push(chunk)
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || 'null') } catch { return null }
}

function send(response, status, body, headers = {}) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers })
  response.end(JSON.stringify(body))
}

function within(child, parent) { return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep) }

// handle(path, body) is handleTomifinRequest bound to the controller and Jellyfin sign-in: it answers only
// /v1/tomifin/<action>. cleanMessage strips anything that must not reach the page from an unexpected error.
export function createTomifinLocalHandler({ config, handle, cleanMessage = (message) => message, now = Date.now, log = () => {}, limiter = createLoginLimiter({ now }) }) {
  const webRoot = resolve(config.webDir)

  async function call(path, body, status = 200) {
    let result
    try { result = await handle(path, body) }
    catch (error) { return { status: 502, body: { error: 'agent-error', message: cleanMessage(error instanceof Error ? error.message : 'Tomifin could not do that.') } } }
    if (!result) return { status: 404, body: { error: 'not-found' } }
    if (result.body?.error === 'tomifin-error') {
      const code = String(result.body.code || 'tomifin-error')
      return { status: STATUS_FOR_CODE[code] || 400, body: { error: code, message: result.body.message }, signOut: code === 'unauthorized' || code === 'forbidden' }
    }
    return { status: result.status === 200 ? status : result.status, body: result.body }
  }

  function reply(response, outcome, cookie) {
    send(response, outcome.status, outcome.body, cookie !== undefined ? { 'set-cookie': sessionCookie(cookie) } : outcome.signOut ? { 'set-cookie': sessionCookie(null) } : {})
  }

  const unauthorized = (response) => send(response, 401, { error: 'unauthorized' }, { 'set-cookie': sessionCookie(null) })
  const invalid = (response, error, message) => send(response, 400, { error, message })

  async function api(request, response, url) {
    const method = request.method || 'GET'
    // Changes must come from the page on its own address: the browser always sends Origin on these, a cross-site
    // form cannot set x-tomifin, and the cookie is SameSite=Strict.
    if (method !== 'GET' && method !== 'HEAD') {
      if (request.headers.origin !== config.origin) return send(response, 403, { error: 'forbidden', message: 'This request did not come from Tomifin.' })
      if (request.headers['x-tomifin'] !== '1') return send(response, 403, { error: 'forbidden', message: 'Missing request header.' })
    }
    const body = method === 'POST' ? await readJson(request, url.pathname === '/api/tomifin/link' ? LINK_BODY : SMALL_BODY) : null

    if (url.pathname === '/api/tomifin/session' && method === 'POST') {
      const client = clientAddress(request)
      if (limiter.blocked(client)) return send(response, 429, { error: 'too-many-attempts', message: 'Too many failed sign-ins. Wait a minute and try again.' }, { 'retry-after': '60' })
      const username = typeof body?.username === 'string' ? body.username.trim() : ''
      const password = typeof body?.password === 'string' ? body.password : ''
      if (!username || username.length > 128) return invalid(response, 'invalid-login', 'Enter your Jellyfin username.')
      if (password.length > 512) return invalid(response, 'invalid-login', 'That password is too long.')
      const outcome = await call('/v1/tomifin/login', { username, password })
      if (outcome.status !== 200) {
        if (outcome.body?.error === 'invalid-login' || outcome.body?.error === 'forbidden') { limiter.failed(client); log(`Tomifin: a sign-in from ${client} was refused`) }
        return reply(response, outcome)
      }
      const { token, user } = outcome.body
      log(`Tomifin: ${user.name} signed in`)
      return send(response, 200, { user }, { 'set-cookie': sessionCookie(sealSession(config.secret, token, now() + SESSION_HOURS * 3600_000)) })
    }

    const session = openSession(config.secret, cookieValue(request), now())
    if (url.pathname === '/api/tomifin/session' && method === 'DELETE') {
      if (session) await call('/v1/tomifin/logout', { session: session.token })
      return send(response, 200, { signedOut: true }, { 'set-cookie': sessionCookie(null) })
    }
    if (!session) return unauthorized(response)
    if (session.expired) {
      // Signs the expired session out of Jellyfin too, without holding up the answer.
      Promise.resolve(call('/v1/tomifin/logout', { session: session.token })).catch(() => {})
      return unauthorized(response)
    }
    const authed = (path, extra = {}, status) => call(path, { session: session.token, ...extra }, status).then((outcome) => reply(response, outcome))

    if (url.pathname === '/api/tomifin/session' && method === 'GET') return authed('/v1/tomifin/session')
    if (url.pathname === '/api/tomifin/status' && method === 'GET') return authed('/v1/tomifin/status')
    if (url.pathname === '/api/tomifin/vpn' && method === 'GET') return authed('/v1/tomifin/vpn')
    if (url.pathname === '/api/tomifin/downloads' && method === 'GET') return authed('/v1/tomifin/downloads')

    if (url.pathname === '/api/tomifin/search' && method === 'GET') {
      const query = (url.searchParams.get('q') || '').replace(/\s+/g, ' ').trim()
      const kind = url.searchParams.get('kind') || 'video'
      if (query.length < 2) return invalid(response, 'invalid-query', 'Type at least two characters to search.')
      if (query.length > 200) return invalid(response, 'invalid-query', 'The search is too long (200 characters at most).')
      if (!KINDS.has(kind)) return invalid(response, 'invalid-kind', 'Choose films, TV or both.')
      return authed('/v1/tomifin/search', { query, kind })
    }

    if (url.pathname === '/api/tomifin/download' && method === 'POST') {
      const destination = typeof body?.destination === 'string' ? body.destination : ''
      const resultId = typeof body?.resultId === 'string' ? body.resultId : ''
      if (!DESTINATIONS.has(destination)) return invalid(response, 'invalid-destination', 'Choose Family or Private before downloading.')
      if (!RESULT_ID.test(resultId)) return invalid(response, 'invalid-result', 'Choose a search result to download.')
      const outcome = await call('/v1/tomifin/download', { session: session.token, resultId, destination }, 202)
      if (outcome.status === 202) log(`Tomifin: queued a download for ${destination}`)
      return reply(response, outcome)
    }

    if (url.pathname === '/api/tomifin/link' && method === 'POST') {
      const link = typeof body?.link === 'string' ? body.link.trim() : ''
      const file = body?.file && typeof body.file === 'object' ? body.file : null
      if (Boolean(link) === Boolean(file)) return invalid(response, 'invalid-link', 'Paste one link, or choose one .torrent or .nzb file.')
      if (link) {
        if (link.length > MAX_LINK_LENGTH) return invalid(response, 'invalid-link', 'The link is too long.')
        if (!/^(?:magnet:\?|https?:\/\/)/i.test(link)) return invalid(response, 'invalid-link', 'Paste a magnet link, or an http(s) link to a .torrent or .nzb file.')
        return authed('/v1/tomifin/link', { link })
      }
      const name = typeof file.name === 'string' ? file.name.slice(0, 255) : ''
      const data = typeof file.data === 'string' ? file.data : ''
      if (!data) return invalid(response, 'invalid-link', 'That file could not be read.')
      if (data.length > MAX_UPLOAD_BASE64) return send(response, 413, { error: 'too-large', message: 'That file is too large to upload (10 MiB at most).' })
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return invalid(response, 'invalid-link', 'That file could not be read.')
      return authed('/v1/tomifin/link', { file: { name, data } })
    }

    const job = url.pathname.match(JOB_ROUTE)
    if (job && method === 'POST') {
      const outcome = await call(`/v1/tomifin/${job[2]}`, { session: session.token, id: job[1] })
      if (outcome.status === 200 && job[2] !== 'pause' && job[2] !== 'resume') log(`Tomifin: ${job[2]} for download ${job[1]}`)
      return reply(response, outcome)
    }
    return send(response, 404, { error: 'not-found' })
  }

  async function file(path) {
    try {
      const real = await realpath(path)
      if (!within(real, await realpath(webRoot))) return null
      const info = await stat(real)
      return info.isFile() ? { path: real, size: info.size } : null
    } catch { return null }
  }

  async function page(request, response, url) {
    const method = request.method || 'GET'
    if (method !== 'GET' && method !== 'HEAD') return send(response, 405, { error: 'method-not-allowed' }, { allow: 'GET, HEAD' })
    let pathname
    try { pathname = decodeURIComponent(url.pathname) } catch { return send(response, 400, { error: 'bad-path' }) }
    const wanted = resolve(webRoot, '.' + pathname)
    if (pathname.includes('\0') || !within(wanted, webRoot)) return send(response, 404, { error: 'not-found' })
    let found = pathname.endsWith('/') ? null : await file(wanted)
    // Paths without a file extension are the page, so direct navigation and refreshes work; a missing file is not.
    if (!found && extname(pathname) && pathname !== '/index.html') return send(response, 404, { error: 'not-found' })
    const isPage = !found || extname(found.path) === '.html'
    if (!found) found = await file(join(webRoot, 'index.html'))
    if (!found) return send(response, 503, { error: 'not-installed', message: 'Tomifin is not installed in this release.' })
    const hashed = pathname.startsWith('/assets/')
    response.writeHead(200, {
      'content-type': CONTENT_TYPES[extname(found.path)] || 'application/octet-stream',
      'content-length': String(found.size),
      'cache-control': hashed ? 'public, max-age=31536000, immutable' : 'no-cache',
      ...(isPage ? PAGE_HEADERS : { 'x-content-type-options': 'nosniff' }),
    })
    if (method === 'HEAD') return response.end()
    await pipeline(createReadStream(found.path), response)
  }

  return async function tomifinLocal(request, response) {
    let url
    try { url = new URL(request.url || '/', 'http://tomifin.local') } catch { return send(response, 400, { error: 'bad-path' }) }
    try {
      if (url.pathname === '/api/tomifin' || url.pathname.startsWith('/api/tomifin/')) return await api(request, response, url)
      // Recovery's routes and Tomify's APIs are never reachable here, not even as the page.
      if (['/api', '/v1', '/navidrome', '/health'].some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return send(response, 404, { error: 'not-found' })
      return await page(request, response, url)
    } catch (error) {
      if (error instanceof BodyError) return send(response, error.status, { error: error.code, message: error.message })
      log(`Tomifin local listener failed a request: ${cleanMessage(error instanceof Error ? error.message : String(error))}`)
      if (!response.headersSent) return send(response, 500, { error: 'internal-error', message: 'Tomifin could not answer that.' })
      response.destroy()
    }
  }
}

// Starts the listener, or logs why not and returns null: Recovery keeps running either way.
export async function startTomifinLocalServer(config, handler, { log = () => {} } = {}) {
  const index = await stat(join(config.webDir, 'index.html')).catch(() => null)
  if (!index?.isFile()) { log(`Tomifin local listener is off: ${join(config.webDir, 'index.html')} is missing (deploy with deploy-agent, which builds the page).`); return null }
  const server = createServer(handler)
  server.headersTimeout = 30_000
  server.requestTimeout = 120_000
  return new Promise((done) => {
    server.once('error', (error) => {
      log(error?.code === 'EADDRINUSE'
        ? `Tomifin local listener is off: 127.0.0.1:${config.port} is already in use by another service. Set TOMIFY_TOMIFIN_LOCAL_PORT to a free port (8791 on the box), update Caddy's reverse_proxy to match, and restart tomify-recovery. Recovery keeps running.`
        : `Tomifin local listener is off: ${error.message}`)
      done(null)
    })
    server.listen(config.port, LOCAL_HOST, () => { log(`Tomifin listening on http://${LOCAL_HOST}:${config.port} for ${config.origin}`); done(server) })
  })
}
