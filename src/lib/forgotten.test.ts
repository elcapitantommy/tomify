import { describe, expect, it } from 'vitest'
import type { Album } from '../types'
import { forgottenAlbums, lastPlayedLabel } from './forgotten'

const now = new Date(2026, 9, 21, 12)
const album = (id: string, playCount: number, played?: string): Album => ({ id, name: `Album ${id}`, artist: 'Muse', playCount, played })

describe('forgotten favourites', () => {
  it('keeps well-played albums not played for six months', () => {
    const found = forgottenAlbums([
      album('old-loved', 40, '2025-11-01T10:00:00Z'),
      album('recent', 90, '2026-10-01T10:00:00Z'),
      album('barely', 2, '2024-01-01T10:00:00Z'),
      album('never', 30),
      album('also-old', 8, '2026-03-01T10:00:00Z'),
    ], now)
    expect(found.map((item) => item.id).sort()).toEqual(['also-old', 'old-loved'])
  })

  it('picks the same few all day and others on another day, from the most played', () => {
    const many = Array.from({ length: 60 }, (_, index) => album(String(index), 100 - index, '2025-01-01T00:00:00Z'))
    const today = forgottenAlbums(many, now).map((item) => item.id)
    expect(today).toHaveLength(8)
    expect(forgottenAlbums(many, new Date(2026, 9, 21, 22)).map((item) => item.id)).toEqual(today)
    expect(forgottenAlbums(many, new Date(2026, 9, 22, 12)).map((item) => item.id)).not.toEqual(today)
    expect(today.every((id) => Number(id) < 40)).toBe(true)
  })

  it('labels when it was last played', () => {
    expect(lastPlayedLabel('2025-03-14T10:00:00Z')).toBe('Last played Mar 2025')
    expect(lastPlayedLabel(undefined)).toBeUndefined()
  })
})
