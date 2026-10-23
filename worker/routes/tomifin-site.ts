import type { Env, RouteHandler } from '../env.ts'
import { json } from '../lib/http.ts'
import { tomifinRoute } from './tomifin.ts'

// Tomifin Downloader has its own address (TOMIFIN_HOSTNAME, for example tomifin.tomdixon.uk), served by this same
// Worker as a second custom domain. On that host the Worker serves only Tomifin: its page, its API (which signs in
// with Jellyfin through the recovery agent) and its icons. Tomify's own pages and APIs are not reachable there, and
// Tomifin is not reachable from Tomify's address.

// Files from dist/client the Tomifin page uses besides its hashed /assets/ (which Static Assets serves directly).
const TOMIFIN_FILES = new Set(['/tomify-logo-192.png', '/apple-touch-icon-180.png', '/favicon.ico', '/favicon.svg'])
// Where Vite puts the page in dist/client.
const TOMIFIN_PAGE = '/tomifin/'

// If Tomify's app was ever served on Tomifin's address (for example when the custom domain went live before this
// Worker was deployed), the browser keeps Tomify's service worker there, and it goes on showing Tomify's cached
// sign-in page. Browsers re-fetch /sw.js to look for an update, so on Tomifin's address that path answers with a
// worker that deletes its caches, unregisters itself and reloads open tabs, which then get Tomifin's page.
const SERVICE_WORKER_REMOVAL = `self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil((async () => {
  for (const key of await caches.keys()) await caches.delete(key)
  await self.registration.unregister()
  for (const client of await self.clients.matchAll({ type: 'window' })) client.navigate(client.url)
})()))
`

export function tomifinHostname(env: Env): string | null {
  const value = String(env.TOMIFIN_HOSTNAME || '').trim().toLowerCase().replace(/\.$/, '')
  return /^[a-z0-9.-]+$/.test(value) ? value : null
}

function isTomifinPath(pathname: string) {
  return pathname === '/tomifin' || pathname.startsWith('/tomifin/') || pathname === '/api/tomifin' || pathname.startsWith('/api/tomifin/')
}

async function page(request: Request, env: Env, url: URL) {
  if (!env.ASSETS) return new Response(null, { status: 404 })
  const response = await env.ASSETS.fetch(new Request(new URL(TOMIFIN_PAGE, url), { method: request.method, headers: request.headers }) as never) as unknown as Response
  const headers = new Headers(response.headers)
  headers.set('cache-control', 'no-cache')
  headers.set('x-robots-tag', 'noindex, nofollow')
  headers.set('referrer-policy', 'no-referrer')
  headers.set('x-frame-options', 'DENY')
  headers.set('x-content-type-options', 'nosniff')
  return new Response(request.method === 'HEAD' ? null : response.body, { status: response.status, headers })
}

export const tomifinSiteRoute: RouteHandler = async (request, env, url, ctx) => {
  const hostname = tomifinHostname(env)
  // Without TOMIFIN_HOSTNAME (local development) Tomifin stays at /tomifin/ and /api/tomifin/ as before.
  if (!hostname) return null
  if (url.hostname !== hostname) {
    if (!isTomifinPath(url.pathname)) return null
    if (url.pathname.startsWith('/api/')) return json({ error: 'not-found' }, 404)
    return Response.redirect(`https://${hostname}/`, 301)
  }

  if (url.pathname === '/api/tomifin' || url.pathname.startsWith('/api/tomifin/')) return (await tomifinRoute(request, env, url, ctx))!
  // Tomify's APIs and its Navidrome proxy are not part of Tomifin.
  if (['/api', '/navidrome'].some((prefix) => url.pathname === prefix || url.pathname.startsWith(prefix + '/'))) return json({ error: 'not-found' }, 404)
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
  if (url.pathname === '/sw.js') return new Response(request.method === 'HEAD' ? null : SERVICE_WORKER_REMOVAL, { headers: { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store', 'clear-site-data': '"cache"' } })
  if (url.pathname.startsWith('/assets/') || TOMIFIN_FILES.has(url.pathname)) return env.ASSETS ? env.ASSETS.fetch(request as never) as unknown as Response : new Response(null, { status: 404 })
  // Tomify's service worker, manifest and other files are not part of Tomifin.
  if (/\.[a-z0-9]+$/i.test(url.pathname) && url.pathname !== '/index.html') return new Response(null, { status: 404 })
  // Every other path is the Tomifin page, so direct navigation and refreshes work.
  return page(request, env, url)
}
