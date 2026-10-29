import type { Env, RouteHandler } from '../env.ts'
import { mediaToken, openMediaToken } from '../features/media-session.ts'
import { authenticate, authenticateCredentials } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

// TomTube (docs/TOMTUBE.md): ad-free YouTube through the TomTube service on the media server, reached
// over the Cloudflare Tunnel at TOMTUBE_SERVICE_URL with a bearer token. Only signed-in Tomify
// listeners get through, optionally only those in TOMTUBE_ALLOWED_USERS. Only the paths below are
// passed on, so the service cannot be used as a general relay, and the phone never sees a YouTube URL.
//   JSON (x-tomify-* headers): search, resolve, videos/<id>, videos/<id>/prefetch, queue.json, status,
//   and recommendations: recommendations, watched, feedback, training, training/cookies, training/sync,
//   training/imports (the owner's import report).
//   The cookie upload is passed on as a body of at most 256 KB; the service never sends cookies back.
//   Recommendations are per account: the service is told which listener is signed in
//   (x-tomtube-profile) and whether they are an owner (x-tomtube-owner), and keeps a profile for each.
//   Adding, removing or syncing YouTube account cookies is allowed only for TOMTUBE_TRAINING_USERS;
//   unset means nobody. Anyone can clear their own training data.
//   Media (playlists, streams, thumbnails): only a short-lived `mt` media token in the query, since
//   players can't send headers. The Navidrome login is never accepted in a TomTube URL, so it can't
//   end up in Cloudflare or browser logs; without TOMIFY_MEDIA_KEY media answers 503. Playlists are
//   re-signed with a fresh token, so a long video outlives the old one.
const ID = '[A-Za-z0-9_-]{11}'
const JSON_PATH = new RegExp(`^/api/tomtube/(?:search|resolve|status|queue\\.json|recommendations|watched|feedback|training(?:/cookies|/sync|/imports)?|videos/${ID}(?:/prefetch)?)$`)
// The methods each JSON path takes (GET unless listed), and the largest body passed on.
const JSON_METHODS: Array<[RegExp, string[]]> = [
  [/\/prefetch$/, ['POST']],
  [/^watched$/, ['POST']],
  [/^feedback$/, ['POST']],
  [/^training$/, ['GET', 'DELETE']],
  [/^training\/cookies$/, ['PUT', 'DELETE']],
  [/^training\/sync$/, ['POST']],
]
const BODY_LIMITS: Record<string, number> = { watched: 4096, feedback: 4096, 'training/cookies': 256 * 1024 }
// Using the YouTube account cookies, and the import report (it shows titles from the account's YouTube
// history): only TOMTUBE_TRAINING_USERS.
const MANAGE = (rest: string) => rest === 'training/cookies' || rest === 'training/sync' || rest === 'training/imports'
// The paths that read or change one account's recommendation profile.
const PROFILE = /^(?:recommendations|watched|feedback|training(?:\/.*)?)$/
const MEDIA_PATH = new RegExp(`^/api/tomtube/(?:queue\\.m3u8|videos/${ID}/(?:master|video|audio|[va]\\d{1,4})\\.m3u8|videos/${ID}/(?:\\d{1,4}\\.(?:mp4|m4a)|progressive\\.mp4|audio\\.m4a)|thumbs/${ID}/[a-z]{4,13}\\.jpg)$`)
const FORWARDED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']
const QUERY_KEYS: Record<string, string[]> = { search: ['q', 'limit'], resolve: ['url'], 'queue.json': ['ids'], 'queue.m3u8': ['ids'], recommendations: ['refresh'] }

function listed(value: unknown, user: string) {
  const list = String(value || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  return !list.length || list.includes(user.toLowerCase())
}

const allowed = (env: Env, user: string) => listed(env.TOMTUBE_ALLOWED_USERS, user)

// Using the YouTube account cookies fails closed: only usernames named in
// TOMTUBE_TRAINING_USERS (wrangler.toml), and nobody when it is empty or missing.
function owner(env: Env, user: string) {
  const list = String(env.TOMTUBE_TRAINING_USERS || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  return list.includes(user.toLowerCase())
}

// Every URI in a playlist (lines and URI="…" attributes) gets the listener's media query.
export function signTomTubePlaylist(playlist: string, query: string): string {
  const sign = (uri: string) => /^[A-Za-z0-9_./-]+$/.test(uri) && !uri.includes('..') ? `${uri}?${query}` : uri
  return playlist.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed) return line
    if (trimmed.startsWith('#')) return line.replace(/URI="([^"]*)"/g, (_, uri: string) => `URI="${sign(uri)}"`)
    return sign(trimmed)
  }).join('\n')
}

export const tomtubeRoute: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/api/tomtube' && !url.pathname.startsWith('/api/tomtube/')) return null
  const isJson = JSON_PATH.test(url.pathname)
  const isMedia = !isJson && MEDIA_PATH.test(url.pathname)
  if (!isJson && !isMedia) return json({ error: 'not-found' }, 404)
  const rest = url.pathname.slice('/api/tomtube/'.length)
  const methods = isJson ? JSON_METHODS.find(([pattern]) => pattern.test(rest))?.[1] ?? ['GET'] : ['GET', 'HEAD']
  if (!methods.includes(request.method)) return json({ error: 'method-not-allowed' }, 405)

  if (isMedia && !env.TOMIFY_MEDIA_KEY) return json({ error: 'media-tokens-not-configured', message: 'TomTube needs media tokens (TOMIFY_MEDIA_KEY) on this server.' }, 503)
  let user: string | null
  let login: string[] | null = null
  if (isJson) user = await authenticate(request, env)
  else {
    login = await openMediaToken(env, url.searchParams.get('mt'))
    user = login ? await authenticateCredentials(env, login[0], login[1], login[2]) : null
  }
  if (!user) return json({ error: 'unauthorized' }, 401)
  if (!allowed(env, user)) return json({ error: 'forbidden', message: 'TomTube is not enabled for this account.' }, 403)
  if (MANAGE(rest) && !owner(env, user)) return json({ error: 'training-forbidden', message: String(env.TOMTUBE_TRAINING_USERS || '').trim() ? 'Only the account owner can use YouTube account cookies.' : 'Changing the YouTube cookies is turned off until TOMTUBE_TRAINING_USERS is set in wrangler.toml.' }, 403)
  if (!env.TOMTUBE_SERVICE_URL || !env.TOMTUBE_SERVICE_TOKEN) return json({ error: 'not-configured', message: 'TomTube is not set up on this server yet.' }, 503)

  const target = new URL(`${String(env.TOMTUBE_SERVICE_URL).replace(/\/+$/, '')}/v1/${rest}`)
  for (const key of QUERY_KEYS[rest] || []) { const value = url.searchParams.get(key); if (value !== null) target.searchParams.set(key, value) }
  const headers: Record<string, string> = { authorization: `Bearer ${env.TOMTUBE_SERVICE_TOKEN}` }
  if (isJson && PROFILE.test(rest)) {
    headers['x-tomtube-profile'] = encodeURIComponent(user.toLowerCase())
    headers['x-tomtube-owner'] = owner(env, user) ? '1' : '0'
  }
  const range = request.headers.get('range')
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range
  let body: string | undefined
  const limit = BODY_LIMITS[rest]
  if (limit && (request.method === 'POST' || request.method === 'PUT')) {
    if (Number(request.headers.get('content-length')) > limit) return json({ error: 'too-large', message: 'That is too large.' }, 413)
    body = await request.text()
    if (new TextEncoder().encode(body).length > limit) return json({ error: 'too-large', message: 'That is too large.' }, 413)
    headers['content-type'] = rest === 'training/cookies' ? 'text/plain; charset=utf-8' : 'application/json'
  }
  let upstream: Response
  try {
    upstream = await fetch(target.href, { method: request.method, headers, body, signal: request.signal })
  } catch {
    return json({ error: 'tomtube-unavailable', message: 'The TomTube service on the media server could not be reached.' }, 502)
  }

  if (isMedia && upstream.ok && rest.endsWith('.m3u8')) {
    // A fresh four-hour token for everything this playlist names.
    const query = new URLSearchParams({ mt: (await mediaToken(env, login!)).token }).toString()
    return new Response(request.method === 'HEAD' ? null : signTomTubePlaylist(await upstream.text(), query), { headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' } })
  }
  const out = new Headers({ 'x-content-type-options': 'nosniff' })
  for (const name of FORWARDED) { const value = upstream.headers.get(name); if (value) out.set(name, value) }
  if (!out.has('cache-control')) out.set('cache-control', 'no-store')
  return new Response(request.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out })
}

// TomTube's page lives at /tomtube/ (tomtube/index.html, its own home-screen app). Any deeper path
// is the same page, so a refresh never lands on Tomify's single-page fallback.
export const tomtubePageRoute: RouteHandler = async (request, env, url) => {
  if (url.pathname !== '/tomtube' && !/^\/tomtube\/[^.]*$/.test(url.pathname)) return null
  if (url.pathname === '/tomtube') return Response.redirect(new URL('/tomtube/', url).href, 301)
  if (!env.ASSETS || (request.method !== 'GET' && request.method !== 'HEAD')) return null
  const page = await env.ASSETS.fetch(new Request(new URL('/tomtube/', url), { method: request.method, headers: request.headers }) as never) as unknown as Response
  const headers = new Headers(page.headers)
  headers.set('cache-control', 'no-cache')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(request.method === 'HEAD' ? null : page.body, { status: page.status, headers })
}
