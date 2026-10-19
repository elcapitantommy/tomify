// LAN-direct streaming (roadmap 3.5). At home the player can fetch audio from the box itself
// instead of through Cloudflare. The app is served over HTTPS, so this listener is HTTPS too, with a
// real certificate for a LAN hostname (see docs/DEPLOYMENT.md, "LAN-direct streaming"). It mirrors
// the Worker's media paths so the player only swaps the origin:
//   GET  /lan/ping                                    reachability probe (CORS, no token)
//   GET  /navidrome/rest/stream.view?id=…&mt=<token>  the original file, from Navidrome on the box
//   GET  /api/hls/<trackId>/[<gain>/]<file>?mt=<token> adaptive streaming, as /v1/hls/
// It accepts only media tokens: the listener's Navidrome login sealed by the Worker with
// TOMIFY_MEDIA_KEY (worker/lib/seal.ts), with an expiry. A long-lived login is never accepted here.
import { createServer } from 'node:https'
import { createReadStream } from 'node:fs'
import { readFile, stat } from 'node:fs/promises'
import { createDecipheriv, createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { HlsError, parseHlsPath } from './hls.mjs'

export const DEFAULT_LAN_ALLOWED_ORIGINS = Object.freeze(['https://app.tomify.tomdixon.uk'])
const MINIMUM_MEDIA_KEY_LENGTH = 32
const TLS_RELOAD_MS = 12 * 3600_000
const STREAM_PATH = /^\/navidrome\/rest\/stream(?:\.view)?$/
const FORWARDED_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']

// Off unless the port, both certificate files and the media key are all set.
export function lanConfig(env = process.env) {
  const port = Number(String(env.TOMIFY_LAN_PORT || '').trim() || 0)
  const certFile = String(env.TOMIFY_LAN_TLS_CERT || '').trim()
  const keyFile = String(env.TOMIFY_LAN_TLS_KEY || '').trim()
  const mediaKey = String(env.TOMIFY_MEDIA_KEY || '').trim()
  const allowedOrigins = String(env.TOMIFY_LAN_ALLOWED_ORIGINS || '').split(',').map((origin) => origin.trim().replace(/\/+$/, '')).filter(Boolean)
  const config = { enabled: false, problem: null, host: String(env.TOMIFY_LAN_HOST || '').trim() || '0.0.0.0', port, certFile, keyFile, mediaKey, allowedOrigins: allowedOrigins.length ? allowedOrigins : [...DEFAULT_LAN_ALLOWED_ORIGINS] }
  if (!port && !certFile && !keyFile) return config
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { ...config, problem: 'TOMIFY_LAN_PORT must be a port number.' }
  if (!certFile || !keyFile) return { ...config, problem: 'TOMIFY_LAN_TLS_CERT and TOMIFY_LAN_TLS_KEY must both name files.' }
  if (mediaKey.length < MINIMUM_MEDIA_KEY_LENGTH) return { ...config, problem: `TOMIFY_MEDIA_KEY must match the Worker's and contain at least ${MINIMUM_MEDIA_KEY_LENGTH} characters.` }
  return { ...config, enabled: true }
}

// The Worker's seal(): AES-256-GCM, key = SHA-256 of the secret, `base64(iv).base64(ciphertext+tag)`,
// sealing JSON [expiresAt, user, token, salt]. Returns the login, or null for anything else.
export function openMediaToken(secret, value, now = Date.now()) {
  try {
    const [iv, sealed, extra] = String(value || '').split('.')
    const nonce = Buffer.from(iv, 'base64')
    const data = Buffer.from(sealed, 'base64')
    if (extra !== undefined || nonce.length !== 12 || data.length <= 16 || !secret) return null
    const decipher = createDecipheriv('aes-256-gcm', createHash('sha256').update(secret).digest(), nonce)
    decipher.setAuthTag(data.subarray(data.length - 16))
    const [expiresAt, user, token, salt] = JSON.parse(Buffer.concat([decipher.update(data.subarray(0, data.length - 16)), decipher.final()]).toString('utf8'))
    if (!(Number(expiresAt) > now) || typeof user !== 'string' || !user || !/^[a-f0-9]{32}$/i.test(token) || !/^[A-Za-z0-9]{1,64}$/.test(salt)) return null
    return { user, token, salt }
  } catch { return null }
}

// Same as the Worker's signPlaylist: each playlist line naming another playlist or chunk gets the token.
export function signLanPlaylist(playlist, query) {
  return playlist.split('\n').map((line) => /^(?:v[0-9]\/index\.m3u8|seg\d{5}\.ts)$/.test(line.trim()) ? `${line.trim()}?${query}` : line).join('\n')
}

// CORS for the app's origin. Chrome asks before a public site reaches a private address (Private
// Network Access / Local Network Access); the preflight answer says this server allows it.
export function corsHeaders(config, headers) {
  const origin = String(headers.origin || '')
  const result = { vary: 'Origin' }
  if (!config.allowedOrigins.includes(origin)) return result
  result['access-control-allow-origin'] = origin
  result['access-control-expose-headers'] = 'content-length, content-range, accept-ranges'
  return result
}

function sendJson(response, status, body, headers) {
  response.writeHead(status, { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

export function createLanHandler({ config, hls, navidromeUrl, fetch: fetcher = globalThis.fetch, now = Date.now, log = () => {} }) {
  async function stream(request, response, url, login, cors) {
    const upstream = new URL(`${navidromeUrl}/rest/stream.view`)
    for (const [key, value] of url.searchParams) if (!['mt', 'u', 't', 's', 'p'].includes(key)) upstream.searchParams.append(key, value)
    upstream.searchParams.set('u', login.user)
    upstream.searchParams.set('t', login.token)
    upstream.searchParams.set('s', login.salt)
    const headers = request.headers.range ? { range: String(request.headers.range) } : {}
    let answer
    try { answer = await fetcher(upstream, { method: request.method, headers }) }
    catch { return sendJson(response, 502, { error: 'navidrome-unreachable' }, cors) }
    const out = { ...cors, 'cache-control': 'private, no-store' }
    for (const name of FORWARDED_HEADERS) { const value = answer.headers.get(name); if (value) out[name] = value }
    response.writeHead(answer.status, out)
    if (request.method === 'HEAD' || !answer.body) return response.end()
    await pipeline(Readable.fromWeb(answer.body), response)
  }

  async function adaptive(request, response, target, login, mt, cors) {
    const result = await hls.handle(target, { ...login, origin: null })
    if (result.body !== undefined) {
      response.writeHead(200, { ...cors, 'content-type': result.contentType, 'cache-control': 'no-store' })
      return response.end(request.method === 'HEAD' ? undefined : signLanPlaylist(result.body, new URLSearchParams({ mt }).toString()))
    }
    const details = await stat(result.filePath)
    response.writeHead(200, { ...cors, 'content-type': result.contentType, 'content-length': String(details.size), 'cache-control': 'private, max-age=86400' })
    if (request.method === 'HEAD') return response.end()
    await pipeline(createReadStream(result.filePath), response)
  }

  return async function handleLanRequest(request, response) {
    const cors = corsHeaders(config, request.headers)
    try {
      const url = new URL(request.url || '/', 'https://lan')
      if (request.method === 'OPTIONS') {
        if (!cors['access-control-allow-origin']) return sendJson(response, 403, { error: 'origin-not-allowed' }, cors)
        const preflight = { ...cors, 'access-control-allow-methods': 'GET, HEAD', 'access-control-allow-headers': 'range', 'access-control-max-age': '600' }
        if (String(request.headers['access-control-request-private-network'] || '') === 'true') preflight['access-control-allow-private-network'] = 'true'
        response.writeHead(204, preflight)
        return response.end()
      }
      if (request.method !== 'GET' && request.method !== 'HEAD') return sendJson(response, 405, { error: 'method-not-allowed' }, cors)
      if (url.pathname === '/lan/ping') return sendJson(response, 200, { ok: true }, cors)
      const hlsTarget = url.pathname.startsWith('/api/hls/') ? parseHlsPath(`/v1/hls/${url.pathname.slice('/api/hls/'.length)}`) : null
      if (!hlsTarget && !STREAM_PATH.test(url.pathname)) return sendJson(response, 404, { error: 'not-found' }, cors)
      const mt = url.searchParams.get('mt') || ''
      const login = openMediaToken(config.mediaKey, mt, now())
      if (!login) return sendJson(response, 401, { error: 'unauthorized' }, cors)
      if (hlsTarget) return await adaptive(request, response, hlsTarget, login, mt, cors)
      return await stream(request, response, url, login, cors)
    } catch (error) {
      if (response.headersSent) return response.destroy()
      if (error instanceof HlsError) return sendJson(response, error.status, { error: error.code, message: error.message }, cors)
      log(`LAN request failed: ${error instanceof Error ? error.message : String(error)}`)
      return sendJson(response, 502, { error: 'lan-failed' }, cors)
    }
  }
}

// certbot renews the certificate every couple of months; the listener picks the new files up
// twice a day, so a renewal needs no restart.
export async function startLanServer(config, handler, { log = () => {}, reloadMs = TLS_RELOAD_MS } = {}) {
  const tls = async () => ({ cert: await readFile(config.certFile), key: await readFile(config.keyFile) })
  const server = createServer(await tls(), handler)
  const reload = setInterval(() => { tls().then((context) => server.setSecureContext(context), (error) => log(`LAN certificate reload failed: ${error.message}`)) }, reloadMs)
  reload.unref?.()
  server.on('close', () => clearInterval(reload))
  await new Promise((resolvePromise, reject) => { server.once('error', reject); server.listen(config.port, config.host, () => { server.off('error', reject); resolvePromise() }) })
  log(`Tomify LAN streaming listening on https://${config.host}:${config.port}`)
  return server
}
