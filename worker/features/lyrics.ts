// Lyrics for songs Navidrome has none for, from LRCLIB (lrclib.net). Each answer is saved in D1, misses too, so a
// song is only looked up once for every device; a miss is looked up again after a month.
import type { Env } from '../env.ts'
import { authenticate } from '../lib/auth.ts'
import { json } from '../lib/http.ts'

export const LYRICS_MISS_RETRY_MS = 30 * 86_400_000
interface Found { syncedLyrics?: string | null; plainLyrics?: string | null; duration?: number }

// A search rather than LRCLIB's exact lookup, which wants the same album and finds no singles or other editions.
async function lookup(artist: string, title: string, duration: number): Promise<Found | undefined> {
  const response = await fetch(`https://lrclib.net/api/search?${new URLSearchParams({ artist_name: artist, track_name: title })}`, { headers: { 'user-agent': 'Tomify' } })
  if (!response.ok) throw new Error()
  const close = (await response.json() as Found[]).filter((item) => !duration || Math.abs((item.duration ?? 0) - duration) <= 3)
  return close.find((item) => item.syncedLyrics) ?? close.find((item) => item.plainLyrics)
}

export async function handleLyricsRequest(request: Request, env: Env, url: URL): Promise<Response | null> {
  if (url.pathname !== '/api/lyrics') return null
  if (!(await authenticate(request, env))) return json({ error: 'unauthorized' }, 401)
  const param = (name: string) => (url.searchParams.get(name) ?? '').trim().slice(0, 300)
  const id = param('id'), artist = param('artist'), title = param('title')
  if (!id || !artist || !title) return json({ error: 'missing-song' }, 400)
  const db = env.TOMIFY_DB
  const saved = await db.prepare('SELECT * FROM lyrics WHERE song_id = ?').bind(id).first<{ synced: string | null; plain: string | null; checked_at: number }>()
  if (saved && (saved.synced || saved.plain || Date.now() - saved.checked_at < LYRICS_MISS_RETRY_MS)) return json({ synced: saved.synced, plain: saved.plain })
  let found: Found | undefined
  // LRCLIB being down is not a miss, so nothing is saved.
  try { found = await lookup(artist, title, Math.round(Number(param('duration'))) || 0) } catch { return json({ error: 'lyrics-unavailable' }, 502) }
  const synced = found?.syncedLyrics?.trim() || null, plain = found?.plainLyrics?.trim() || null
  await db.prepare('INSERT OR REPLACE INTO lyrics VALUES (?, ?, ?, ?)').bind(id, synced, plain, Date.now()).run()
  return json({ synced, plain })
}
