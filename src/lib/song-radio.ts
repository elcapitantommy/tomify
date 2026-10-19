import type { Track } from '../types'

// Song radio: from one song, an endless queue of songs like it from the library. Songs are scored against the
// seed by Navidrome's similar-artist songs, shared genres and moods, a close tempo (half and double time count),
// the same artist and a similar year, with a little randomness so each radio is different.

export const RADIO_BATCH = 15
// Variety, as in the DJ: at most this many songs per artist in the recent queue, and never one artist twice running.
export const RADIO_ARTIST_CAP = 3
const RECENT_WINDOW = 60

const key = (value?: string) => (value ?? '').trim().toLowerCase()
const artistKey = (track: Track) => key(track.artist)

export function styleOf(track: Track) {
  const genres = new Set([...(track.genres ?? []).map((genre) => key(genre.name)), ...(track.genre ?? '').split(/[;,/]/).map(key)].filter(Boolean))
  return { genres, moods: new Set((track.moods ?? []).map(key).filter(Boolean)) }
}

// 1 for the same tempo, falling to 0 at 24 bpm apart; null when either is unknown.
export function tempoCloseness(left?: number, right?: number) {
  if (!left || !right) return null
  const apart = Math.min(...[1, 2, 0.5].map((scale) => Math.abs(left - right * scale)))
  return Math.max(0, 1 - apart / 24)
}

const shared = (left: Set<string>, right: Set<string>) => [...left].filter((item) => right.has(item)).length

export function radioScore(seed: Track, candidate: Track, similarRank: Map<string, number>) {
  let score = 0
  const rank = similarRank.get(candidate.id)
  if (rank !== undefined) score += 1 + 3 * (1 - rank / (similarRank.size + 1))
  const a = styleOf(seed), b = styleOf(candidate)
  score += 2 * Math.min(2, shared(a.genres, b.genres))
  score += 1.25 * Math.min(2, shared(a.moods, b.moods))
  score += 1.5 * (tempoCloseness(seed.bpm, candidate.bpm) ?? 0)
  if (artistKey(seed) && artistKey(seed) === artistKey(candidate)) score += 1.5
  if (seed.year && candidate.year) score += Math.abs(seed.year - candidate.year) <= 3 ? 0.75 : Math.abs(seed.year - candidate.year) <= 10 ? 0.35 : 0
  return score
}

// The next `count` songs after `queue` (everything the radio has queued so far, seed first).
export function pickRadio(seed: Track, queue: Track[], library: Track[], similar: Track[], count = RADIO_BATCH, random = Math.random): Track[] {
  const similarRank = new Map(similar.map((track, index) => [track.id, index]))
  const songKey = (track: Track) => `${artistKey(track)}|${key(track.title)}`
  const queued = new Set(queue.flatMap((track) => [track.id, songKey(track)]))
  const seen = new Set<string>()
  const pool = [...similar, ...library].filter((track) => {
    // One copy of each song: other editions of it on other albums count as the same song.
    const id = songKey(track)
    if (seen.has(track.id) || seen.has(id)) return false
    seen.add(track.id); seen.add(id)
    return true
  })
  const unplayed = pool.filter((track) => !queued.has(track.id) && !queued.has(songKey(track)))
  // A small library runs out: then anything not in the recent queue can come round again.
  const recent = new Set(queue.slice(-RECENT_WINDOW).flatMap((track) => [track.id, songKey(track)]))
  const candidates = unplayed.length >= count ? unplayed : pool.filter((track) => !recent.has(track.id) && !recent.has(songKey(track)))
  const ranked = candidates.map((track) => ({ track, score: radioScore(seed, track, similarRank) + random() * 0.75 })).sort((x, y) => y.score - x.score)

  const counts = new Map<string, number>()
  for (const track of queue.slice(-RECENT_WINDOW)) counts.set(artistKey(track), (counts.get(artistKey(track)) ?? 0) + 1)
  let last = queue.length ? artistKey(queue[queue.length - 1]) : ''
  const picks: Track[] = []
  // Each pick is the best song left from an artist not just played and under the cap; the cap only gives way
  // when nothing else is left.
  const eligible = (track: Track, capped: boolean) => !picks.includes(track) && artistKey(track) !== last && (!capped || (counts.get(artistKey(track)) ?? 0) < RADIO_ARTIST_CAP)
  while (picks.length < count) {
    const next = ranked.find(({ track }) => eligible(track, true)) ?? ranked.find(({ track }) => eligible(track, false))
    if (!next) break
    const artist = artistKey(next.track)
    picks.push(next.track)
    counts.set(artist, (counts.get(artist) ?? 0) + 1)
    last = artist
  }
  return picks
}
