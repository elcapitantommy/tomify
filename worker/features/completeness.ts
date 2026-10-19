// Album completeness: resolves a MusicBrainz release tracklist for a Navidrome album,
// caches it in D1 and turns missing tracks into Recovery items. The pure helpers are
// exported for tests; handleCompletenessRequest relies on Worker globals (authenticate,
// json, musicBrainzJson, lookupMusicBrainzReleaseGroup, selectRelease).

import { authenticate, isNavidromeAdmin } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import type { Env } from '../env.ts'
import { lookupMusicBrainzReleaseGroup, musicBrainzJson, selectRelease, type OpenJson } from '../routes/recovery.ts'

export interface ReleaseEdition { id: string; title: string; date: string | null; country: string | null; status: string | null; disambiguation: string | null; format: string | null; trackCount: number; discCount: number }
export interface TracklistTrack { key: string; disc: number; number: number; title: string; artist: string | null; length: number | null; recordingId: string | null; isrc: string | null }
export interface AlbumTracklist { albumId: string; releaseId: string; releaseGroupId: string | null; title: string; artist: string | null; date: string | null; country: string | null; format: string | null; status: string | null; disambiguation: string | null; discCount: number; source: string; fetchedAt: string; tracks: TracklistTrack[]; localTrackCount?: number }
export interface CachedTracklist { tracklist: AlbumTracklist; editions: ReleaseEdition[] }
interface CompletenessRecoveryRow { id: string; artist: string; title: string; musicBrainzId: string | null; status: string; sourceJson?: string | null }
interface CompletenessAlbum { albumId: string; name: string; artist: string; year: number | null; musicBrainzId?: unknown; localTrackCount: number }

export function completenessText(value: unknown) {
  return String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').normalize('NFC').toLocaleLowerCase('en').replace(/&/g, ' and ').replace(/[\u2019']/g, '').replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ').trim()
}
export function isMusicBrainzId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
}

export function completenessCredit(credits: OpenJson) {
  return (Array.isArray(credits) ? credits : []).map((credit: OpenJson) => `${credit?.name || credit?.artist?.name || ''}${credit?.joinphrase || ''}`).join('').trim()
}

export function summariseReleaseEditions(releases: OpenJson): ReleaseEdition[] {
  return (Array.isArray(releases) ? releases : []).filter((release: OpenJson) => isMusicBrainzId(release?.id) && !['bootleg', 'pseudo-release'].includes(String(release?.status || '').toLowerCase())).map((release: OpenJson) => {
    const media: OpenJson[] = Array.isArray(release.media) ? release.media : []
    const formats = [...new Set(media.map((medium) => String(medium?.format || '').trim()).filter(Boolean))]
    return {
      id: release.id, title: String(release.title || ''), date: release.date || null, country: release.country || null,
      status: release.status || null, disambiguation: release.disambiguation || null, format: formats.join(' + ') || null,
      trackCount: media.reduce((sum, medium) => sum + (Number(medium?.['track-count']) || 0), 0), discCount: media.length,
    }
  }).sort((left, right) => String(left.date || '9999').localeCompare(String(right.date || '9999')) || left.title.localeCompare(right.title)).slice(0, 100)
}

export function chooseReleaseEdition(editions: ReleaseEdition[], localTrackCount: unknown) {
  const usable = (Array.isArray(editions) ? editions : []).filter((edition) => edition.trackCount > 0)
  if (!usable.length) return null
  const official = usable.filter((edition) => String(edition.status || '').toLowerCase() === 'official')
  const pool = official.length ? official : usable
  const counts = new Map<number, number>()
  for (const edition of pool) counts.set(edition.trackCount, (counts.get(edition.trackCount) || 0) + 1)
  const modal = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0]
  // A partial album should be compared with the standard edition, not the release closest to what survived.
  const local = Number(localTrackCount) || 0
  const target = local >= modal * 0.8 ? local : modal
  const formatRank = (edition: ReleaseEdition) => /\b(cd|digital)\b/i.test(String(edition.format || '')) ? 0 : 1
  return [...pool].sort((left, right) => Math.abs(left.trackCount - target) - Math.abs(right.trackCount - target) || formatRank(left) - formatRank(right) || String(left.date || '9999').localeCompare(String(right.date || '9999')))[0]
}

// An edition far smaller than the local album (a one-track promo single sharing the album's title)
// cannot be the edition the files came from. Small local albums are left alone: they may be partial.
export function editionFitsLocal(trackCount: unknown, localTrackCount: unknown) {
  const local = Number(localTrackCount) || 0
  return local < 4 || (Number(trackCount) || 0) >= local * 0.5
}

// Bonus for a MusicBrainz release group whose primary type suits the number of local tracks, so a
// twelve-track album does not match the same-titled single and a two-track single does not match the album.
export function releaseGroupTypeFit(group: OpenJson, trackCount: unknown) {
  const local = Number(trackCount) || 0
  const type = String(group?.['primary-type'] || '').toLowerCase()
  if (!local || !type) return 0
  if (local >= 5) return type === 'album' ? 10 : type === 'single' ? -30 : 0
  if (local <= 3) return type === 'single' ? 10 : type === 'album' ? -10 : 0
  return 0
}

export function releaseTrackCount(release: OpenJson): number {
  return (Array.isArray(release?.media) ? release.media : []).reduce((sum: number, medium: OpenJson) => sum + (Number(medium?.['track-count']) || (Array.isArray(medium?.tracks) ? medium.tracks.length : 0)), 0)
}

export function mapReleaseTracklist(release: OpenJson, albumId: string, source: string, releaseGroupId: string | null = null): AlbumTracklist {
  const media: OpenJson[] = Array.isArray(release?.media) ? release.media : []
  const releaseArtist = completenessCredit(release?.['artist-credit'])
  const tracks = media.flatMap((medium, mediumIndex) => (Array.isArray(medium?.tracks) ? medium.tracks : []).map((track: OpenJson, trackIndex: number) => {
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
  })).filter((track: TracklistTrack) => track.title).slice(0, 500)
  const formats = [...new Set(media.map((medium) => String(medium?.format || '').trim()).filter(Boolean))]
  return {
    albumId, releaseId: release.id, releaseGroupId: release?.['release-group']?.id || releaseGroupId || null,
    title: String(release.title || ''), artist: releaseArtist || null, date: release.date || null, country: release.country || null,
    format: formats.join(' + ') || null, status: release.status || null, disambiguation: release.disambiguation || null,
    discCount: media.length, source, fetchedAt: new Date().toISOString(), tracks,
  }
}

// An unfinished release item (no title) queued for this album stands in for every track not queued on its own.
// Once it has imported, its tracks have their own items and anything it lacked shows as missing again.
export function matchRecoveryItems(tracks: TracklistTrack[], rows: CompletenessRecoveryRow[], albumId: string | null = null) {
  const matches: Record<string, { id: string; status: string }> = {}
  const release = albumId && (Array.isArray(rows) ? rows : []).find((value) => !value.title && !['recovered', 'needs-upgrade'].includes(value.status) && releaseAlbumId(value) === albumId)
  for (const track of Array.isArray(tracks) ? tracks : []) {
    const title = completenessText(track.title)
    const artist = completenessText(track.artist)
    const row = (Array.isArray(rows) ? rows : []).find((value) => track.recordingId && value.musicBrainzId === track.recordingId)
      || (Array.isArray(rows) ? rows : []).find((value) => completenessText(value.title) === title && completenessText(value.artist) === artist)
    const match = row || release
    if (match) matches[track.key] = { id: match.id, status: match.status }
  }
  return matches
}

function releaseAlbumId(row: CompletenessRecoveryRow) {
  try { return JSON.parse(row.sourceJson || 'null')?.albumId || null } catch { return null }
}


export async function selectTracklist(db: D1Database, albumId: string): Promise<CachedTracklist | null> {
  const row = await db.prepare('SELECT tracklist_json AS tracklistJson, editions_json AS editionsJson FROM release_tracklists WHERE album_id = ?').bind(albumId).first<{ tracklistJson: string; editionsJson: string | null }>()
  if (!row) return null
  try { return { tracklist: JSON.parse(row.tracklistJson), editions: row.editionsJson ? JSON.parse(row.editionsJson) : [] } } catch { return null }
}

async function fetchMusicBrainzRelease(id: unknown): Promise<OpenJson> {
  if (!isMusicBrainzId(id)) return null
  const url = new URL('https://musicbrainz.org/ws/2/release/' + id)
  url.searchParams.set('inc', 'recordings artist-credits isrcs release-groups')
  url.searchParams.set('fmt', 'json')
  const release = await musicBrainzJson(url)
  return release?.id ? release : null
}

async function releaseGroupEditions(releaseGroupId: unknown) {
  if (!isMusicBrainzId(releaseGroupId)) return []
  const browse = new URL('https://musicbrainz.org/ws/2/release')
  browse.searchParams.set('release-group', releaseGroupId)
  browse.searchParams.set('inc', 'media')
  browse.searchParams.set('limit', '100')
  browse.searchParams.set('fmt', 'json')
  return summariseReleaseEditions((await musicBrainzJson(browse))?.releases)
}

export async function resolveAlbumTracklist(db: D1Database, album: CompletenessAlbum, requestedReleaseId: string | null): Promise<CachedTracklist | null> {
  const local = album.localTrackCount
  let release: OpenJson = null
  let source = 'auto'
  if (requestedReleaseId) { release = await fetchMusicBrainzRelease(requestedReleaseId); source = 'manual' }
  let tagged: OpenJson = null
  if (!release && isMusicBrainzId(album.musicBrainzId)) {
    tagged = await fetchMusicBrainzRelease(album.musicBrainzId)
    if (tagged && editionFitsLocal(releaseTrackCount(tagged), local)) { release = tagged; source = 'tagged' }
  }
  let releaseGroupId = [release?.['release-group']?.id, tagged?.['release-group']?.id, (await selectRelease(db, album.albumId))?.musicBrainzId].find(isMusicBrainzId) || null
  if (!release && !releaseGroupId) releaseGroupId = (await lookupMusicBrainzReleaseGroup({ name: album.name, artist: album.artist, year: album.year, musicBrainzId: album.musicBrainzId, trackCount: local }))?.group?.id || null
  let editions = await releaseGroupEditions(releaseGroupId)
  if (!release) {
    let chosen = chooseReleaseEdition(editions, local)
    if (!chosen || !editionFitsLocal(chosen.trackCount, local)) {
      // The tagged or cached release group can be a same-titled single; search again by title, weighing the track count.
      const searchedId = (await lookupMusicBrainzReleaseGroup({ name: album.name, artist: album.artist, year: album.year, trackCount: local }))?.group?.id
      if (isMusicBrainzId(searchedId) && searchedId !== releaseGroupId) {
        const alternatives = await releaseGroupEditions(searchedId)
        const better = chooseReleaseEdition(alternatives, local)
        if (better && (!chosen || editionFitsLocal(better.trackCount, local))) { releaseGroupId = searchedId; editions = alternatives; chosen = better }
      }
    }
    if (chosen) release = await fetchMusicBrainzRelease(chosen.id)
  }
  if (!release && tagged) { release = tagged; source = 'tagged' }
  if (!release) return null
  const tracklist = { ...mapReleaseTracklist(release, album.albumId, source, releaseGroupId), localTrackCount: Number(local) || 0 }
  return tracklist.tracks.length ? { tracklist, editions } : null
}

async function completenessRecoveryRows(db: D1Database, username: string) {
  const rows = await db.prepare('SELECT id, artist, title, musicbrainz_id AS musicBrainzId, status, source_json AS sourceJson FROM recovery_items WHERE username = ?').bind(username).all<CompletenessRecoveryRow>()
  return rows.results || []
}

export async function handleCompletenessRequest(request: Request, env: Env, url: URL) {
  if (!url.pathname.startsWith('/api/album-completeness/')) return null
  if (!env?.TOMIFY_DB) return json({ error: 'completeness-store-unavailable' }, 503)
  const username = await authenticate(request, env)
  if (!username) return json({ error: 'unauthorized' }, 401)
  if (request.method !== 'POST') return json({ error: 'not-found' }, 404)
  // The MusicBrainz completeness check and its Recovery hand-off are administrator tools.
  if (!(await isNavidromeAdmin(request, username, env))) return json({ error: 'forbidden', message: 'Only a Navidrome administrator can check album completeness.' }, 403)
  const body: OpenJson = await request.json().catch(() => null)
  const db = env.TOMIFY_DB

  // Albums whose last check found fewer local tracks than MusicBrainz lists, most missing first.
  if (url.pathname === '/api/album-completeness/overview') {
    const rows = await db.prepare("SELECT album_id AS albumId, tracklist_json AS tracklistJson, fetched_at AS fetchedAt FROM release_tracklists WHERE album_id NOT LIKE 'recovery:%'").all<{ albumId: string; tracklistJson: string; fetchedAt: string }>()
    const recoveries = await completenessRecoveryRows(db, username)
    const albums = []
    for (const row of rows.results || []) {
      let tracklist: AlbumTracklist
      try { tracklist = JSON.parse(row.tracklistJson) } catch { continue }
      const total = Array.isArray(tracklist?.tracks) ? tracklist.tracks.length : 0
      const present = Math.min(total, Number(tracklist.localTrackCount) || 0)
      if (present >= total) continue
      albums.push({ albumId: row.albumId, title: tracklist.title, artist: tracklist.artist, total, present, queued: Math.min(total - present, Object.keys(matchRecoveryItems(tracklist.tracks, recoveries, row.albumId)).length), checkedAt: row.fetchedAt })
    }
    albums.sort((a, b) => (b.total - b.present) - (a.total - a.present) || String(a.artist).localeCompare(String(b.artist)))
    return json({ albums: albums.slice(0, 200) })
  }

  const albumId = typeof body?.albumId === 'string' ? body.albumId.trim().slice(0, 200) : ''
  if (!albumId) return json({ error: 'invalid-album' }, 400)

  if (url.pathname === '/api/album-completeness/tracklist') {
    let cached = await selectTracklist(db, albumId)
    const requestedReleaseId = isMusicBrainzId(body.releaseId) ? body.releaseId : body.force === true && cached?.tracklist?.source === 'manual' ? cached.tracklist.releaseId : null
    const localTrackCount = Number(body.localTrackCount) || 0
    // A cached automatic edition that is far smaller than the album (picked before edition fit was checked,
    // or before more tracks arrived) is resolved again, once per local track count.
    const misfit = cached && cached.tracklist.source !== 'manual' && !editionFitsLocal(cached.tracklist.tracks.length, localTrackCount) && cached.tracklist.localTrackCount !== localTrackCount
    if (!cached || misfit || body.force === true || (requestedReleaseId && requestedReleaseId !== cached.tracklist.releaseId)) {
      let resolved
      try { resolved = await resolveAlbumTracklist(db, { albumId, name: String(body.name || ''), artist: String(body.artist || ''), year: Number(body.year) || null, musicBrainzId: body.musicBrainzId, localTrackCount }, requestedReleaseId) }
      catch { return json({ error: 'musicbrainz-unavailable', message: 'MusicBrainz could not be reached. Try again shortly.' }, 502) }
      if (!resolved) return json({ error: 'tracklist-unavailable', message: 'MusicBrainz has no confident tracklist for this album.' }, 404)
      await db.prepare('INSERT INTO release_tracklists (album_id, release_id, release_group_id, source, tracklist_json, editions_json, fetched_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, ?) ON CONFLICT(album_id) DO UPDATE SET release_id = excluded.release_id, release_group_id = excluded.release_group_id, source = excluded.source, tracklist_json = excluded.tracklist_json, editions_json = excluded.editions_json, fetched_at = CURRENT_TIMESTAMP, updated_by = excluded.updated_by')
        .bind(albumId, resolved.tracklist.releaseId, resolved.tracklist.releaseGroupId, resolved.tracklist.source, JSON.stringify(resolved.tracklist), JSON.stringify(resolved.editions), username).run()
      cached = resolved
    }
    return json({ ...cached, recovery: matchRecoveryItems(cached.tracklist.tracks, await completenessRecoveryRows(db, username), albumId) })
  }

  if (url.pathname === '/api/album-completeness/recovery') {
    const cached = await selectTracklist(db, albumId)
    if (!cached) return json({ error: 'tracklist-required', message: 'Load the album tracklist before adding missing tracks.' }, 409)
    const keys = new Set((Array.isArray(body.trackKeys) ? body.trackKeys : []).filter((key: unknown) => typeof key === 'string').slice(0, 500))
    const wanted = cached.tracklist.tracks.filter((track) => keys.has(track.key))
    if (!wanted.length) return json({ error: 'invalid-tracks' }, 400)
    const recoveries = await completenessRecoveryRows(db, username)
    const existing = matchRecoveryItems(wanted, recoveries, albumId)
    // One release item: a single Usenet or torrent search for the album, imported against this tracklist.
    if (body.release === true) {
      const created = wanted.some((track) => !existing[track.key])
      if (created) {
        const source = { catalogueSource: 'musicbrainz', origin: 'album-completeness', albumId, releaseId: cached.tracklist.releaseId, releaseGroupId: cached.tracklist.releaseGroupId, releaseDate: cached.tracklist.date, trackKeys: wanted.map((track) => track.key) }
        await db.prepare("INSERT INTO recovery_items (id, username, artist, title, album, source_json, status) VALUES (?, ?, ?, '', ?, ?, 'missing')")
          .bind(crypto.randomUUID(), username, String(cached.tracklist.artist || 'Unknown Artist').slice(0, 240), cached.tracklist.title.slice(0, 240), JSON.stringify(source)).run()
      }
      return json({ created: created ? 1 : 0, existing: created ? 0 : wanted.length, recovery: matchRecoveryItems(cached.tracklist.tracks, await completenessRecoveryRows(db, username), albumId) }, created ? 201 : 200)
    }
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
    return json({ created: rows.length, existing: wanted.length - rows.length, recovery: matchRecoveryItems(cached.tracklist.tracks, await completenessRecoveryRows(db, username), albumId) }, rows.length ? 201 : 200)
  }

  return json({ error: 'not-found' }, 404)
}
