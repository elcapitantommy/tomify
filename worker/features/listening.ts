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
  }
}

export async function recordListening(env: Env, username: string, events: ListeningEvent[], now: number) {
  const db = env.TOMIFY_DB
  const statements = events.map((event) => db.prepare('INSERT INTO listening_events (username, track_id, album_id, artist_id, title, artist, album, duration_seconds, listened_seconds, completed, skipped, played_at, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(username, event.trackId, event.albumId, event.artistId, event.title, event.artist, event.album, event.durationSeconds, event.listenedSeconds, event.completed ? 1 : 0, event.skipped ? 1 : 0, event.playedAt, event.device))
  statements.push(db.prepare('DELETE FROM listening_events WHERE username = ? AND played_at < ?').bind(username, now - LISTENING_RETENTION_MS))
  await db.batch(statements)
}

interface StatsTotals { plays: number; skips: number; seconds: number }
interface TopRow { plays: number; seconds: number; [key: string]: string | number | null }

// Totals and the most played artists, albums and tracks over the last `days` days.
export async function listeningSummary(env: Env, username: string, days: number, now: number) {
  const db = env.TOMIFY_DB
  const since = now - days * 24 * 60 * 60 * 1000
  const top = async (columns: string, group: string) => (await db.prepare(`SELECT ${columns}, COUNT(*) AS plays, SUM(listened_seconds) AS seconds FROM listening_events WHERE username = ? AND played_at >= ? AND skipped = 0 AND ${group} IS NOT NULL GROUP BY ${group} ORDER BY plays DESC, seconds DESC LIMIT 10`).bind(username, since).all<TopRow>()).results || []
  const [totals, artists, albums, tracks] = await Promise.all([
    db.prepare('SELECT COUNT(*) AS plays, COALESCE(SUM(skipped), 0) AS skips, COALESCE(SUM(listened_seconds), 0) AS seconds FROM listening_events WHERE username = ? AND played_at >= ?').bind(username, since).first<StatsTotals>(),
    top('MAX(artist_id) AS artistId, artist', 'artist'),
    top('album_id AS albumId, MAX(album) AS album, MAX(artist) AS artist', 'album_id'),
    top('track_id AS trackId, MAX(title) AS title, MAX(artist) AS artist, MAX(album_id) AS albumId', 'track_id'),
  ])
  return { days, plays: 0, skips: 0, seconds: 0, ...totals, artists, albums, tracks }
}

export const handleListeningRequest: RouteHandler = async (request, env, url) => {
  if (url.pathname === '/api/listening/stats') {
    if (!env?.TOMIFY_DB) return json({ error: 'listening-store-unavailable' }, 503)
    const signedIn = await authenticate(request, env)
    if (!signedIn) return json({ error: 'unauthorized' }, 401)
    const days = Math.min(400, Math.max(1, Number(url.searchParams.get('days')) || 30))
    return json(await listeningSummary(env, signedIn.toLowerCase(), days, Date.now()))
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
