import type { NavidromeClient } from './navidrome'
import type { Track } from '../types'
import { useAuth } from '../stores/auth'

// A smart playlist is a saved set of rules. Tracks are picked in the browser from the whole library each time it
// opens, using what Navidrome knows about each song (genre, year, favourite, rating, play count, last played, added).
export type SmartSort = 'random' | 'most-played' | 'least-played' | 'recently-added' | 'recently-played' | 'newest' | 'oldest'
export type PlayedRule = 'any' | 'never' | 'within' | 'not-within'
export interface SmartRules {
  genres?: string[]
  artist?: string
  yearFrom?: number
  yearTo?: number
  favouritesOnly?: boolean
  minRating?: number
  minPlays?: number
  played?: PlayedRule
  playedDays?: number
  addedDays?: number
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

export function matchesRules(track: Track, rules: SmartRules, now: number) {
  const genres = (rules.genres ?? []).map(lower).filter(Boolean)
  if (genres.length) {
    const own = lower(track.genre).split(/\s*[;/,]\s*/)
    if (!genres.some((genre) => own.includes(genre))) return false
  }
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
  return true
}

export function evaluateSmartPlaylist(library: Track[], rules: SmartRules, now = Date.now(), seed = 1): Track[] {
  const matched = library.filter((track) => matchesRules(track, rules, now))
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

export function describeRules(rules: SmartRules) {
  const parts: string[] = []
  if (rules.genres?.length) parts.push(rules.genres.join(' or '))
  if (rules.artist) parts.push(`artist “${rules.artist}”`)
  if (rules.yearFrom || rules.yearTo) parts.push(rules.yearFrom && rules.yearTo ? `${rules.yearFrom}–${rules.yearTo}` : rules.yearFrom ? `from ${rules.yearFrom}` : `up to ${rules.yearTo}`)
  if (rules.favouritesOnly) parts.push('favourites')
  if (rules.minRating) parts.push(`rated ${rules.minRating}+`)
  if (rules.minPlays) parts.push(`played ${rules.minPlays}+ times`)
  if (rules.played === 'never') parts.push('never played')
  if (rules.played === 'within') parts.push(`played in the last ${rules.playedDays ?? 30} days`)
  if (rules.played === 'not-within') parts.push(`not played in ${rules.playedDays ?? 30} days`)
  if (rules.addedDays) parts.push(`added in the last ${rules.addedDays} days`)
  return parts.length ? parts.join(' · ') : 'Anything in your library'
}

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
