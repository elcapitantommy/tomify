import { describe, expect, it } from 'vitest'
import type { Track } from '../types'
import { pickRadio, radioScore, RADIO_ARTIST_CAP, tempoCloseness } from './song-radio'

let serial = 0
const song = (artist: string, extra: Partial<Track> = {}): Track => ({ id: `s${++serial}`, title: `Song ${serial}`, artist, album: 'Album', ...extra })
const noJitter = () => 0

describe('song radio', () => {
  it('scores shared genres and moods, a close tempo, similar artists, the same artist and era', () => {
    const seed = song('Seed', { genres: [{ name: 'Indie Rock' }], moods: ['energetic'], bpm: 120, year: 1997 })
    const close = song('Other', { genre: 'indie rock', moods: ['Energetic'], bpm: 61, year: 1999 })
    const far = song('Other', { genre: 'Ambient', moods: ['calm'], bpm: 70, year: 2020 })
    expect(radioScore(seed, close, new Map())).toBeGreaterThan(radioScore(seed, far, new Map()) + 4)
    expect(tempoCloseness(120, 61)).toBeGreaterThan(0.9)
    expect(tempoCloseness(120, undefined)).toBeNull()
    expect(radioScore(seed, far, new Map([[far.id, 0]]))).toBeGreaterThan(radioScore(seed, far, new Map()))
    expect(radioScore(seed, song('Seed'), new Map())).toBe(1.5)
  })

  it('picks the closest songs without repeating one or playing an artist twice in a row', () => {
    const seed = song('Seed', { genre: 'Jazz' })
    const library = [
      ...Array.from({ length: 6 }, () => song('Miles', { genre: 'Jazz' })),
      ...Array.from({ length: 6 }, () => song('Coltrane', { genre: 'Jazz' })),
      ...Array.from({ length: 6 }, () => song('Metallica', { genre: 'Metal' })),
    ]
    const picks = pickRadio(seed, [seed], library, [], 7, noJitter)
    expect(picks).toHaveLength(7)
    expect(picks.slice(0, 6).every((track) => track.genre === 'Jazz')).toBe(true)
    picks.slice(1).forEach((track, index) => expect(track.artist).not.toBe(picks[index].artist))
    expect(picks.filter((track) => track.artist === 'Miles').length).toBeLessThanOrEqual(RADIO_ARTIST_CAP)
    expect(new Set(picks.map((track) => track.id)).size).toBe(7)
    // With only capped artists left, the cap gives way rather than the radio stopping.
    expect(pickRadio(seed, [seed], library, [], 8, noJitter)).toHaveLength(8)
    const next = pickRadio(seed, [seed, ...picks], library, [], 4, noJitter)
    expect(next.some((track) => picks.includes(track))).toBe(false)
  })

  it('counts another edition of a queued song as the same song, and starts on similar songs Navidrome suggests', () => {
    const seed = song('Seed')
    const first = song('Blur', { title: 'Song 2' })
    const edition = { ...first, id: 'other-edition', album: 'Best Of' }
    const similar = song('Pulp')
    const picks = pickRadio(seed, [seed, first], [edition, song('Oasis')], [similar], 5, noJitter)
    expect(picks.map((track) => track.id)).not.toContain('other-edition')
    expect(picks[0]).toBe(similar)
  })

  it('comes round again once a small library has all been queued', () => {
    const seed = song('Seed')
    const library = [song('A'), song('B'), song('C')]
    expect(pickRadio(seed, [seed, ...library], library, [], 2, noJitter)).toEqual([])
    const long = [seed, ...library, ...Array.from({ length: 60 }, () => song('Filler'))]
    expect(pickRadio(seed, long, library, [], 2, noJitter)).toHaveLength(2)
  })
})
