import type { RouteHandler } from '../env.ts'
import { openMediaToken } from '../features/media-session.ts'
import { json } from '../lib/http.ts'
import { navidromeUrl } from '../lib/navidrome.ts'

export const navidromeRoute: RouteHandler = async (request, env, url) => {
  const pathname = decodeURIComponent(url.pathname)
  if (pathname !== '/navidrome' && !pathname.startsWith('/navidrome/')) return null
  const upstreamPath = pathname.slice('/navidrome'.length) || '/'
  const upstream = navidromeUrl(env, upstreamPath)
  // A media token (`mt`) stands in for the login, and only for streams.
  const query = url.searchParams
  if (query.has('mt')) {
    const login = /^\/rest\/stream(\.view)?$/.test(upstreamPath) && await openMediaToken(env, query.get('mt'))
    if (!login) return json({ error: 'unauthorized' }, 401)
    query.delete('mt')
    login.forEach((value, index) => query.set('uts'[index], value))
  }
  upstream.search = url.search
  const headers = new Headers(request.headers)
  headers.delete('host')
  headers.delete('origin')
  return fetch(upstream, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : request.body,
    redirect: 'follow',
  })
}
