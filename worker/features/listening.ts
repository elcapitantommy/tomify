// Listening history: the player reports each track it played (how long, whether it finished or was skipped),
// so mixes can tell what you have on repeat, what you skip and what you haven't played in a long time.
import type { Env, RouteHandler } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

const MAX_EVENTS_PER_REQUEST = 50
// Plays older than this are pruned when new ones arrive, so the table stays small.
export const LISTENING_RETENTION_MS = 400 * 24 * 60 * 60 * 1000

export interface ListeningEvent {
  trackId: string
  albumId: string | null
  artistId: string | null
  title: string | null
  artist: string | null
  album: string | null
  durationSeconds: number | null
  listenedSeconds: number
  completed: boolean
  skipped: boolean
  playedAt: number
  device: string | null
  genre: string | null
}

const text = (value: unknown, max = 300) => typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null
const seconds = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(Math.min(value, 24 * 60 * 60)) : null

export function cleanListeningEvent(value: unknown, now: number): ListeningEvent | null {
  if (!value || typeof value !== 'object') return null
  const input = value as Record<string, unknown>
  const trackId = text(input.trackId, 128)
  const listenedSeconds = seconds(input.listenedSeconds)
  if (!trackId || listenedSeconds === null || listenedSeconds < 1) return null
  const playedAt = typeof input.playedAt === 'number' && Number.isFinite(input.playedAt) && input.playedAt <= now + 60_000 && input.playedAt > now - 30 * 24 * 60 * 60 * 1000 ? Math.round(input.playedAt) : now
  const completed = input.completed === true
  return {
    trackId,
    albumId: text(input.albumId, 128),
    artistId: text(input.artistId, 128),
    title: text(input.title),
    artist: text(input.artist),
    album: text(input.album),
    durationSeconds: seconds(input.durationSeconds),
    listenedSeconds,
    completed,
    skipped: !completed && input.skipped === true,
    playedAt,
    device: text(input.device, 64),
    genre: text(input.genre, 100),
  }
}

export async function recordListening(env: Env, username: string, events: ListeningEvent[], now: number) {
  const db = env.TOMIFY_DB
  const cutoff = now - LISTENING_RETENTION_MS
  // Save a year's Wrapped before any of its plays are pruned. The first prune that reaches a year happens while
  // all of it is still stored, because nothing older than the previous cutoff has been deleted.
  const oldest = await db.prepare('SELECT MIN(played_at) AS oldest FROM listening_events WHERE username = ? AND played_at < ?').bind(username, cutoff).first<{ oldest: number | null }>()
  if (oldest?.oldest != null) {
    for (let year = new Date(oldest.oldest).getUTCFullYear(); year <= new Date(cutoff).getUTCFullYear(); year += 1) {
      if (await storedYear(env, username, year)) continue
      const wrapped = await buildWrapped(env, username, year)
      if (wrapped.plays) await db.prepare('INSERT OR IGNORE INTO listening_years (username, year, summary_json, created_at) VALUES (?, ?, ?, ?)').bind(username, year, JSON.stringify(wrapped), now).run()
    }
  }
  const statements = events.map((event) => db.prepare('INSERT INTO listening_events (username, track_id, album_id, artist_id, title, artist, album, duration_seconds, listened_seconds, completed, skipped, played_at, device, genre) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(username, event.trackId, event.albumId, event.artistId, event.title, event.artist, event.album, event.durationSeconds, event.listenedSeconds, event.completed ? 1 : 0, event.skipped ? 1 : 0, event.playedAt, event.device, event.genre))
  statements.push(db.prepare('DELETE FROM listening_events WHERE username = ? AND played_at < ?').bind(username, cutoff))
  await db.batch(statements)
}

interface StatsTotals { plays: number; skips: number; seconds: number }
interface TopRow { plays: number; seconds: number; [key: string]: string | number | null }
type Range = [from: number, to: number]
const DAY_MS = 24 * 60 * 60 * 1000
// Wrapped years and months use UTC, which is UK time all winter (so the year boundary matches).
const yearRange = (year: number): Range => [Date.UTC(year, 0, 1), Date.UTC(year + 1, 0, 1)]
const WHERE = 'username = ? AND played_at >= ? AND played_at < ?'

// Totals and the most played artists, albums, tracks and genres between `from` (inclusive) and `to`.
async function summaryBetween(env: Env, username: string, [from, to]: Range, limit: number) {
  const db = env.TOMIFY_DB
  const top = async (columns: string, group: string) => (await db.prepare(`SELECT ${columns}, COUNT(*) AS plays, SUM(listened_seconds) AS seconds FROM listening_events WHERE ${WHERE} AND skipped = 0 AND ${group} IS NOT NULL GROUP BY ${group} ORDER BY plays DESC, seconds DESC LIMIT ${limit}`).bind(username, from, to).all<TopRow>()).results || []
  const [totals, artists, albums, tracks, genres] = await Promise.all([
    db.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(skipped), 0) AS skips, COALESCE(SUM(listened_seconds), 0) AS seconds FROM listening_events WHERE ${WHERE}`).bind(username, from, to).first<StatsTotals>(),
    top('MAX(artist_id) AS artistId, artist', 'artist'),
    top('album_id AS albumId, MAX(album) AS album, MAX(artist) AS artist, MAX(artist_id) AS artistId', 'album_id'),
    top('track_id AS trackId, MAX(title) AS title, MAX(artist) AS artist, MAX(artist_id) AS artistId, MAX(album_id) AS albumId', 'track_id'),
    top('MAX(genre) AS genre', 'LOWER(genre)'),
  ])
  return { plays: 0, skips: 0, seconds: 0, ...totals, artists, albums, tracks, genres }
}

// Rolling windows (`days`) or calendar periods (`from`/`to`, which the app works out in local time).
export async function listeningSummary(env: Env, username: string, days: number, now: number, range?: Range) {
  return { days: range ? null : days, from: range?.[0] ?? now - days * DAY_MS, to: range?.[1] ?? now, ...await summaryBetween(env, username, range ?? [now - days * DAY_MS, now + DAY_MS], 10) }
}

// The years Wrapped can show: any with plays still stored, or a saved recap.
export async function listeningYears(env: Env, username: string) {
  const db = env.TOMIFY_DB
  const [span, saved] = await Promise.all([
    db.prepare('SELECT MIN(played_at) AS first, MAX(played_at) AS last FROM listening_events WHERE username = ?').bind(username).first<{ first: number | null; last: number | null }>(),
    db.prepare('SELECT year FROM listening_years WHERE username = ?').bind(username).all<{ year: number }>(),
  ])
  const years = new Set((saved.results || []).map((row) => row.year))
  if (span?.first != null && span.last != null) for (let year = new Date(span.first).getUTCFullYear(); year <= new Date(span.last).getUTCFullYear(); year += 1) years.add(year)
  return [...years].sort((a, b) => b - a)
}

const storedYear = async (env: Env, username: string, year: number) => {
  const row = await env.TOMIFY_DB.prepare('SELECT summary_json AS summaryJson FROM listening_years WHERE username = ? AND year = ?').bind(username, year).first<{ summaryJson: string }>()
  try { return row ? JSON.parse(row.summaryJson) as Awaited<ReturnType<typeof buildWrapped>> : null } catch { return null }
}

// A year in review: top 5s, minutes by month, the first song of the year, the song most played in one day,
// artists first played this year, and the 50 most played tracks for a "Your year" playlist.
export async function buildWrapped(env: Env, username: string, year: number) {
  const db = env.TOMIFY_DB
  const range = yearRange(year)
  const rows = async (sql: string, ...extra: unknown[]) => (await db.prepare(sql).bind(username, ...range, ...extra).all<TopRow>()).results || []
  const played = `FROM listening_events WHERE ${WHERE} AND skipped = 0`
  const [summary, months, [firstTrack = null], [repeated = null], newArtists, playlist] = await Promise.all([
    summaryBetween(env, username, range, 5),
    rows(`SELECT CAST(strftime('%m', played_at / 1000, 'unixepoch') AS INTEGER) AS month, COUNT(*) AS plays, SUM(listened_seconds) AS seconds FROM listening_events WHERE ${WHERE} GROUP BY month ORDER BY month`),
    rows(`SELECT track_id AS trackId, title, artist, artist_id AS artistId, album_id AS albumId, played_at AS playedAt ${played} ORDER BY played_at LIMIT 1`),
    rows(`SELECT track_id AS trackId, MAX(title) AS title, MAX(artist) AS artist, MAX(artist_id) AS artistId, MAX(album_id) AS albumId, date(played_at / 1000, 'unixepoch') AS day, COUNT(*) AS plays ${played} GROUP BY track_id, day ORDER BY plays DESC, day LIMIT 1`),
    rows(`SELECT MAX(artist_id) AS artistId, artist, COUNT(*) AS plays ${played} AND artist IS NOT NULL AND artist NOT IN (SELECT artist FROM listening_events WHERE username = ? AND played_at < ? AND artist IS NOT NULL) GROUP BY artist ORDER BY plays DESC`, username, range[0]),
    rows(`SELECT track_id AS trackId ${played} GROUP BY track_id ORDER BY COUNT(*) DESC, SUM(listened_seconds) DESC LIMIT 50`),
  ])
  return { year, ...summary, months, firstTrack, mostRepeated: repeated, newArtistCount: newArtists.length, newArtists: newArtists.slice(0, 5), playlist: playlist.map((row) => row.trackId) }
}

// A saved recap if there is one (its plays may be pruned), otherwise worked out from the stored plays,
// with the year before's totals for comparison.
export async function wrappedYear(env: Env, username: string, year: number) {
  const wrapped = await storedYear(env, username, year) ?? await buildWrapped(env, username, year)
  const before = await storedYear(env, username, year - 1) ?? await env.TOMIFY_DB.prepare(`SELECT COUNT(*) AS plays, COALESCE(SUM(listened_seconds), 0) AS seconds FROM listening_events WHERE ${WHERE}`).bind(username, ...yearRange(year - 1)).first<StatsTotals>()
  return { ...wrapped, previous: before?.plays ? { year: year - 1, plays: before.plays, seconds: before.seconds } : null }
}

export const handleListeningRequest: RouteHandler = async (request, env, url) => {
  if (url.pathname === '/api/listening/stats') {
    if (!env?.TOMIFY_DB) return json({ error: 'listening-store-unavailable' }, 503)
    const signedIn = await authenticate(request, env)
    if (!signedIn) return json({ error: 'unauthorized' }, 401)
    const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 30))
    const from = Number(url.searchParams.get('from')), to = Number(url.searchParams.get('to'))
    const username = signedIn.toLowerCase()
    const [summary, years] = await Promise.all([listeningSummary(env, username, days, Date.now(), from > 0 && to > from ? [from, to] : undefined), listeningYears(env, username)])
    return json({ ...summary, years })
  }
  if (url.pathname === '/api/listening/wrapped') {
    if (!env?.TOMIFY_DB) return json({ error: 'listening-store-unavailable' }, 503)
    const signedIn = await authenticate(request, env)
    if (!signedIn) return json({ error: 'unauthorized' }, 401)
    const year = Number(url.searchParams.get('year'))
    if (!Number.isInteger(year) || year < 2000 || year > new Date().getUTCFullYear()) return json({ error: 'invalid-year' }, 400)
    return json(await wrappedYear(env, signedIn.toLowerCase(), year))
  }
  if (url.pathname !== '/api/listening') return null
  if (request.method !== 'POST') return json({ error: 'method-not-allowed' }, 405)
  if (!env?.TOMIFY_DB) return json({ error: 'listening-store-unavailable' }, 503)
  const signedIn = await authenticate(request, env)
  if (!signedIn) return json({ error: 'unauthorized' }, 401)
  const username = signedIn.toLowerCase()
  const body = await request.json().catch(() => null) as { events?: unknown } | null
  if (!body || !Array.isArray(body.events)) return json({ error: 'invalid-listening-events' }, 400)
  const now = Date.now()
  const events = body.events.slice(0, MAX_EVENTS_PER_REQUEST).map((event) => cleanListeningEvent(event, now)).filter((event): event is ListeningEvent => event !== null)
  if (events.length) await recordListening(env, username, events, now)
  return json({ recorded: events.length })
}
