// Album completeness: resolves a MusicBrainz release tracklist for a Navidrome album,
// caches it in D1 and turns missing tracks into Recovery items. The pure helpers are
// exported for tests; handleCompletenessRequest relies on Worker globals (authenticate,
// json, musicBrainzJson, lookupMusicBrainzReleaseGroup, selectRelease, ensureRecoveryTables).

export function completenessText(value) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[\u2019']/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
}

export function isMusicBrainzId(value) {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function completenessCredit(credits) {
  return (Array.isArray(credits) ? credits : []).map((credit) => `${credit?.name || credit?.artist?.name || ''}${credit?.joinphrase || ''}`).join('').trim()
}

export function summariseReleaseEditions(releases) {
  return (Array.isArray(releases) ? releases : []).filter((release) => isMusicBrainzId(release?.id) && !['bootleg', 'pseudo-release'].includes(String(release?.status || '').toLowerCase())).map((release) => {
    const media = Array.isArray(release.media) ? release.media : []
    const formats = [...new Set(media.map((medium) => String(medium?.format || '').trim()).filter(Boolean))]
    return {
      id: release.id, title: String(release.title || ''), date: release.date || null, country: release.country || null,
      status: release.status || null, disambiguation: release.disambiguation || null, format: formats.join(' + ') || null,
      trackCount: media.reduce((sum, medium) => sum + (Number(medium?.['track-count']) || 0), 0), discCount: media.length,
    }
  }).sort((left, right) => String(left.date || '9999').localeCompare(String(right.date || '9999')) || left.title.localeCompare(right.title)).slice(0, 100)
}

export function chooseReleaseEdition(editions, localTrackCount) {
  const usable = (Array.isArray(editions) ? editions : []).filter((edition) => edition.trackCount > 0)
  if (!usable.length) return null
  const official = usable.filter((edition) => String(edition.status || '').toLowerCase() === 'official')
  const pool = official.length ? official : usable
  const counts = new Map()
  for (const edition of pool) counts.set(edition.trackCount, (counts.get(edition.trackCount) || 0) + 1)
  const modal = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]
  // A partial album should be compared with the standard edition, not the release closest to what survived.
  const local = Number(localTrackCount) || 0
  const target = local >= modal * 0.8 ? local : modal
  const formatRank = (edition) => /\b(cd|digital)\b/i.test(String(edition.format || '')) ? 0 : 1
  return [...pool].sort((left, right) => Math.abs(left.trackCount - target) - Math.abs(right.trackCount - target) || formatRank(left) - formatRank(right) || String(left.date || '9999').localeCompare(String(right.date || '9999')))[0]
}

export function mapReleaseTracklist(release, albumId, source, releaseGroupId = null) {
  const media = Array.isArray(release?.media) ? release.media : []
  const releaseArtist = completenessCredit(release?.['artist-credit'])
  const tracks = media.flatMap((medium, mediumIndex) => (Array.isArray(medium?.tracks) ? medium.tracks : []).map((track, trackIndex) => {
    const disc = Number(medium.position) || mediumIndex + 1
    const number = Number(track.position) || Number.parseInt(String(track.number || ''), 10) || trackIndex + 1
    const length = Number(track.length || track.recording?.length)
    return {
      key: `${disc}-${number}`, disc, number, title: String(track.title || track.recording?.title || ''),
      artist: completenessCredit(track['artist-credit'] || track.recording?.['artist-credit']) || releaseArtist || null,
      length: Number.isFinite(length) && length > 0 ? Math.round(length / 100) / 10 : null,
      recordingId: isMusicBrainzId(track.recording?.id) ? track.recording.id : null,
      isrc: Array.isArray(track.recording?.isrcs) && track.recording.isrcs[0] ? String(track.recording.isrcs[0]) : null,
    }
  })).filter((track) => track.title).slice(0, 500)
  const formats = [...new Set(media.map((medium) => String(medium?.format || '').trim()).filter(Boolean))]
  return {
    albumId, releaseId: release.id, releaseGroupId: release?.['release-group']?.id || releaseGroupId || null,
    title: String(release.title || ''), artist: releaseArtist || null, date: release.date || null, country: release.country || null,
    format: formats.join(' + ') || null, status: release.status || null, disambiguation: release.disambiguation || null,
    discCount: media.length, source, fetchedAt: new Date().toISOString(), tracks,
  }
}

export function matchRecoveryItems(tracks, rows) {
  const matches = {}
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const title = completenessText(track.title)
    const artist = completenessText(track.artist)
    const row = (Array.isArray(rows) ? rows : []).find((value) => track.recordingId && value.musicBrainzId === track.recordingId)
      || (Array.isArray(rows) ? rows : []).find((value) => completenessText(value.title) === title && completenessText(value.artist) === artist)
    if (row) matches[track.key] = { id: row.id, status: row.status }
  }
  return matches
}

async function ensureTracklistTable(db) {
  await db.prepare('CREATE TABLE IF NOT EXISTS release_tracklists (album_id TEXT PRIMARY KEY, release_id TEXT NOT NULL, release_group_id TEXT, source TEXT NOT NULL, tracklist_json TEXT NOT NULL, editions_json TEXT, fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_by TEXT)').run()
}

async function selectTracklist(db, albumId) {
  const row = await db.prepare('SELECT tracklist_json AS tracklistJson, editions_json AS editionsJson FROM release_tracklists WHERE album_id = ?').bind(albumId).first()
  if (!row) return null
  try { return { tracklist: JSON.parse(row.tracklistJson), editions: row.editionsJson ? JSON.parse(row.editionsJson) : [] } } catch { return null }
}

async function fetchMusicBrainzRelease(id) {
  if (!isMusicBrainzId(id)) return null
  const url = new URL('https://musicbrainz.org/ws/2/release/' + id)
  url.searchParams.set('inc', 'recordings artist-credits isrcs release-groups')
  url.searchParams.set('fmt', 'json')
  const release = await musicBrainzJson(url)
  return release?.id ? release : null
}

async function resolveAlbumTracklist(db, album, requestedReleaseId) {
  let release = null
  let source = 'auto'
  if (requestedReleaseId) { release = await fetchMusicBrainzRelease(requestedReleaseId); source = 'manual' }
  if (!release && isMusicBrainzId(album.musicBrainzId)) { release = await fetchMusicBrainzRelease(album.musicBrainzId); if (release) source = 'tagged' }
  let releaseGroupId = release?.['release-group']?.id || (await selectRelease(db, album.albumId))?.musicBrainzId || null
  if (!release && !releaseGroupId) releaseGroupId = (await lookupMusicBrainzReleaseGroup({ name: album.name, artist: album.artist, year: album.year, musicBrainzId: album.musicBrainzId }))?.group?.id || null
  let editions = []
  if (isMusicBrainzId(releaseGroupId)) {
    const browse = new URL('https://musicbrainz.org/ws/2/release')
    browse.searchParams.set('release-group', releaseGroupId)
    browse.searchParams.set('inc', 'media')
    browse.searchParams.set('limit', '100')
    browse.searchParams.set('fmt', 'json')
    editions = summariseReleaseEditions((await musicBrainzJson(browse))?.releases)
  }
  if (!release) {
    const chosen = chooseReleaseEdition(editions, album.localTrackCount)
    if (chosen) release = await fetchMusicBrainzRelease(chosen.id)
  }
  if (!release) return null
  const tracklist = mapReleaseTracklist(release, album.albumId, source, releaseGroupId)
  return tracklist.tracks.length ? { tracklist, editions } : null
}

async function completenessRecoveryRows(db, username) {
  const rows = await db.prepare('SELECT id, artist, title, musicbrainz_id AS musicBrainzId, status FROM recovery_items WHERE username = ?').bind(username).all()
  return rows.results || []
}

async function handleCompletenessRequest(request, env, url) {
  if (!url.pathname.startsWith('/api/album-completeness/')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'completeness-store-unavailable' }, 503)
  const username = await authenticate(request)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (request.method !== 'POST') return json({ error: 'not-found' }, 404)
  const body = await request.json().catch(() => null)
  const albumId = typeof body?.albumId === 'string' ? body.albumId.trim().slice(0, 200) : ''
  if (!albumId) return json({ error: 'invalid-album' }, 400)
  const db = env.TOMIFY_DB
  await ensureTracklistTable(db)
  await ensureReleaseTable(db)
  await ensureRecoveryTables(db)

  if (url.pathname === '/api/album-completeness/tracklist') {
    let cached = await selectTracklist(db, albumId)
    const requestedReleaseId = isMusicBrainzId(body.releaseId) ? body.releaseId : body.force === true && cached?.tracklist?.source === 'manual' ? cached.tracklist.releaseId : null
    if (!cached || body.force === true || (requestedReleaseId && requestedReleaseId !== cached.tracklist.releaseId)) {
      let resolved
      try { resolved = await resolveAlbumTracklist(db, { albumId, name: String(body.name || ''), artist: String(body.artist || ''), year: Number(body.year) || null, musicBrainzId: body.musicBrainzId, localTrackCount: Number(body.localTrackCount) || 0 }, requestedReleaseId) }
      catch { return json({ error: 'musicbrainz-unavailable', message: 'MusicBrainz could not be reached. Try again shortly.' }, 502) }
      if (!resolved) return json({ error: 'tracklist-unavailable', message: 'MusicBrainz has no confident tracklist for this album.' }, 404)
      await db.prepare('INSERT INTO release_tracklists (album_id, release_id, release_group_id, source, tracklist_json, editions_json, fetched_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET release_id = excluded.release_id, release_group_id = excluded.release_group_id, source = excluded.source, tracklist_json = excluded.tracklist_json, editions_json = excluded.editions_json, fetched_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
        .bind(albumId, resolved.tracklist.releaseId, resolved.tracklist.releaseGroupId, resolved.tracklist.source, JSON.stringify(resolved.tracklist), JSON.stringify(resolved.editions), username).run()
      cached = resolved
    }
    return json({ ...cached, recovery: matchRecoveryItems(cached.tracklist.tracks, await completenessRecoveryRows(db, username)) })
  }

  if (url.pathname === '/api/album-completeness/recovery') {
    const cached = await selectTracklist(db, albumId)
    if (!cached) return json({ error: 'tracklist-required', message: 'Load the album tracklist before adding missing tracks.' }, 409)
    const keys = new Set((Array.isArray(body.trackKeys) ? body.trackKeys : []).filter((key) => typeof key === 'string').slice(0, 500))
    const wanted = cached.tracklist.tracks.filter((track) => keys.has(track.key))
    if (!wanted.length) return json({ error: 'invalid-tracks' }, 400)
    const existing = matchRecoveryItems(wanted, await completenessRecoveryRows(db, username))
    const rows = wanted.filter((track) => !existing[track.key]).map((track) => {
      const source = { catalogueSource: 'musicbrainz', origin: 'album-completeness', albumId, releaseId: cached.tracklist.releaseId, releaseGroupId: cached.tracklist.releaseGroupId, trackKey: track.key, recordingId: track.recordingId, isrc: track.isrc, releaseDate: cached.tracklist.date }
      return [crypto.randomUUID(), username, String(track.artist || cached.tracklist.artist || 'Unknown Artist').slice(0, 240), track.title.slice(0, 240), cached.tracklist.title.slice(0, 240) || null, track.length, track.number, track.disc, track.recordingId, JSON.stringify(source)]
    })
    // D1 limits bound parameters per statement and queries per request, so insert up to nine rows per statement.
    const statements = []
    for (let offset = 0; offset < rows.length; offset += 9) {
      const values = rows.slice(offset, offset + 9)
      statements.push(db.prepare("INSERT INTO recovery_items (id, username, artist, title, album, duration, track_number, disc_number, musicbrainz_id, source_json, status) VALUES " + values.map(() => "(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'missing')").join(', ')).bind(...values.flat()))
    }
    if (statements.length) await db.batch(statements)
    return json({ created: rows.length, existing: wanted.length - rows.length, recovery: matchRecoveryItems(cached.tracklist.tracks, await completenessRecoveryRows(db, username)) }, rows.length ? 201 : 200)
  }

  return json({ error: 'not-found' }, 404)
}

export const completenessWorkerSource = [completenessText, isMusicBrainzId, completenessCredit, summariseReleaseEditions, chooseReleaseEdition, mapReleaseTracklist, matchRecoveryItems, ensureTracklistTable, selectTracklist, fetchMusicBrainzRelease, resolveAlbumTracklist, completenessRecoveryRows, handleCompletenessRequest].map((fn) => fn.toString()).join('\n\n')
