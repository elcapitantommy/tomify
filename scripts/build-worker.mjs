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

async function ensureRecoveryTables(db) {
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS recovery_items (id TEXT PRIMARY KEY, username TEXT NOT NULL, artist TEXT NOT NULL, title TEXT NOT NULL, album TEXT, duration REAL, track_number INTEGER, disc_number INTEGER, musicbrainz_id TEXT, status TEXT NOT NULL DEFAULT 'missing', notes TEXT, error TEXT, selected_candidate_id TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare("CREATE TABLE IF NOT EXISTS recovery_candidates (id TEXT PRIMARY KEY, recovery_id TEXT NOT NULL, backend TEXT NOT NULL, external_id TEXT NOT NULL, url TEXT NOT NULL, title TEXT NOT NULL, channel TEXT NOT NULL, channel_id TEXT, duration REAL, official INTEGER NOT NULL DEFAULT 0, match_score INTEGER NOT NULL DEFAULT 0, thumbnail TEXT, codec TEXT, container TEXT, bitrate INTEGER, sample_rate INTEGER, channels INTEGER, imported_path TEXT, provenance_json TEXT, rights_basis TEXT, selected INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_recovery_items_username_status ON recovery_items(username, status)'),
    db.prepare('CREATE INDEX IF NOT EXISTS idx_recovery_candidates_recovery ON recovery_candidates(recovery_id, match_score DESC)'),
  ])
}

function recoveryCandidateRow(row) {
  let provenance = null
  try { provenance = row.provenanceJson ? JSON.parse(row.provenanceJson) : null } catch { provenance = null }
  return {
    id: row.id, backend: row.backend, externalId: row.externalId, url: row.url, title: row.title, channel: row.channel,
    channelId: row.channelId ?? null, duration: row.duration == null ? null : Number(row.duration), official: Boolean(row.official),
    matchScore: Number(row.matchScore || 0), thumbnail: row.thumbnail ?? null, codec: row.codec ?? null, container: row.container ?? null,
    bitrate: row.bitrate == null ? null : Number(row.bitrate), sampleRate: row.sampleRate == null ? null : Number(row.sampleRate), channels: row.channels == null ? null : Number(row.channels),
    importedPath: row.importedPath ?? null, provenance, selected: Boolean(row.selected),
  }
}

async function recoveryItem(db, username, id) {
  const row = await db.prepare('SELECT id, artist, title, album, duration, track_number AS trackNumber, disc_number AS discNumber, musicbrainz_id AS musicBrainzId, status, notes, error, created_at AS createdAt, updated_at AS updatedAt FROM recovery_items WHERE username = ? AND id = ?').bind(username, id).first()
  if (!row) return null
  const candidates = await db.prepare('SELECT id, backend, external_id AS externalId, url, title, channel, channel_id AS channelId, duration, official, match_score AS matchScore, thumbnail, codec, container, bitrate, sample_rate AS sampleRate, channels, imported_path AS importedPath, provenance_json AS provenanceJson, selected FROM recovery_candidates WHERE recovery_id = ? ORDER BY selected DESC, match_score DESC, created_at DESC').bind(id).all()
  return { ...row, duration: row.duration == null ? null : Number(row.duration), trackNumber: row.trackNumber == null ? null : Number(row.trackNumber), discNumber: row.discNumber == null ? null : Number(row.discNumber), candidates: (candidates.results || []).map(recoveryCandidateRow) }
}

function recoveryTokens(value) {
  return new Set(String(value || '').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean))
}

function recoveryTokenScore(expected, actual) {
  const wanted = recoveryTokens(expected)
  const found = recoveryTokens(actual)
  if (!wanted.size) return 0
  let matches = 0
  for (const token of wanted) if (found.has(token)) matches += 1
  return matches / wanted.size
}

function scoreRecoveryCandidate(item, candidate) {
  const title = recoveryTokenScore(item.title, candidate.title)
  const artist = Math.max(recoveryTokenScore(item.artist, candidate.title), recoveryTokenScore(item.artist, candidate.channel))
  const difference = item.duration && candidate.duration ? Math.abs(Number(item.duration) - Number(candidate.duration)) : null
  const duration = difference == null ? 0.5 : difference <= 2 ? 1 : difference <= 5 ? 0.8 : difference <= 12 ? 0.35 : 0
  const combined = String(candidate.title || '') + ' ' + String(candidate.channel || '')
  const looksOfficial = ['official', 'topic', 'vevo', 'records', 'recordings'].some((word) => combined.toLocaleLowerCase('en').includes(word))
  const unwanted = [' live', 'remix', 'karaoke', 'nightcore', 'sped up', 'slowed', ' cover', 'instrumental'].some((word) => String(candidate.title || '').toLocaleLowerCase('en').includes(word)) && !String(item.title || '').toLocaleLowerCase('en').includes('live')
  return { official: looksOfficial, score: Math.max(0, Math.min(100, Math.round(title * 48 + artist * 28 + duration * 18 + (looksOfficial ? 6 : 0) - (unwanted ? 24 : 0)))) }
}

async function callRecoveryAgent(env, path, body) {
  if (!env.RECOVERY_AGENT_URL) throw new Error('The recovery agent is not configured.')
  const headers = { 'content-type': 'application/json', accept: 'application/json' }
  if (env.RECOVERY_AGENT_TOKEN) headers.authorization = 'Bearer ' + env.RECOVERY_AGENT_TOKEN
  const baseUrl = String(env.RECOVERY_AGENT_URL)
  const response = await fetch((baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl) + path, { method: 'POST', headers, body: JSON.stringify(body) })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.message || result.error || 'Recovery agent request failed.')
  return result
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

    if (pathname === '/api/recovery' && request.method === 'GET') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      await ensureRecoveryTables(env.TOMIFY_DB)
      const rows = await env.TOMIFY_DB.prepare('SELECT id FROM recovery_items WHERE username = ? ORDER BY updated_at DESC, created_at DESC').bind(username).all()
      const items = []
      for (const row of rows.results || []) items.push(await recoveryItem(env.TOMIFY_DB, username, row.id))
      const youtubeBackend = { id: 'youtube', label: 'YouTube', available: Boolean(env.RECOVERY_AGENT_URL), authentication: env.RECOVERY_AGENT_URL ? 'unavailable' : 'not-configured', reason: env.RECOVERY_AGENT_URL ? null : 'The media-server recovery agent has not been connected yet.' }
      if (env.RECOVERY_AGENT_URL) {
        try {
          const status = await callRecoveryAgent(env, '/v1/status', {})
          const remote = Array.isArray(status.backends) ? status.backends.find((backend) => backend?.id === 'youtube') : null
          youtubeBackend.available = remote?.available !== false
          youtubeBackend.authentication = remote?.authentication === 'configured' ? 'configured' : 'not-configured'
        } catch { youtubeBackend.authentication = 'unavailable' }
      }
      return json({ items: items.filter(Boolean), backends: [youtubeBackend] })
    }

    if (pathname === '/api/recovery' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      if (!body || typeof body.artist !== 'string' || !body.artist.trim() || typeof body.title !== 'string' || !body.title.trim()) return json({ error: 'invalid-wanted-track' }, 400)
      await ensureRecoveryTables(env.TOMIFY_DB)
      const id = crypto.randomUUID()
      await env.TOMIFY_DB.prepare("INSERT INTO recovery_items (id, username, artist, title, album, duration, track_number, disc_number, musicbrainz_id, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')")
        .bind(id, username, body.artist.trim().slice(0, 240), body.title.trim().slice(0, 240), typeof body.album === 'string' ? body.album.trim().slice(0, 240) || null : null, Number.isFinite(body.duration) && body.duration > 0 ? body.duration : null, Number.isInteger(body.trackNumber) && body.trackNumber > 0 ? body.trackNumber : null, Number.isInteger(body.discNumber) && body.discNumber > 0 ? body.discNumber : null, typeof body.musicBrainzId === 'string' ? body.musicBrainzId.slice(0, 64) : null).run()
      return json({ item: await recoveryItem(env.TOMIFY_DB, username, id) }, 201)
    }

    const recoveryMatch = pathname.match(/^\\/api\\/recovery\\/([^/]+)(?:\\/(search|select|acquire))?$/)
    if (recoveryMatch && request.method === 'DELETE' && !recoveryMatch[2]) {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      await ensureRecoveryTables(env.TOMIFY_DB)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (!item) return json({ error: 'recovery-item-not-found' }, 404)
      const importedPaths = [...new Set(item.candidates.map((candidate) => candidate.importedPath).filter((path) => typeof path === 'string' && path.length > 0))]
      if (importedPaths.length) {
        try {
          await callRecoveryAgent(env, '/v1/delete', { importedPaths })
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Recovery library cleanup failed.'
          return json({ error: 'recovery-delete-failed', message: 'Files could not be removed from the recovery library. The queue item was kept. ' + message }, 502)
        }
      }
      await env.TOMIFY_DB.batch([
        env.TOMIFY_DB.prepare('DELETE FROM recovery_candidates WHERE recovery_id = ?').bind(item.id),
        env.TOMIFY_DB.prepare('DELETE FROM recovery_items WHERE id = ? AND username = ?').bind(item.id, username),
      ])
      return json({ deleted: true, filesRemoved: importedPaths.length > 0 })
    }

    if (recoveryMatch && request.method === 'PATCH' && !recoveryMatch[2]) {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const allowed = ['missing', 'candidate-found', 'recovered', 'needs-upgrade', 'failed']
      if (!body || !allowed.includes(body.status)) return json({ error: 'invalid-recovery-status' }, 400)
      await ensureRecoveryTables(env.TOMIFY_DB)
      await env.TOMIFY_DB.prepare('UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?').bind(body.status, recoveryMatch[1], username).run()
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      return item ? json({ item }) : json({ error: 'recovery-item-not-found' }, 404)
    }

    if (recoveryMatch && recoveryMatch[2] === 'search' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      await ensureRecoveryTables(env.TOMIFY_DB)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      if (!item) return json({ error: 'recovery-item-not-found' }, 404)
      try {
        const result = await callRecoveryAgent(env, '/v1/search', { backend: 'youtube', track: { artist: item.artist, title: item.title, album: item.album, duration: item.duration } })
        const candidates = Array.isArray(result.candidates) ? result.candidates.slice(0, 12) : []
        await env.TOMIFY_DB.prepare('DELETE FROM recovery_candidates WHERE recovery_id = ? AND imported_path IS NULL').bind(item.id).run()
        const inserts = candidates.filter((candidate) => candidate && typeof candidate.url === 'string' && typeof candidate.externalId === 'string').map((candidate) => {
          const scored = scoreRecoveryCandidate(item, candidate)
          return env.TOMIFY_DB.prepare("INSERT INTO recovery_candidates (id, recovery_id, backend, external_id, url, title, channel, channel_id, duration, official, match_score, thumbnail, provenance_json) VALUES (?, ?, 'youtube', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(crypto.randomUUID(), item.id, candidate.externalId.slice(0, 120), candidate.url.slice(0, 1000), String(candidate.title || '').slice(0, 500), String(candidate.channel || 'Unknown channel').slice(0, 240), typeof candidate.channelId === 'string' ? candidate.channelId.slice(0, 120) : null, Number.isFinite(candidate.duration) ? candidate.duration : null, scored.official ? 1 : 0, scored.score, typeof candidate.thumbnail === 'string' ? candidate.thumbnail.slice(0, 1000) : null, JSON.stringify({ discoveredAt: new Date().toISOString(), backend: 'youtube', raw: candidate.provenance || null }))
        })
        if (inserts.length) await env.TOMIFY_DB.batch(inserts)
        await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = ?, error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(inserts.length ? 'candidate-found' : 'missing', item.id, username).run()
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Candidate search failed.'
        await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(message.slice(0, 500), item.id, username).run()
        return json({ error: 'candidate-search-failed', message }, 502)
      }
    }

    if (recoveryMatch && recoveryMatch[2] === 'select' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      await ensureRecoveryTables(env.TOMIFY_DB)
      const candidate = body && typeof body.candidateId === 'string' ? await env.TOMIFY_DB.prepare('SELECT c.id FROM recovery_candidates c JOIN recovery_items i ON i.id = c.recovery_id WHERE c.id = ? AND c.recovery_id = ? AND i.username = ?').bind(body.candidateId, recoveryMatch[1], username).first() : null
      if (!candidate) return json({ error: 'recovery-candidate-not-found' }, 404)
      await env.TOMIFY_DB.batch([env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 0 WHERE recovery_id = ?').bind(recoveryMatch[1]), env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(body.candidateId), env.TOMIFY_DB.prepare("UPDATE recovery_items SET selected_candidate_id = ?, status = 'candidate-found', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(body.candidateId, recoveryMatch[1], username)])
      return json({ item: await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1]) })
    }

    if (recoveryMatch && recoveryMatch[2] === 'acquire' && request.method === 'POST') {
      if (!env || !env.TOMIFY_DB) return json({ error: 'recovery-store-unavailable' }, 503)
      const username = await authenticate(request)
      if (!username) return json({ error: 'unauthorized' }, 401)
      const body = await request.json()
      const rights = ['uploader-authorised', 'creative-commons', 'public-domain', 'other-authorisation']
      if (!body || body.confirmedAuthorised !== true || !rights.includes(body.rightsBasis) || typeof body.candidateId !== 'string') return json({ error: 'source-authorisation-required' }, 400)
      await ensureRecoveryTables(env.TOMIFY_DB)
      const item = await recoveryItem(env.TOMIFY_DB, username, recoveryMatch[1])
      const candidate = item?.candidates.find((value) => value.id === body.candidateId)
      if (!item || !candidate) return json({ error: 'recovery-candidate-not-found' }, 404)
      await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'importing', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(item.id, username).run()
      try {
        const result = await callRecoveryAgent(env, '/v1/acquire', { backend: 'youtube', candidate: { externalId: candidate.externalId, url: candidate.url, title: candidate.title, channel: candidate.channel }, track: { artist: item.artist, title: item.title, album: item.album, duration: item.duration, trackNumber: item.trackNumber, discNumber: item.discNumber, musicBrainzId: item.musicBrainzId }, authorisation: { confirmed: true, basis: body.rightsBasis, confirmedBy: username, confirmedAt: new Date().toISOString() } })
        const quality = result.quality || {}
        const provenance = { ...(result.provenance || {}), source: 'youtube', sourceUrl: candidate.url, rightsBasis: body.rightsBasis, archiveStatus: 'lossy-recovery-copy', importedAt: new Date().toISOString() }
        await env.TOMIFY_DB.batch([
          env.TOMIFY_DB.prepare('UPDATE recovery_candidates SET selected = 1, codec = ?, container = ?, bitrate = ?, sample_rate = ?, channels = ?, duration = COALESCE(?, duration), imported_path = ?, provenance_json = ?, rights_basis = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').bind(quality.codec || null, quality.container || null, Number.isFinite(quality.bitrate) ? quality.bitrate : null, Number.isFinite(quality.sampleRate) ? quality.sampleRate : null, Number.isFinite(quality.channels) ? quality.channels : null, Number.isFinite(quality.duration) ? quality.duration : null, String(result.path || '').slice(0, 1000), JSON.stringify(provenance), body.rightsBasis, candidate.id),
          env.TOMIFY_DB.prepare("UPDATE recovery_items SET selected_candidate_id = ?, status = 'needs-upgrade', error = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(candidate.id, item.id, username),
        ])
        return json({ item: await recoveryItem(env.TOMIFY_DB, username, item.id) })
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Import failed.'
        await env.TOMIFY_DB.prepare("UPDATE recovery_items SET status = 'failed', error = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND username = ?").bind(message.slice(0, 500), item.id, username).run()
        return json({ error: 'recovery-import-failed', message }, 502)
      }
    }


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
