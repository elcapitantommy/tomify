import type { RouteHandler } from '../env.ts'
import { authenticateCredentials } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { navidromeOrigin } from '../lib/navidrome.ts'

// Adaptive streaming: GET /api/hls/<trackId>/<file>?u=&t=&s= is passed to the recovery agent, which
// cuts the track into chunks at several bitrates. Audio elements and Safari's own HLS player can't
// add headers, so the Navidrome login travels in the query, and every playlist line pointing at
// another playlist or chunk gets the same query so those requests are signed in too.
const HLS_PATH = /^\/api\/hls\/([A-Za-z0-9_-]{1,64})\/(master\.m3u8|v[0-9]\/index\.m3u8|v[0-9]\/seg\d{5}\.ts)$/

export function signPlaylist(playlist: string, query: string): string {
  return playlist.split('\n').map((line) => {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) return line
    if (!/^(?:v[0-9]\/index\.m3u8|seg\d{5}\.ts)$/.test(trimmed)) return line
    return `${trimmed}?${query}`
  }).join('\n')
}

export const hlsRoute: RouteHandler = async (request, env, url) => {
  if (!url.pathname.startsWith('/api/hls/')) return null
  if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method-not-allowed' }, 405)
  const match = HLS_PATH.exec(url.pathname)
  if (!match) return json({ error: 'not-found' }, 404)
  const user = url.searchParams.get('u')
  const token = url.searchParams.get('t')
  const salt = url.searchParams.get('s')
  if (!await authenticateCredentials(env, user, token, salt)) return json({ error: 'unauthorized' }, 401)
  if (!env.RECOVERY_AGENT_URL) return json({ error: 'hls-unavailable', message: 'The recovery agent is not configured.' }, 503)

  const base = String(env.RECOVERY_AGENT_URL).replace(/\/+$/, '')
  const headers: Record<string, string> = {
    'x-tomify-navidrome-user': user!,
    'x-tomify-navidrome-token': token!,
    'x-tomify-navidrome-salt': salt!,
    'x-tomify-navidrome-origin': navidromeOrigin(env),
  }
  if (env.RECOVERY_AGENT_TOKEN) headers.authorization = 'Bearer ' + env.RECOVERY_AGENT_TOKEN
  let upstream: Response
  try {
    upstream = await fetch(`${base}/v1/hls/${match[1]}/${match[2]}`, { headers })
  } catch {
    return json({ error: 'hls-unavailable', message: 'The recovery agent could not be reached.' }, 503)
  }
  if (!upstream.ok) {
    const body = await upstream.json().catch(() => ({})) as { error?: string; message?: string }
    // An agent from before adaptive streaming answers every GET with 404 not-found, like a turned-off one.
    const outdated = upstream.status === 404 && body.error === 'not-found' && match[2].endsWith('.m3u8')
    if (outdated || upstream.status === 503) return json({ error: 'hls-unavailable', message: body.message || 'Adaptive streaming is not available on the agent.' }, 503)
    return json({ error: body.error || 'hls-failed', message: body.message || 'Adaptive streaming failed.' }, upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502)
  }
  if (match[2].endsWith('.m3u8')) {
    const query = new URLSearchParams({ u: user!, t: token!, s: salt! }).toString()
    return new Response(request.method === 'HEAD' ? null : signPlaylist(await upstream.text(), query), {
      headers: { 'content-type': 'application/vnd.apple.mpegurl', 'cache-control': 'no-store' },
    })
  }
  const responseHeaders = new Headers({ 'content-type': 'video/mp2t', 'cache-control': upstream.headers.get('cache-control') || 'private, max-age=86400' })
  const length = upstream.headers.get('content-length')
  if (length) responseHeaders.set('content-length', length)
  return new Response(request.method === 'HEAD' ? null : upstream.body, { headers: responseHeaders })
}
