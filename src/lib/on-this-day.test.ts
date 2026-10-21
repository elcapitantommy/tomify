import { describe, expect, it } from 'vitest'
import type { Album } from '../types'
import { anniversaries, anniversaryLabel, dayKey, dayLastYear, fullReleaseDate } from './on-this-day'

const album = (id: string, name: string, extra: Partial<Album> = {}): Album => ({ id, name, artist: 'Muse', ...extra } as Album)
const today = new Date(2026, 9, 21, 9, 30)

describe('on this day', () => {
  it('uses Tomify’s own date first, then the original release, then the release, only when known to the day', () => {
    expect(fullReleaseDate(album('a', 'A', { releaseDate: '2003-09-15', originalReleaseDate: { year: 2003, month: 9, day: 1 } }))).toEqual({ year: 2003, month: 9, day: 1 })
    expect(fullReleaseDate(album('a', 'A', { releaseDate: '2003-09-15' }), { releaseDate: '2003-09-22' })).toEqual({ year: 2003, month: 9, day: 22 })
    expect(fullReleaseDate(album('a', 'A', { releaseDate: '2003-09' }))).toBeNull()
    expect(fullReleaseDate(album('a', 'A', { year: 2003 }))).toBeNull()
  })

  it('finds earlier years on today’s date, roundest anniversaries first, one per artist and title', () => {
    const found = anniversaries([
      album('1', 'Showbiz', { releaseDate: '2019-10-21' }),
      album('2', 'Absolution', { releaseDate: '2001-10-21' }),
      album('3', 'Absolution', { releaseDate: '2001-10-21' }),
      album('4', 'Origin', { releaseDate: '2016-10-21' }),
      album('5', 'Drones', { releaseDate: '2015-10-22' }),
      album('6', 'Next year', { releaseDate: '2026-10-21' }),
      album('7', 'Black Holes', { releaseDate: '2011-10-21' }),
    ], today)
    expect(found.map((item) => [item.album.id, item.years])).toEqual([['2', 25], ['4', 10], ['7', 15], ['1', 7]])
  })

  it('takes Tomify’s date corrections into account', () => {
    expect(anniversaries([album('1', 'Origin', { releaseDate: '2016-01-01' })], today, { 1: { releaseDate: '2016-10-21' } })).toHaveLength(1)
  })

  it('labels and bounds the day', () => {
    expect(anniversaryLabel(1)).toBe('1 year ago today')
    expect(anniversaryLabel(30)).toBe('30 years ago today')
    expect(dayKey(today)).toBe('2026-10-21')
    const { from, to } = dayLastYear(today)
    expect(new Date(from)).toEqual(new Date(2025, 9, 21))
    expect(new Date(to)).toEqual(new Date(2025, 9, 22))
  })
})
