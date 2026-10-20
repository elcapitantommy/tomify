// New releases from the library's artists, found on MusicBrainz. Tomify's pages send the library's artist
// list (POST /api/new-releases/artists, at most daily per device); the daily cron then checks the artists
// checked longest ago and keeps their release groups from the last year, including announced ones.
import type { D1Database, ExecutionContext } from '@cloudflare/workers-types'
import type { Env } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'
import { musicBrainzJson, type OpenJson } from '../routes/recovery.ts'

export const NEW_RELEASE_WINDOW_DAYS = 365
export const ARTISTS_PER_RUN = 80
export const ARTISTS_PER_KICK = 5
export const MAX_ARTISTS = 3000
const DAY_MS = 86_400_000
const KEEP_TYPES = new Set(['album', 'ep', 'single'])
// Re-packages and spoken word are not what anyone means by "a new album".
const SKIP_SECONDARY = new Set(['compilation', 'dj-mix', 'mixtape/street', 'demo', 'interview', 'audiobook', 'audio drama', 'spokenword', 'field recording', 'remix'])
const NOT_AN_ARTIST = new Set(['variousartists', 'various', 'unknownartist', 'unknown', ''])
const MBID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface WantedArtist { key: string; name: string; musicBrainzId: string | null }
export interface FoundRelease { id: string; title: string; type: string; date: string }

// "The Beatles", "Beatles" and "Mötley Crüe"/"Motley Crue" are the same artist.
export function artistKey(name: string) {
  return String(name || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/&/g, 'and').replace(/^the\s+/, '').replace(/[^a-z0-9]+/g, '')
}

export function cleanArtists(body: OpenJson): WantedArtist[] {
  const list = Array.isArray(body?.artists) ? body.artists : []
  const byKey = new Map<string, WantedArtist>()
  for (const item of list) {
    const name = typeof item?.name === 'string' ? item.name.trim().slice(0, 200) : ''
    const key = artistKey(name)
    if (!name || NOT_AN_ARTIST.has(key) || byKey.has(key)) continue
    const mbid = typeof item?.musicBrainzId === 'string' && MBID.test(item.musicBrainzId) ? item.musicBrainzId.toLowerCase() : null
    byKey.set(key, { key, name, musicBrainzId: mbid })
    if (byKey.size >= MAX_ARTISTS) break
  }
  return [...byKey.values()]
}

// MusicBrainz dates can be "2026", "2026-11" or "2026-11-07". A partial date counts as its last day so a
// release from "2026" is not dropped as too old early in the year.
export function releaseDateEnd(date: string): number | null {
  const match = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(date || '')
  if (!match) return null
  const year = Number(match[1]), month = match[2] ? Number(match[2]) : 12
  const day = match[3] ? Number(match[3]) : new Date(Date.UTC(year, month, 0)).getUTCDate()
  return Date.UTC(year, month - 1, day)
}

export function recentReleases(groups: OpenJson[], now: number, windowDays = NEW_RELEASE_WINDOW_DAYS): FoundRelease[] {
  const since = now - windowDays * DAY_MS
  return (Array.isArray(groups) ? groups : []).flatMap((group) => {
    const type = String(group?.['primary-type'] || '').toLowerCase()
    const secondary = (Array.isArray(group?.['secondary-types']) ? group['secondary-types'] : []).map((item: unknown) => String(item).toLowerCase())
    const date = String(group?.['first-release-date'] || '')
    const end = releaseDateEnd(date)
    if (!group?.id || !group?.title || !KEEP_TYPES.has(type) || secondary.some((item: string) => SKIP_SECONDARY.has(item)) || end === null || end < since) return []
    return [{ id: String(group.id), title: String(group.title).slice(0, 300), type, date }]
  })
}

// Only a confident, same-name match: a wrong artist would fill Home with someone else's records.
export function pickArtist(search: OpenJson, name: string): string | null {
  const wanted = artistKey(name)
  const match = (Array.isArray(search?.artists) ? search.artists : []).find((artist: OpenJson) => Number(artist?.score || 0) >= 95 && artistKey(artist?.name) === wanted)
  return match?.id && MBID.test(match.id) ? match.id : null
}

type MusicBrainz = (url: URL) => Promise<OpenJson>

export async function checkArtist(db: D1Database, artist: { key: string; name: string; musicBrainzId: string | null }, now: number, mb: MusicBrainz = musicBrainzJson) {
  let mbid = artist.musicBrainzId
  if (!mbid) {
    const search = new URL('https://musicbrainz.org/ws/2/artist/')
    search.searchParams.set('query', 'artist:"' + artist.name.replace(/"/g, '') + '"')
    search.searchParams.set('limit', '5')
    search.searchParams.set('fmt', 'json')
    mbid = pickArtist(await mb(search), artist.name)
  }
  let found: FoundRelease[] = []
  if (mbid) {
    const browse = new URL('https://musicbrainz.org/ws/2/release-group')
    browse.searchParams.set('artist', mbid)
    browse.searchParams.set('type', 'album|ep|single')
    browse.searchParams.set('limit', '100')
    browse.searchParams.set('fmt', 'json')
    const result = await mb(browse)
    // MusicBrainz being down is not "no releases": leave the artist to be checked again next time.
    if (!result) return null
    found = recentReleases(result['release-groups'], now)
  }
  const statements = [db.prepare('UPDATE new_release_artists SET musicbrainz_id = ?, checked_at = ? WHERE artist_key = ?').bind(mbid, now, artist.key)]
  for (const release of found) statements.push(db.prepare('INSERT INTO new_releases (release_group_id, artist_key, artist_name, title, release_type, release_date, found_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(release_group_id) DO UPDATE SET title = excluded.title, release_type = excluded.release_type, release_date = excluded.release_date').bind(release.id, artist.key, artist.name, release.title, release.type, release.date, now))
  await db.batch(statements)
  return found
}

export async function checkNewReleases(env: Pick<Env, 'TOMIFY_DB'>, limit = ARTISTS_PER_RUN, now = Date.now(), mb: MusicBrainz = musicBrainzJson) {
  const db = env.TOMIFY_DB
  if (!db) return 0
  const due = await db.prepare('SELECT artist_key AS key, name, musicbrainz_id AS musicBrainzId FROM new_release_artists ORDER BY checked_at IS NOT NULL, checked_at LIMIT ?').bind(limit).all<{ key: string; name: string; musicBrainzId: string | null }>()
  let checked = 0
  for (const artist of due.results || []) {
    try { if (await checkArtist(db, artist, now, mb)) checked += 1 } catch (error) { console.warn('New release check failed', artist.name, error instanceof Error ? error.message : error) }
  }
  // Releases fall out once they are over a year old.
  await db.prepare('DELETE FROM new_releases WHERE found_at < ? AND release_date < ?').bind(now - NEW_RELEASE_WINDOW_DAYS * DAY_MS, new Date(now - NEW_RELEASE_WINDOW_DAYS * DAY_MS).toISOString().slice(0, 10)).run()
  return checked
}

export async function handleNewReleasesRequest(request: Request, env: Env, url: URL, ctx?: Pick<ExecutionContext, 'waitUntil'>): Promise<Response | null> {
  if (url.pathname !== '/api/new-releases' && url.pathname !== '/api/new-releases/artists') return null
  if (!env?.TOMIFY_DB) return json({ error: 'new-releases-unavailable' }, 503)
  if (!(await authenticate(request, env))) return json({ error: 'unauthorized' }, 401)
  const db = env.TOMIFY_DB

  if (url.pathname === '/api/new-releases' && request.method === 'GET') {
    const days = Math.min(NEW_RELEASE_WINDOW_DAYS, Math.max(1, Number(url.searchParams.get('days')) || 120))
    const since = new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10)
    const rows = await db.prepare('SELECT release_group_id AS id, artist_name AS artist, title, release_type AS type, release_date AS date FROM new_releases WHERE release_date >= ? ORDER BY release_date DESC LIMIT 200').bind(since).all()
    const counts = await db.prepare('SELECT COUNT(*) AS artists, COUNT(checked_at) AS checked FROM new_release_artists').first<{ artists: number; checked: number }>()
    return json({ releases: rows.results || [], artists: Number(counts?.artists || 0), checked: Number(counts?.checked || 0) })
  }

  if (url.pathname === '/api/new-releases/artists' && request.method === 'POST') {
    const artists = cleanArtists(await request.json().catch(() => null))
    if (!artists.length) return json({ error: 'no-artists' }, 400)
    const now = Date.now()
    for (let index = 0; index < artists.length; index += 50) {
      await db.batch(artists.slice(index, index + 50).map((artist) => db.prepare('INSERT INTO new_release_artists (artist_key, name, musicbrainz_id, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(artist_key) DO UPDATE SET name = excluded.name, musicbrainz_id = COALESCE(excluded.musicbrainz_id, new_release_artists.musicbrainz_id), updated_at = excluded.updated_at').bind(artist.key, artist.name, artist.musicBrainzId, now)))
    }
    // Artists that have left the library stop being checked, and their releases go with them.
    const stale = now - 60 * DAY_MS
    await db.batch([
      db.prepare('DELETE FROM new_releases WHERE artist_key IN (SELECT artist_key FROM new_release_artists WHERE updated_at < ?)').bind(stale),
      db.prepare('DELETE FROM new_release_artists WHERE updated_at < ?').bind(stale),
    ])
    // A first look at a few never-checked artists, so the list starts filling before the nightly run.
    ctx?.waitUntil(checkNewReleases(env, ARTISTS_PER_KICK).catch(() => 0))
    return json({ artists: artists.length })
  }
  return json({ error: 'method-not-allowed' }, 405)
}
