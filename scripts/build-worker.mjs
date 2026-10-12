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
  await db.prepare('CREATE TABLE IF NOT EXISTS release_metadata (album_id TEXT PRIMARY KEY, release_type TEXT NOT NULL, release_date TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT, source TEXT NOT NULL DEFAULT \'manual\', musicbrainz_id TEXT, match_score INTEGER)').run()
  for (const statement of [
    "ALTER TABLE release_metadata ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'",
    'ALTER TABLE release_metadata ADD COLUMN musicbrainz_id TEXT',
    'ALTER TABLE release_metadata ADD COLUMN match_score INTEGER',
  ]) {
    try { await db.prepare(statement).run() } catch { /* column already exists */ }
  }
}

function rowToItem(row) {
  if (!row) return null
  return {
    albumId: row.albumId,
    releaseType: row.releaseType,
    releaseDate: row.releaseDate ?? null,
    updatedAt: row.updatedAt,
    source: row.source || 'manual',
    musicBrainzId: row.musicBrainzId ?? null,
    matchScore: row.matchScore ?? null,
  }
}

function normalise(value) {
  return String(value || '').toLocaleLowerCase('en').replace(/[^a-z0-9]+/g, ' ').trim()
}

function musicBrainzType(group) {
  const secondary = (group['secondary-types'] || []).map((value) => String(value).toLowerCase())
  if (secondary.includes('compilation')) return 'compilation'
  const primary = String(group['primary-type'] || '').toLowerCase()
  if (primary === 'single') return 'single'
  if (primary === 'ep') return 'ep'
  if (primary === 'album') return 'album'
  return 'other'
}

function artistCredit(group) {
  return (group['artist-credit'] || []).map((credit) => credit?.name || credit?.artist?.name || '').filter(Boolean).join(' ')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function musicBrainzJson(url) {
  const response = await fetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': 'Tomify/0.1 (https://app.tomify.tomdixon.uk)',
    },
  })
  if (!response.ok) return null
  return response.json()
}

async function lookupMusicBrainzReleaseGroup(album) {
  const mbid = typeof album.musicBrainzId === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(album.musicBrainzId) ? album.musicBrainzId : null

  if (mbid) {
    const releaseUrl = new URL('https://musicbrainz.org/ws/2/release/' + mbid)
    releaseUrl.searchParams.set('inc', 'release-groups')
    releaseUrl.searchParams.set('fmt', 'json')
    const release = await musicBrainzJson(releaseUrl)
    if (release?.['release-group']?.id) {
      await sleep(1100)
      const fullGroupUrl = new URL('https://musicbrainz.org/ws/2/release-group/' + release['release-group'].id)
      fullGroupUrl.searchParams.set('fmt', 'json')
      const fullGroup = await musicBrainzJson(fullGroupUrl)
      if (fullGroup?.id) return { group: fullGroup, score: 100 }
      return { group: release['release-group'], score: 100 }
    }

    const groupUrl = new URL('https://musicbrainz.org/ws/2/release-group/' + mbid)
    groupUrl.searchParams.set('fmt', 'json')
    const group = await musicBrainzJson(groupUrl)
    if (group?.id) return { group, score: 100 }
  }

  const title = String(album.name || '').replace(/"/g, '').trim()
  const artist = String(album.artist || '').replace(/"/g, '').trim()
  if (!title || !artist) return null

  const searchUrl = new URL('https://musicbrainz.org/ws/2/release-group/')
  searchUrl.searchParams.set('query', 'releasegroup:"' + title + '" AND artist:"' + artist + '"')
  searchUrl.searchParams.set('limit', '5')
  searchUrl.searchParams.set('fmt', 'json')
  const search = await musicBrainzJson(searchUrl)
  const groups = Array.isArray(search?.['release-groups']) ? search['release-groups'] : []
  const wantedTitle = normalise(title)
  const wantedArtist = normalise(artist)

  const candidates = groups.map((group) => {
    const score = Number(group.score || 0)
    const titleMatch = normalise(group.title) === wantedTitle
    const creditedArtist = normalise(artistCredit(group))
    const artistMatch = creditedArtist === wantedArtist || creditedArtist.includes(wantedArtist) || wantedArtist.includes(creditedArtist)
    const yearMatch = album.year && String(group['first-release-date'] || '').startsWith(String(album.year))
    return { group, score: score + (titleMatch ? 15 : 0) + (artistMatch ? 15 : 0) + (yearMatch ? 5 : 0), rawScore: score, titleMatch, artistMatch }
  }).filter((candidate) => candidate.titleMatch && candidate.artistMatch && candidate.rawScore >= 80)
    .sort((a, b) => b.score - a.score)

  return candidates[0] ? { group: candidates[0].group, score: Math.min(100, candidates[0].rawScore) } : null
}

async function selectRelease(db, albumId) {
  const row = await db.prepare('SELECT album_id AS albumId, release_type AS releaseType, release_date AS releaseDate, updated_at AS updatedAt, source, musicbrainz_id AS musicBrainzId, match_score AS matchScore FROM release_metadata WHERE album_id = ?').bind(albumId).first()
  return rowToItem(row)
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
      const result = await env.TOMIFY_DB.prepare('SELECT album_id AS albumId, release_type AS releaseType, release_date AS releaseDate, updated_at AS updatedAt, source, musicbrainz_id AS musicBrainzId, match_score AS matchScore FROM release_metadata ORDER BY album_id').all()
      return json({ items: (result.results || []).map(rowToItem) })
    }

    if (pathname === '/api/release-meta/enrich' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'metadata-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const album = await request.json()
      if (!album || typeof album.albumId !== 'string' || typeof album.name !== 'string' || typeof album.artist !== 'string') return json({ error: 'invalid-album' }, 400)

      await ensureReleaseTable(env.TOMIFY_DB)
      const existing = await selectRelease(env.TOMIFY_DB, album.albumId)
      const force = album.force === true
      if (existing && (!force || existing.source === 'manual')) return json({ item: existing, cached: true })

      const match = await lookupMusicBrainzReleaseGroup(album)
      if (!match?.group) return json({ error: 'musicbrainz-no-match' }, 404)

      const releaseType = musicBrainzType(match.group)
      const releaseDate = typeof match.group['first-release-date'] === 'string' && /^\\d{4}(?:-\\d{2})?(?:-\\d{2})?$/.test(match.group['first-release-date']) ? match.group['first-release-date'] : null
      const groupId = typeof match.group.id === 'string' ? match.group.id : null

      await env.TOMIFY_DB.prepare("INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by, source, musicbrainz_id, match_score) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'musicbrainz', ?, ?) ON CONFLICT(album_id) DO UPDATE SET release_type = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.release_type ELSE excluded.release_type END, release_date = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.release_date ELSE excluded.release_date END, updated_at = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.updated_at ELSE CURRENT_TIMESTAMP END, updated_by = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.updated_by ELSE excluded.updated_by END, source = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.source ELSE 'musicbrainz' END, musicbrainz_id = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.musicbrainz_id ELSE excluded.musicbrainz_id END, match_score = CASE WHEN release_metadata.source = 'manual' THEN release_metadata.match_score ELSE excluded.match_score END")
        .bind(album.albumId, releaseType, releaseDate, username, groupId, match.score).run()

      const item = await selectRelease(env.TOMIFY_DB, album.albumId)
      return json({ item, cached: false })
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
      await env.TOMIFY_DB.prepare("INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by, source) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'manual') ON CONFLICT(album_id) DO UPDATE SET release_type = excluded.release_type, release_date = excluded.release_date, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by, source = 'manual'")
        .bind(releaseMetaMatch[1], body.releaseType, releaseDate, username).run()
      const item = await selectRelease(env.TOMIFY_DB, releaseMetaMatch[1])
      return json({ ok: true, item })
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
