import type { RouteHandler } from '../env.ts'
import { navidromeUrl } from '../lib/navidrome.ts'

export const navidromeRoute: RouteHandler = async (request, env, url) => {
  const pathname = decodeURIComponent(url.pathname)
  if (pathname !== '/navidrome' && !pathname.startsWith('/navidrome/')) return null
  const upstreamPath = pathname.slice('/navidrome'.length) || '/'
  const upstream = navidromeUrl(env, upstreamPath)
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
