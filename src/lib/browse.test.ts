import { describe, expect, it } from 'vitest'
import { browseGenres, decadeLabel, decadesOf, parseDecade, tileHue } from './browse'

describe('browse', () => {
  it('groups albums into decades, newest first, skipping missing years', () => {
    expect(decadesOf([{ year: 1971 }, { year: 1979 }, { year: 1985 }, {}, { year: 0 }, { year: 2024 }])).toEqual([{ start: 2020, albumCount: 1 }, { start: 1980, albumCount: 1 }, { start: 1970, albumCount: 2 }])
    expect(decadeLabel(1990)).toBe('1990s')
    expect(parseDecade('1980')).toBe(1980)
    expect(parseDecade('1985')).toBeNull()
    expect(parseDecade('abc')).toBeNull()
  })

  it('lists the biggest genres first and drops empty ones', () => {
    expect(browseGenres([{ name: 'Jazz', albumCount: 3, songCount: 30 }, { name: 'Rock', albumCount: 40, songCount: 400 }, { name: 'Empty', albumCount: 0, songCount: 2 }, { name: 'Blues', albumCount: 3, songCount: 9 }]).map((genre) => genre.name)).toEqual(['Rock', 'Blues', 'Jazz'])
    expect(tileHue('Rock')).toBe(tileHue('Rock'))
  })
})
