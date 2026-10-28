import type { Env, RouteHandler } from '../env.ts'
import { mediaToken, openMediaToken } from '../features/media-session.ts'
import { authenticate, authenticateCredentials } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

// TomTube (docs/TOMTUBE.md): ad-free YouTube through the TomTube service on the media server, reached
// over the Cloudflare Tunnel at TOMTUBE_SERVICE_URL with a bearer token. Only signed-in Tomify
// listeners get through, optionally only those in TOMTUBE_ALLOWED_USERS. Only the paths below are
// passed on, so the service cannot be used as a general relay, and the phone never sees a YouTube URL.
//   JSON (x-tomify-* headers): search, resolve, videos/<id>, videos/<id>/prefetch, queue.json, status
//   Media (`mt` token or u/t/s in the query, since players can't send headers): playlists, streams,
//   thumbnails. Playlists are re-signed with a fresh token, so a long video outlives the old one.
const ID = '[A-Za-z0-9_-]{11}'
const JSON_PATH = new RegExp(`^/api/tomtube/(?:search|resolve|status|queue\\.json|videos/${ID}(?:/prefetch)?)$`)
const MEDIA_PATH = new RegExp(`^/api/tomtube/(?:queue\\.m3u8|videos/${ID}/(?:master|audio|[va]\\d{1,4})\\.m3u8|videos/${ID}/(?:\\d{1,4}\\.(?:mp4|m4a)|progressive\\.mp4|audio\\.m4a)|thumbs/${ID}/[a-z]{4,13}\\.jpg)$`)
const FORWARDED = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'cache-control']
const QUERY_KEYS: Record<string, string[]> = { search: ['q', 'limit'], resolve: ['url'], 'queue.json': ['ids'], 'queue.m3u8': ['ids'] }

function allowed(env: Env, user: string) {
  const list = String(env.TOMTUBE_ALLOWED_USERS || '').split(',').map((name) => name.trim().toLowerCase()).filter(Boolean)
  return !list.length || list.includes(user.toLowerCase())
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
  const post = url.pathname.endsWith('/prefetch')
  if (request.method !== (post ? 'POST' : 'GET') && !(isMedia && request.method === 'HEAD')) return json({ error: 'method-not-allowed' }, 405)

  let user: string | null
  let login: string[] | null = null
  const mt = url.searchParams.get('mt')
  if (isJson) user = await authenticate(request, env)
  else {
    login = mt ? await openMediaToken(env, mt) : ['u', 't', 's'].map((key) => url.searchParams.get(key) || '')
    user = login ? await authenticateCredentials(env, login[0], login[1], login[2]) : null
  }
  if (!user) return json({ error: 'unauthorized' }, 401)
  if (!allowed(env, user)) return json({ error: 'forbidden', message: 'TomTube is not enabled for this account.' }, 403)
  if (!env.TOMTUBE_SERVICE_URL || !env.TOMTUBE_SERVICE_TOKEN) return json({ error: 'not-configured', message: 'TomTube is not set up on this server yet.' }, 503)

  const rest = url.pathname.slice('/api/tomtube/'.length)
  const target = new URL(`${String(env.TOMTUBE_SERVICE_URL).replace(/\/+$/, '')}/v1/${rest}`)
  for (const key of QUERY_KEYS[rest] || []) { const value = url.searchParams.get(key); if (value !== null) target.searchParams.set(key, value) }
  const headers: Record<string, string> = { authorization: `Bearer ${env.TOMTUBE_SERVICE_TOKEN}` }
  const range = request.headers.get('range')
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.range = range
  let upstream: Response
  try {
    upstream = await fetch(target.href, { method: request.method, headers, signal: request.signal })
  } catch {
    return json({ error: 'tomtube-unavailable', message: 'The TomTube service on the media server could not be reached.' }, 502)
  }

  if (isMedia && upstream.ok && rest.endsWith('.m3u8')) {
    // A fresh four-hour token for everything this playlist names.
    const query = new URLSearchParams(env.TOMIFY_MEDIA_KEY ? { mt: (await mediaToken(env, login!)).token } : { u: login![0], t: login![1], s: login![2] }).toString()
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
