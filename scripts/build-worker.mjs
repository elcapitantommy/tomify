import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'

const outputDirectory = new URL('../dist/', import.meta.url)
const workerPath = new URL('../dist/server/index.js', import.meta.url)
const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    if (entry.name === 'server' || entry.name === '.openai') continue
    const path = join(directory, entry.name)
    files.push(...(entry.isDirectory() ? await collectFiles(path) : [path]))
  }
  return files
}

const root = outputDirectory.pathname.replace(/^\/(.:\/)/, '$1')
const assets = Object.fromEntries(
  await Promise.all(
    (await collectFiles(root)).map(async (path) => {
      const pathname = `/${relative(root, path).split(sep).join('/')}`
      return [pathname, { body: (await readFile(path)).toString('base64'), type: mimeTypes[extname(path)] ?? 'application/octet-stream' }]
    }),
  ),
)

const worker = `const assets = ${JSON.stringify(assets)}

function decode(value) {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } })
}

async function authenticate(request) {
  const username = request.headers.get('x-tomify-user')
  const token = request.headers.get('x-tomify-token')
  const salt = request.headers.get('x-tomify-salt')
  if (!username || !token || !salt) return null
  try {
    const ping = new URL('https://tomify.tomdixon.uk/rest/ping.view')
    ping.searchParams.set('u', username)
    ping.searchParams.set('t', token)
    ping.searchParams.set('s', salt)
    ping.searchParams.set('v', '1.16.1')
    ping.searchParams.set('c', 'Tomify')
    ping.searchParams.set('f', 'json')
    const response = await fetch(ping, { headers: { accept: 'application/json' } })
    if (!response.ok) return null
    const body = await response.json()
    return body && body['subsonic-response'] && body['subsonic-response'].status === 'ok' ? username : null
  } catch {
    return null
  }
}

async function ensureReleaseTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS release_metadata (album_id TEXT PRIMARY KEY, release_type TEXT NOT NULL, release_date TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT)').run()
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    let pathname = decodeURIComponent(url.pathname)

    if (pathname === '/api/release-meta' && request.method === 'GET') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      await ensureReleaseTable(env.TOMIFY_DB)
      const result = await env.TOMIFY_DB.prepare('SELECT album_id AS albumId, release_type AS releaseType, release_date AS releaseDate, updated_at AS updatedAt FROM release_metadata ORDER BY album_id').all()
      return json({ items: result.results || [] })
    }

    const releaseMetaMatch = pathname.match(/^\\/api\\/release-meta\\/([^/]+)$/)
    if (releaseMetaMatch && request.method === 'PUT') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const allowed = ['album', 'single', 'ep', 'compilation', 'other']
      if (!body || !allowed.includes(body.releaseType)) return json({ error: 'invalid-release-type' }, 400)
      const releaseDate = typeof body.releaseDate === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(body.releaseDate) ? body.releaseDate : null
      await ensureReleaseTable(env.TOMIFY_DB)
      await env.TOMIFY_DB.prepare('INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET release_type = excluded.release_type, release_date = excluded.release_date, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
        .bind(releaseMetaMatch[1], body.releaseType, releaseDate, username).run()
      return json({ ok: true })
    }

    if (pathname === '/navidrome' || pathname.startsWith('/navidrome/')) {
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

    if (pathname === '/') pathname = '/index.html'
    let asset = assets[pathname]
    if (!asset && request.method === 'GET' && request.headers.get('accept')?.includes('text/html')) asset = assets['/index.html']
    if (!asset || !['GET', 'HEAD'].includes(request.method)) return new Response(null, { status: 404 })

    const headers = new Headers({ 'content-type': asset.type })
    headers.set('cache-control', pathname === '/index.html' || pathname === '/sw.js' ? 'no-cache' : 'public, max-age=31536000, immutable')
    return new Response(request.method === 'HEAD' ? null : decode(asset.body), { headers })
  },
}
`

await writeFile(workerPath, worker)
