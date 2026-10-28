// TomTube service settings, all from the environment (/etc/tomtube/tomtube.env on the box).
import { isIP } from 'node:net'
import { join, resolve } from 'node:path'

const MINIMUM_TOKEN_LENGTH = 32

export function isLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '')
  return host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.'))
}

function number(env, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = String(env[name] ?? '').trim()
  if (!raw) return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name} must be a number between ${min} and ${max}.`)
  return value
}

function optionalUrl(env, name) {
  const raw = String(env[name] || '').trim()
  if (!raw) return null
  let url
  try { url = new URL(raw) } catch { throw new Error(`${name} must be a URL.`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error(`${name} must be a plain http(s) URL.`)
  return url.href.replace(/\/+$/, '')
}

export function loadConfig(env = process.env) {
  const host = String(env.TOMTUBE_HOST || '127.0.0.1').trim()
  const token = String(env.TOMTUBE_TOKEN || '')
  const insecure = String(env.TOMTUBE_ALLOW_INSECURE_LOOPBACK || '').trim().toLowerCase() === 'true'
  if (token && token.trim().length < MINIMUM_TOKEN_LENGTH) throw new Error(`TOMTUBE_TOKEN must contain at least ${MINIMUM_TOKEN_LENGTH} characters.`)
  if (!token && !insecure) throw new Error(`TOMTUBE_TOKEN is required and must contain at least ${MINIMUM_TOKEN_LENGTH} characters.`)
  if (!token && !isLoopbackHost(host)) throw new Error('TOMTUBE_ALLOW_INSECURE_LOOPBACK is only allowed when TOMTUBE_HOST is a loopback address.')

  const stateDir = resolve(env.TOMTUBE_STATE_DIR || './tomtube-state')
  const playerClients = String(env.TOMTUBE_YTDLP_PLAYER_CLIENTS || '').trim()
  if (playerClients && !/^[a-z0-9_,-]+$/i.test(playerClients)) throw new Error('TOMTUBE_YTDLP_PLAYER_CLIENTS must be a comma-separated list of yt-dlp client names.')
  const jsRuntime = String(env.TOMTUBE_YTDLP_JS_RUNTIME || '').trim()
  if (jsRuntime && !/^(?:deno|node|bun|quickjs)(?::\/[^\s]+)?$/.test(jsRuntime)) throw new Error('TOMTUBE_YTDLP_JS_RUNTIME must be a runtime name, optionally with :/absolute/path (for example deno:/usr/local/bin/deno).')
  const remoteComponents = String(env.TOMTUBE_YTDLP_REMOTE_COMPONENTS || '').trim()
  if (remoteComponents && !/^[a-z0-9:,_-]+$/i.test(remoteComponents)) throw new Error('TOMTUBE_YTDLP_REMOTE_COMPONENTS must look like ejs:github.')
  const cookies = String(env.TOMTUBE_YOUTUBE_COOKIES || '').trim()

  return {
    host,
    port: number(env, 'TOMTUBE_PORT', 8790, { max: 65535 }),
    token: token.trim(),
    version: String(env.TOMTUBE_VERSION || '').trim() || null,
    maxHeight: number(env, 'TOMTUBE_MAX_HEIGHT', 1080, { min: 144, max: 1080 }),
    maxStreams: number(env, 'TOMTUBE_MAX_STREAMS', 16, { max: 500 }),
    searchLimit: number(env, 'TOMTUBE_SEARCH_LIMIT', 20, { max: 50 }),
    ytdlp: {
      binary: String(env.TOMTUBE_YTDLP_PATH || 'yt-dlp').trim(),
      cacheDir: join(stateDir, 'yt-dlp-cache'),
      jsRuntime: jsRuntime || null,
      remoteComponents: remoteComponents || null,
      playerClients: playerClients || null,
      potProviderUrl: optionalUrl(env, 'TOMTUBE_POT_PROVIDER_URL'),
      cookies: cookies ? resolve(cookies) : null,
      maxConcurrent: number(env, 'TOMTUBE_YTDLP_CONCURRENCY', 3, { max: 16 }),
      maxQueued: 30,
      timeoutMs: number(env, 'TOMTUBE_YTDLP_TIMEOUT_MS', 60_000, { min: 5000, max: 300_000 }),
      maxOutputBytes: 32 * 1024 * 1024,
    },
    cache: {
      dir: resolve(env.TOMTUBE_CACHE_DIR || join(stateDir, 'audio-cache')),
      maxBytes: number(env, 'TOMTUBE_CACHE_MAX_BYTES', 2 * 1024 ** 3, { min: 0 }),
      maxAgeMs: number(env, 'TOMTUBE_CACHE_MAX_AGE_HOURS', 24, { min: 1, max: 24 * 30 }) * 3600_000,
      maxFileBytes: number(env, 'TOMTUBE_CACHE_MAX_FILE_BYTES', 300 * 1024 ** 2, { min: 0 }),
      maxConcurrentFills: number(env, 'TOMTUBE_CACHE_CONCURRENCY', 2, { max: 8 }),
    },
  }
}
