import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAuth } from '../stores/auth'
import { newReleasesApi, notInLibrary, releaseDateLabel, SYNC_EVERY_MS, titleKey, type NewRelease } from './new-releases'

const NOW = Date.parse('2026-10-20T12:00:00Z')
const release = (title: string, artist = 'Muse', date = '2026-09-26'): NewRelease => ({ id: title, title, artist, type: 'album', date })

describe('new releases', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: true })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('hides records already in the library, whatever the edition', () => {
    const albums = [{ name: 'Wow! Signal (Deluxe Edition)', artist: 'Muse' }, { name: 'Free All Angels', artist: 'Ash' }]
    expect(notInLibrary([release('Wow! Signal'), release('Will of the People'), release('Free All Angels', 'The Ash')], albums).map((item) => item.title)).toEqual(['Will of the People'])
    expect(titleKey('The White Album [Remastered]')).toBe(titleKey('White Album'))
  })

  it('labels dates, marking announced ones', () => {
    const now = new Date(2026, 9, 20)
    expect(releaseDateLabel('2026-09-26', now)).toBe('26 Sept')
    expect(releaseDateLabel('2026-12-01', now)).toBe('Out 1 Dec')
    expect(releaseDateLabel('2025-11-03', now)).toBe('3 Nov 2025')
    expect(releaseDateLabel('2026-11', now)).toBe('November 2026')
    expect(releaseDateLabel('2026', now)).toBe('2026')
  })

  it('sends the artist list at most once a day', async () => {
    const fetchMock = vi.fn(async () => Response.json({ artists: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    const artists = vi.fn(async () => [{ id: 'ar1', name: 'Muse', musicBrainzId: 'mb1' }])
    expect(await newReleasesApi.syncArtists('tom', artists, NOW)).toBe(true)
    expect(JSON.parse(String((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body))).toEqual({ artists: [{ name: 'Muse', musicBrainzId: 'mb1' }] })
    expect(await newReleasesApi.syncArtists('tom', artists, NOW + SYNC_EVERY_MS - 1)).toBe(false)
    expect(await newReleasesApi.syncArtists('tom', artists, NOW + SYNC_EVERY_MS)).toBe(true)
    expect(artists).toHaveBeenCalledTimes(2)
  })
})
