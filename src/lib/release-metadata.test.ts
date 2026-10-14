import { describe, expect, it } from 'vitest'
import { collapseReleaseVariants, inferReleaseType, releaseBucket, releaseDateSortValue, releaseFamilyTitle, releaseTitleHint, resolvedReleaseType, sortReleases } from './release-metadata'
import type { Album } from '../types'

const album = (id: string, name: string, year?: number): Album => ({ id, name, artist: 'Test Artist', year })

describe('release metadata', () => {
  it('prefers explicit release metadata from Navidrome', () => {
    expect(inferReleaseType({ ...album('1', 'Something'), releaseTypes: ['single'] })).toBe('single')
    expect(inferReleaseType({ ...album('2', 'Something'), isCompilation: true })).toBe('compilation')
  })

  it('recognises common single and EP edition labels', () => {
    expect(releaseTitleHint(album('1', 'Suffocate (CD1 Single)'))).toBe('single')
    expect(releaseTitleHint(album('2', 'High (CD2 Single)'))).toBe('single')
    expect(releaseTitleHint(album('3', 'The Older E.P.'))).toBe('ep')
    expect(inferReleaseType(album('4', 'Normal Album'))).toBe('album')
  })

  it('keeps manual overrides authoritative but lets strong title hints beat weak automatic album defaults', () => {
    expect(resolvedReleaseType(album('1', 'Track Name (Single)'), { releaseType: 'album', source: 'manual' })).toBe('album')
    expect(resolvedReleaseType(album('2', 'High (CD1 Single)'), { releaseType: 'album', source: 'musicbrainz' })).toBe('single')
    expect(releaseBucket('ep')).toBe('single-ep')
  })

  it('sorts releases by effective release date', () => {
    const releases = [album('old', 'Old', 1999), album('new', 'New', 2020)]
    expect(sortReleases(releases, {}, 'newest').map((item) => item.id)).toEqual(['new', 'old'])
    expect(releaseDateSortValue(releases[1])).toBe(20200000)
  })
})


describe('release variant grouping', () => {
  it('collapses obvious edition variants into one logical release', () => {
    const variants = [
      album('1', 'Echo Park'),
      album('2', 'Echo Park (Japan Edition)'),
      album('3', 'Echo Park (UK Edition)'),
    ]
    const groups = collapseReleaseVariants(variants, {})
    expect(groups).toHaveLength(1)
    expect(releaseFamilyTitle(groups[0].representative)).toBe('Echo Park')
    expect(groups[0].variants).toHaveLength(3)
  })

  it('uses a shared MusicBrainz release-group id even when titles differ', () => {
    const variants = [album('1', 'Album'), album('2', 'Completely Different Edition Title')]
    const groups = collapseReleaseVariants(variants, {
      '1': { releaseType: 'album', source: 'musicbrainz', musicBrainzId: 'same-group' },
      '2': { releaseType: 'album', source: 'musicbrainz', musicBrainzId: 'same-group' },
    })
    expect(groups).toHaveLength(1)
  })

  it('does not split enriched and unenriched copies of the same edition family', () => {
    const variants = [album('1', 'Comfort in Sound'), album('2', 'Comfort in Sound (Japan Edition)')]
    const groups = collapseReleaseVariants(variants, {
      '1': { releaseType: 'album', source: 'musicbrainz', musicBrainzId: 'group-id' },
    })
    expect(groups).toHaveLength(1)
    expect(groups[0].variants).toHaveLength(2)
  })

  it('merges long-form variants even when automatic metadata disagrees between album and compilation', () => {
    const variants = [album('1', 'Songs From The Last Century', 1999), album('2', 'Songs From The Last Century', 1999)]
    const groups = collapseReleaseVariants(variants, {
      '1': { releaseType: 'album', source: 'musicbrainz', musicBrainzId: 'album-group' },
      '2': { releaseType: 'compilation', source: 'musicbrainz', musicBrainzId: 'comp-group' },
    })
    expect(groups).toHaveLength(1)
  })

  it('uses a loose trailing edition suffix for grouping when the edition label is unfamiliar', () => {
    const variants = [album('1', 'Songs From The Last Century'), album('2', 'Songs From The Last Century (UK 1234)')]
    expect(collapseReleaseVariants(variants, {})).toHaveLength(1)
  })

  it('removes edition suffixes from the displayed canonical title', () => {
    expect(releaseFamilyTitle(album('1', 'Absolution (24-bit 96kHz)'))).toBe('Absolution')
    expect(releaseFamilyTitle(album('2', 'Absolution (2009 version)'))).toBe('Absolution')
  })
})
