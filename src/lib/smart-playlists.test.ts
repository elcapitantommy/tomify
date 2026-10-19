import { describe, expect, it } from 'vitest'
import { describeRules, evaluateSmartPlaylist, matchesRules } from './smart-playlists'
import type { Track } from '../types'

const now = Date.parse('2026-10-19T12:00:00Z')
const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString()
const song = (id: string, extra: Partial<Track>): Track => ({ id, title: id, artist: 'Someone', album: 'Album', ...extra })
const library = [
  song('a', { genre: 'Jazz', year: 1959, playCount: 12, played: daysAgo(2), created: daysAgo(400), starred: daysAgo(10) }),
  song('b', { genre: 'Rock; Jazz', year: 1972, playCount: 3, played: daysAgo(90), created: daysAgo(5), artist: 'Miles Davis' }),
  song('c', { genre: 'Rock', year: 1991, created: daysAgo(3), userRating: 4 }),
  song('d', { genre: 'Pop', year: 2020, playCount: 30, played: daysAgo(1), created: daysAgo(100) }),
]

describe('smart playlists', () => {
  it('matches genres inside multi-genre tags, years and favourites', () => {
    expect(evaluateSmartPlaylist(library, { genres: ['jazz'], sort: 'oldest' }, now).map((track) => track.id)).toEqual(['a', 'b'])
    expect(evaluateSmartPlaylist(library, { yearFrom: 1970, yearTo: 1999, sort: 'newest' }, now).map((track) => track.id)).toEqual(['c', 'b'])
    expect(evaluateSmartPlaylist(library, { favouritesOnly: true }, now).map((track) => track.id)).toEqual(['a'])
  })

  it('filters on when and how often a song was played, and when it was added', () => {
    expect(evaluateSmartPlaylist(library, { played: 'never' }, now).map((track) => track.id)).toEqual(['c'])
    expect(evaluateSmartPlaylist(library, { played: 'not-within', playedDays: 30, sort: 'recently-added' }, now).map((track) => track.id)).toEqual(['c', 'b'])
    expect(evaluateSmartPlaylist(library, { played: 'within', playedDays: 7, sort: 'most-played' }, now).map((track) => track.id)).toEqual(['d', 'a'])
    expect(evaluateSmartPlaylist(library, { addedDays: 7, sort: 'recently-added' }, now).map((track) => track.id)).toEqual(['c', 'b'])
    expect(matchesRules(library[2], { minRating: 4 }, now)).toBe(true)
    expect(matchesRules(library[1], { minPlays: 5 }, now)).toBe(false)
    expect(matchesRules(library[1], { artist: 'miles' }, now)).toBe(true)
  })

  it('keeps a random pick stable for a seed and caps the length', () => {
    const first = evaluateSmartPlaylist(library, {}, now, 42).map((track) => track.id)
    expect(evaluateSmartPlaylist(library, {}, now, 42).map((track) => track.id)).toEqual(first)
    expect(first.slice().sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(evaluateSmartPlaylist(library, { sort: 'most-played', limit: 2 }, now).map((track) => track.id)).toEqual(['d', 'a'])
  })

  it('describes the rules in words', () => {
    expect(describeRules({})).toBe('Anything in your library')
    expect(describeRules({ genres: ['Jazz', 'Soul'], yearFrom: 1960, yearTo: 1969, played: 'not-within', playedDays: 90 })).toBe('Jazz or Soul · 1960–1969 · not played in 90 days')
  })
})
