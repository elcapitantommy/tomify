import { describe, expect, it } from 'vitest'
import { inferReleaseType, releaseBucket, releaseDateSortValue, resolvedReleaseType, sortReleases } from './release-metadata'
import type { Album } from '../types'

const album = (id: string, name: string, year?: number): Album => ({ id, name, artist: 'Test Artist', year })

describe('release metadata', () => {
  it('prefers explicit release metadata from Navidrome', () => {
    expect(inferReleaseType({ ...album('1', 'Something'), releaseTypes: ['single'] })).toBe('single')
    expect(inferReleaseType({ ...album('2', 'Something'), isCompilation: true })).toBe('compilation')
  })

  it('uses a narrow title fallback only when metadata is missing', () => {
    expect(inferReleaseType(album('1', 'Track Name (Single)'))).toBe('single')
    expect(inferReleaseType(album('2', 'Normal Album'))).toBe('album')
  })

  it('lets a Tomify override win', () => {
    expect(resolvedReleaseType(album('1', 'Track Name (Single)'), { releaseType: 'album' })).toBe('album')
    expect(releaseBucket('ep')).toBe('single-ep')
  })

  it('sorts releases by effective release date', () => {
    const releases = [album('old', 'Old', 1999), album('new', 'New', 2020)]
    expect(sortReleases(releases, {}, 'newest').map((item) => item.id)).toEqual(['new', 'old'])
    expect(releaseDateSortValue(releases[1])).toBe(20200000)
  })
})
