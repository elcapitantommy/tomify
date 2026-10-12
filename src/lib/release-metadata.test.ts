import { describe, expect, it } from 'vitest'
import { inferReleaseType, releaseBucket, releaseDateSortValue, releaseTitleHint, resolvedReleaseType, sortReleases } from './release-metadata'
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
