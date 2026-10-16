import type { RouteHandler } from '../env.ts'

export const navidromeRoute: RouteHandler = async (request, _env, url) => {
  const pathname = decodeURIComponent(url.pathname)
  if (pathname !== '/navidrome' && !pathname.startsWith('/navidrome/')) return null
  const upstreamPath = pathname.slice('/navidrome'.length) || '/'
  const upstream = new URL('https://tomify.tomdixon.uk' + upstreamPath)
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
