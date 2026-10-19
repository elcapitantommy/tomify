import type { Track } from '../types'
import type { NavidromeClient } from './navidrome'
import { useAuth } from '../stores/auth'

export interface LyricLine { time: number; text: string }
// `lines` have times when the lyrics are synced; plain lyrics have every time at -1.
export interface Lyrics { synced: boolean; lines: LyricLine[] }

const STAMP = /\[(\d+):(\d{1,2}(?:[.:]\d{1,3})?)\]/g

// LRC: "[01:02.34]words", several stamps may share one line. Tag lines ([ar:...], [offset:...]) are skipped,
// except the offset, which shifts every line (positive is earlier, as in the LRC format).
export function parseLrc(text: string): LyricLine[] {
  const offset = Number(text.match(/\[offset:\s*([+-]?\d+)\]/i)?.[1] ?? 0) / 1000
  const lines: LyricLine[] = []
  for (const raw of text.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(STAMP)]
    if (!stamps.length) continue
    const words = raw.replace(STAMP, '').trim()
    for (const [, minutes, seconds] of stamps) lines.push({ time: Math.max(0, Number(minutes) * 60 + Number(seconds.replace(':', '.')) - offset), text: words })
  }
  return lines.sort((a, b) => a.time - b.time)
}

export function plainLines(text: string): LyricLine[] {
  return text.split(/\r?\n/).map((line) => ({ time: -1, text: line.trim() }))
}

// The line being sung at `time`: the last one that has started, or -1 before the first.
export function activeLine(lines: LyricLine[], time: number) {
  let low = 0, high = lines.length - 1, found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if (lines[middle].time <= time) { found = middle; low = middle + 1 } else high = middle - 1
  }
  return found
}

interface SavedLyrics { synced: string | null; plain: string | null }

export function lyricsFrom(saved: SavedLyrics): Lyrics | null {
  const synced = saved.synced ? parseLrc(saved.synced) : []
  if (synced.length) return { synced: true, lines: synced }
  return saved.plain ? { synced: false, lines: plainLines(saved.plain) } : null
}

async function fromLrclib(track: Track, signal?: AbortSignal): Promise<Lyrics | null> {
  const session = useAuth.getState().session
  if (!session) return null
  const params = new URLSearchParams({ id: track.id, artist: track.artist, title: track.title, duration: String(Math.round(track.duration ?? 0)) })
  const response = await fetch(`/api/lyrics?${params}`, { signal, headers: { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt } })
  if (!response.ok) throw new Error('Lyrics are unavailable right now.')
  return lyricsFrom(await response.json() as SavedLyrics)
}

const cache = new Map<string, Lyrics | null>()

// Lyrics Navidrome already has (tags or .lrc files beside the music) come first; LRCLIB, through the Worker, fills
// in the rest. Answers are kept for the session, misses included.
export async function loadLyrics(api: NavidromeClient, track: Track, signal?: AbortSignal): Promise<Lyrics | null> {
  if (cache.has(track.id)) return cache.get(track.id)!
  const own = await api.lyrics(track.id, signal).catch((error) => { if (signal?.aborted) throw error; return null })
  const lyrics = own ?? await fromLrclib(track, signal)
  cache.set(track.id, lyrics)
  return lyrics
}
