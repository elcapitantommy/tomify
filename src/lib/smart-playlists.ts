import type { NavidromeClient } from './navidrome'
import type { Track } from '../types'
import { useAuth } from '../stores/auth'

// A smart playlist is a saved set of rules. Tracks are picked in the browser from the whole library each time it
// opens, using what Navidrome knows about each song (genre, mood, tempo, year, favourite, rating, play count, last
// played, added). The same rules can feed the DJ and song radio (see radioPool / djPool below).
export type SmartSort = 'random' | 'most-played' | 'least-played' | 'recently-added' | 'recently-played' | 'newest' | 'oldest'
export type PlayedRule = 'any' | 'never' | 'within' | 'not-within'
export interface SmartRules {
  genres?: string[]
  // Moods from the MOOD tag the agent writes (recovery-agent/track-style.mjs). M4A files have none.
  moods?: string[]
  // Tempo from the BPM tag; songs without one never match a tempo rule.
  bpmFrom?: number
  bpmTo?: number
  artist?: string
  yearFrom?: number
  yearTo?: number
  favouritesOnly?: boolean
  minRating?: number
  minPlays?: number
  played?: PlayedRule
  playedDays?: number
  addedDays?: number
  // Added on or after this calendar day (YYYY-MM-DD), for "added this year" and the like.
  addedFrom?: string
  sort?: SmartSort
  limit?: number
}
export interface SmartPlaylist { id: string; name: string; rules: SmartRules; updatedAt: string }

export const DEFAULT_LIMIT = 100
export const MAX_LIMIT = 1000
const DAY_MS = 24 * 60 * 60 * 1000

const lower = (value?: string) => (value ?? '').trim().toLocaleLowerCase('en')
const time = (value?: string) => { const parsed = value ? Date.parse(value) : NaN; return Number.isFinite(parsed) ? parsed : 0 }
// A seeded shuffle, so the same random playlist keeps its order until it is reopened with a new seed.
function shuffle<T>(items: T[], seed: number) {
  let state = seed >>> 0 || 1
  const next = () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32 }
  for (let index = items.length - 1; index > 0; index -= 1) { const swap = Math.floor(next() * (index + 1)); [items[index], items[swap]] = [items[swap], items[index]] }
  return items
}

// Midnight at the start of a YYYY-MM-DD day, in the listener's own time zone.
function startOfDay(day: string) {
  const [year, month, date] = day.split('-').map(Number)
  return year && month && date ? new Date(year, month - 1, date).getTime() : 0
}

export function matchesRules(track: Track, rules: SmartRules, now: number) {
  const genres = (rules.genres ?? []).map(lower).filter(Boolean)
  if (genres.length) {
    // Navidrome gives one genre string ("Rock; Jazz") and, for multi-valued tags, a list as well.
    const own = new Set([...lower(track.genre).split(/\s*[;/,]\s*/), ...(track.genres ?? []).map((genre) => lower(genre.name))])
    if (!genres.some((genre) => own.has(genre))) return false
  }
  const moods = (rules.moods ?? []).map(lower).filter(Boolean)
  if (moods.length) {
    const own = new Set((track.moods ?? []).map(lower))
    if (!moods.some((mood) => own.has(mood))) return false
  }
  if ((rules.bpmFrom || rules.bpmTo) && !(track.bpm && track.bpm >= (rules.bpmFrom ?? 0) && track.bpm <= (rules.bpmTo ?? Infinity))) return false
  if (rules.artist && !lower(track.artist).includes(lower(rules.artist))) return false
  if (rules.yearFrom && !(track.year && track.year >= rules.yearFrom)) return false
  if (rules.yearTo && !(track.year && track.year <= rules.yearTo)) return false
  if (rules.favouritesOnly && !track.starred) return false
  if (rules.minRating && (track.userRating ?? 0) < rules.minRating) return false
  if (rules.minPlays && (track.playCount ?? 0) < rules.minPlays) return false
  const lastPlayed = time(track.played)
  const days = Math.max(1, rules.playedDays ?? 30) * DAY_MS
  if (rules.played === 'never' && (track.playCount || lastPlayed)) return false
  if (rules.played === 'within' && !(lastPlayed && now - lastPlayed <= days)) return false
  if (rules.played === 'not-within' && lastPlayed && now - lastPlayed <= days) return false
  if (rules.addedDays && !(time(track.created) && now - time(track.created) <= rules.addedDays * DAY_MS)) return false
  if (rules.addedFrom && !(time(track.created) && time(track.created) >= startOfDay(rules.addedFrom))) return false
  return true
}

export function evaluateSmartPlaylist(library: Track[], rules: SmartRules, now = Date.now(), seed = 1): Track[] {
  const matched = smartPool(library, rules, now)
  const by = (value: (track: Track) => number, direction = -1) => matched.sort((a, b) => direction * (value(a) - value(b)) || a.title.localeCompare(b.title))
  switch (rules.sort ?? 'random') {
    case 'most-played': by((track) => track.playCount ?? 0); break
    case 'least-played': by((track) => track.playCount ?? 0, 1); break
    case 'recently-added': by((track) => time(track.created)); break
    case 'recently-played': by((track) => time(track.played)); break
    case 'newest': by((track) => track.year ?? 0); break
    case 'oldest': by((track) => track.year || 9999, 1); break
    default: shuffle(matched, seed)
  }
  return matched.slice(0, Math.min(MAX_LIMIT, Math.max(1, rules.limit ?? DEFAULT_LIMIT)))
}

// "1 January 2026" for a YYYY-MM-DD day.
function addedLabel(day: string) {
  const at = startOfDay(day)
  return at ? new Date(at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }) : day
}

export function describeRules(rules: SmartRules) {
  const parts: string[] = []
  if (rules.genres?.length) parts.push(rules.genres.join(' or '))
  if (rules.moods?.length) parts.push(rules.moods.join(' or '))
  if (rules.bpmFrom || rules.bpmTo) parts.push(rules.bpmFrom && rules.bpmTo ? `${rules.bpmFrom}–${rules.bpmTo} bpm` : rules.bpmFrom ? `${rules.bpmFrom}+ bpm` : `up to ${rules.bpmTo} bpm`)
  if (rules.artist) parts.push(`artist “${rules.artist}”`)
  if (rules.yearFrom || rules.yearTo) parts.push(rules.yearFrom && rules.yearTo ? `${rules.yearFrom}–${rules.yearTo}` : rules.yearFrom ? `from ${rules.yearFrom}` : `up to ${rules.yearTo}`)
  if (rules.favouritesOnly) parts.push('favourites')
  if (rules.minRating) parts.push(`rated ${rules.minRating}+`)
  if (rules.minPlays) parts.push(`played ${rules.minPlays}+ times`)
  if (rules.played === 'never') parts.push('never played')
  if (rules.played === 'within') parts.push(`played in the last ${rules.playedDays ?? 30} days`)
  if (rules.played === 'not-within') parts.push(`not played in ${rules.playedDays ?? 30} days`)
  if (rules.addedDays) parts.push(`added in the last ${rules.addedDays} days`)
  if (rules.addedFrom) parts.push(`added since ${addedLabel(rules.addedFrom)}`)
  return parts.length ? parts.join(' · ') : 'Anything in your library'
}

// Every song the rules match, ignoring the order and length limit: the pool the DJ and song radio pick from.
export const smartPool = (library: Track[], rules: SmartRules, now = Date.now()) => library.filter((track) => matchesRules(track, rules, now))

// The library is fetched once per session and reused for half an hour, since every smart playlist reads all of it.
const LIBRARY_TTL_MS = 30 * 60 * 1000
let cached: { key: string; at: number; songs: Promise<Track[]> } | null = null
export function loadLibrary(api: NavidromeClient, onPage?: (loaded: number) => void, force = false): Promise<Track[]> {
  const key = `${api.session.serverUrl}|${api.session.username}`
  if (!force && cached && cached.key === key && Date.now() - cached.at < LIBRARY_TTL_MS) return cached.songs
  const songs = api.allSongs(undefined, onPage)
  cached = { key, at: Date.now(), songs }
  songs.catch(() => { if (cached?.songs === songs) cached = null })
  return songs
}

function headers(): HeadersInit {
  const session = useAuth.getState().session
  if (!session) throw new Error('Sign in to use smart playlists.')
  return { 'x-tomify-user': session.username, 'x-tomify-token': session.token, 'x-tomify-salt': session.salt, 'content-type': 'application/json' }
}
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, { ...init, headers: headers() })
  const body = await response.json().catch(() => ({})) as T & { error?: string; message?: string }
  if (!response.ok) throw new Error(body.message || (body.error === 'not-found' ? 'This smart playlist no longer exists.' : body.error) || 'Smart playlist request failed.')
  return body
}

export const smartPlaylistsApi = {
  list: () => call<{ playlists: SmartPlaylist[] }>('/api/smart-playlists').then((result) => result.playlists),
  get: (id: string) => call<SmartPlaylist>(`/api/smart-playlists/${encodeURIComponent(id)}`),
  create: (name: string, rules: SmartRules) => call<SmartPlaylist>('/api/smart-playlists', { method: 'POST', body: JSON.stringify({ name, rules }) }),
  update: (id: string, name: string, rules: SmartRules) => call<SmartPlaylist>(`/api/smart-playlists/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify({ name, rules }) }),
  remove: (id: string) => call<{ deleted: true }>(`/api/smart-playlists/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
