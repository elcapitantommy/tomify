import { describe, expect, it } from 'vitest'
import { artistSegments } from './artist-links'

describe('artistSegments', () => {
  it('links a single artist by id', () => {
    expect(artistSegments('Queen', undefined, 'q1')).toEqual([{ text: 'Queen', id: 'q1' }])
  })

  it('leaves the line as plain text with no artist id', () => {
    expect(artistSegments('Unknown Artist')).toEqual([{ text: 'Unknown Artist' }])
    expect(artistSegments('', undefined, 'x')).toEqual([])
  })

  it('links each artist where it appears and keeps the joining words', () => {
    expect(artistSegments('Calvin Harris feat. Rihanna', [{ id: 'c', name: 'Calvin Harris' }, { id: 'r', name: 'Rihanna' }], 'c')).toEqual([
      { text: 'Calvin Harris', id: 'c' }, { text: ' feat. ' }, { text: 'Rihanna', id: 'r' },
    ])
  })

  it('prefers longer names so one artist is not split by another', () => {
    expect(artistSegments('Earth, Wind & Fire & Fire', [{ id: 'f', name: 'Fire' }, { id: 'e', name: 'Earth, Wind & Fire' }])).toEqual([
      { text: 'Earth, Wind & Fire', id: 'e' }, { text: ' & ' }, { text: 'Fire', id: 'f' },
    ])
  })

  it('matches names case-insensitively and keeps the line as written', () => {
    expect(artistSegments('THE KINKS', [{ id: 'k', name: 'The Kinks' }])).toEqual([{ text: 'THE KINKS', id: 'k' }])
  })

  it('links the whole line to the main artist when no name is found in it', () => {
    expect(artistSegments('Motley Crue', [{ id: 'm', name: 'Mötley Crüe' }], 'main')).toEqual([{ text: 'Motley Crue', id: 'main' }])
    expect(artistSegments('Motley Crue', [{ id: 'm', name: 'Mötley Crüe' }])).toEqual([{ text: 'Motley Crue', id: 'm' }])
  })

  it('lists the artists when there is no artist line', () => {
    expect(artistSegments(undefined, [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }])).toEqual([{ text: 'A', id: 'a' }, { text: ', ' }, { text: 'B', id: 'b' }])
  })

  it('ignores artists without an id or name and duplicates', () => {
    expect(artistSegments('A & B', [{ id: '', name: 'A' }, { id: 'b', name: 'B' }, { id: 'b', name: 'B' }])).toEqual([{ text: 'A & ' }, { text: 'B', id: 'b' }])
  })
})
