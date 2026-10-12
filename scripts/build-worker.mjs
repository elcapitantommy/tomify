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

const authCache = new Map()

async function authenticate(request) {
  const username = request.headers.get('x-tomify-user')
  const token = request.headers.get('x-tomify-token')
  const salt = request.headers.get('x-tomify-salt')
  if (!username || !token || !salt) return null
  const cacheKey = username + ':' + token + ':' + salt
  const cachedAt = authCache.get(cacheKey)
  if (cachedAt && Date.now() - cachedAt < 30000) return username
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
    if (body && body['subsonic-response'] && body['subsonic-response'].status === 'ok') {
      authCache.set(cacheKey, Date.now())
      return username
    }
    return null
  } catch {
    return null
  }
}

async function ensureLivePlaybackTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS live_playback (username TEXT PRIMARY KEY, device_id TEXT NOT NULL, device_name TEXT NOT NULL, state_json TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL, command_json TEXT, command_revision INTEGER NOT NULL DEFAULT 0, command_target_device TEXT, command_updated_at INTEGER)").run()
}

async function ensureReleaseTable(db) {
  await db.prepare("CREATE TABLE IF NOT EXISTS release_metadata (album_id TEXT PRIMARY KEY, release_type TEXT NOT NULL, release_date TEXT, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT, source TEXT NOT NULL DEFAULT 'manual', musicbrainz_id TEXT, match_score INTEGER)").run()
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

function releaseTitleHint(title) {
  const value = String(title || '').trim()
  if (/\((?:cd|disc)?\s*\d*\s*single(?:\s*version)?\)\s*$/i.test(value) || /\b(?:cd|disc)?\s*\d*\s*single\b/i.test(value)) return 'single'
  if (/\((?:cd|disc)?\s*\d*\s*e\.?p\.?\)\s*$/i.test(value) || /\be\.?p\.?\b/i.test(value)) return 'ep'
  return null
}

function cleanReleaseTitle(title) {
  return String(title || '').replace(/\s*\((?:cd|disc)?\s*\d*\s*(?:single(?:\s*version)?|e\.?p\.?)\)\s*$/i, '').trim()
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

  const originalTitle = String(album.name || '').replace(/"/g, '').trim()
  const title = cleanReleaseTitle(originalTitle)
  const artist = String(album.artist || '').replace(/"/g, '').trim()
  if (!title || !artist) return null

  const searchUrl = new URL('https://musicbrainz.org/ws/2/release-group/')
  const hintedType = releaseTitleHint(originalTitle)
  const typeQuery = hintedType === 'single' ? ' AND primarytype:single' : hintedType === 'ep' ? ' AND primarytype:ep' : ''
  searchUrl.searchParams.set('query', 'releasegroup:"' + title + '" AND artist:"' + artist + '"' + typeQuery)
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


    if (pathname === '/api/live-playback' && request.method === 'GET') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'live-playback-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      await ensureLivePlaybackTable(env.TOMIFY_DB)
      const row = await env.TOMIFY_DB.prepare('SELECT device_id AS deviceId, device_name AS deviceName, state_json AS stateJson, revision, updated_at AS updatedAt, command_json AS commandJson, command_revision AS commandRevision, command_target_device AS commandTargetDevice, command_updated_at AS commandUpdatedAt FROM live_playback WHERE username = ?').bind(username).first()
      if (!row) return json({ state: null, command: null })

      let state = null
      let command = null
      try {
        state = { ...JSON.parse(row.stateJson), deviceId: row.deviceId, deviceName: row.deviceName, revision: Number(row.revision || 0), updatedAt: Number(row.updatedAt || 0) }
      } catch { state = null }

      if (row.commandJson && row.commandTargetDevice) {
        try {
          command = { ...JSON.parse(row.commandJson), revision: Number(row.commandRevision || 0), targetDeviceId: row.commandTargetDevice, updatedAt: Number(row.commandUpdatedAt || 0) }
        } catch { command = null }
      }

      return json({ state, command })
    }

    if (pathname === '/api/live-playback' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'live-playback-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      if (!body || typeof body.deviceId !== 'string' || !Array.isArray(body.queue) || !Number.isInteger(body.currentIndex)) return json({ error: 'invalid-live-playback-state' }, 400)

      await ensureLivePlaybackTable(env.TOMIFY_DB)
      const previous = await env.TOMIFY_DB.prepare('SELECT device_id AS deviceId, revision FROM live_playback WHERE username = ?').bind(username).first()
      const takeover = body.takeover === true
      if (previous?.deviceId && previous.deviceId !== body.deviceId && !takeover) {
        return json({ error: 'playback-owned-by-another-device', deviceId: previous.deviceId }, 409)
      }
      const revision = Number(previous?.revision || 0) + 1
      const updatedAt = Date.now()
      const state = {
        queue: body.queue,
        currentIndex: body.currentIndex,
        playing: body.playing === true,
        currentTime: Number(body.currentTime || 0),
        duration: Number(body.duration || 0),
        volume: Math.max(0, Math.min(1, Number(body.volume ?? 0.8))),
        muted: body.muted === true,
        shuffle: body.shuffle === true,
        repeat: ['off', 'all', 'one'].includes(body.repeat) ? body.repeat : 'off',
      }
      const deviceName = typeof body.deviceName === 'string' && body.deviceName ? body.deviceName.slice(0, 64) : 'Web'

      await env.TOMIFY_DB.prepare('INSERT INTO live_playback (username, device_id, device_name, state_json, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(username) DO UPDATE SET device_id = excluded.device_id, device_name = excluded.device_name, state_json = excluded.state_json, revision = excluded.revision, updated_at = excluded.updated_at')
        .bind(username, body.deviceId, deviceName, JSON.stringify(state), revision, updatedAt).run()

      return json({ state: { ...state, deviceId: body.deviceId, deviceName, revision, updatedAt } })
    }

    if (pathname === '/api/live-playback/command' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'live-playback-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const allowed = ['play', 'pause', 'next', 'previous', 'seek', 'toggle-shuffle', 'cycle-repeat', 'play-index', 'remove-index', 'clear-queue', 'toggle-muted', 'set-volume']
      if (!body || typeof body.targetDeviceId !== 'string' || !allowed.includes(body.action)) return json({ error: 'invalid-command' }, 400)

      await ensureLivePlaybackTable(env.TOMIFY_DB)
      const row = await env.TOMIFY_DB.prepare('SELECT device_id AS deviceId, command_revision AS commandRevision FROM live_playback WHERE username = ?').bind(username).first()
      if (!row) return json({ error: 'no-active-playback' }, 404)
      if (row.deviceId !== body.targetDeviceId) return json({ error: 'playback-device-changed' }, 409)

      const revision = Number(row.commandRevision || 0) + 1
      const updatedAt = Date.now()
      const command = { action: body.action }
      if (typeof body.value === 'number' && Number.isFinite(body.value)) command.value = body.value

      await env.TOMIFY_DB.prepare('UPDATE live_playback SET command_json = ?, command_revision = ?, command_target_device = ?, command_updated_at = ? WHERE username = ?')
        .bind(JSON.stringify(command), revision, body.targetDeviceId, updatedAt, username).run()

      return json({ command: { ...command, revision, targetDeviceId: body.targetDeviceId, updatedAt } })
    }

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
      const replaceManual = album.replaceManual === true
      if (existing && (!force || (existing.source === 'manual' && !replaceManual))) return json({ item: existing, cached: true })

      const match = await lookupMusicBrainzReleaseGroup(album)
      if (!match?.group) return json({ error: 'musicbrainz-no-match' }, 404)

      const releaseType = musicBrainzType(match.group)
      const releaseDate = typeof match.group['first-release-date'] === 'string' && /^\\d{4}(?:-\\d{2})?(?:-\\d{2})?$/.test(match.group['first-release-date']) ? match.group['first-release-date'] : null
      const groupId = typeof match.group.id === 'string' ? match.group.id : null

      await env.TOMIFY_DB.prepare("INSERT INTO release_metadata (album_id, release_type, release_date, updated_at, updated_by, source, musicbrainz_id, match_score) VALUES (?, ?, ?, CURRENT_TIMESTAMP, ?, 'musicbrainz', ?, ?) ON CONFLICT(album_id) DO UPDATE SET release_type = excluded.release_type, release_date = excluded.release_date, updated_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by, source = 'musicbrainz', musicbrainz_id = excluded.musicbrainz_id, match_score = excluded.match_score")
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
