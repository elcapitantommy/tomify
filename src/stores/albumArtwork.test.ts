import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { createElement } from 'react'
import { useAlbumArtwork } from './albumArtwork'
import { useAuth } from './auth'
import { Artwork } from '../components/Artwork'
import * as apiContext from '../lib/api-context'
import { NavidromeClient } from '../lib/navidrome'
import type { Album } from '../types'

const session = { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }
const album = (id: string): Album => ({ id, name: `Album ${id}`, artist: 'Artist' })

describe('album artwork store', () => {
  beforeEach(() => { useAuth.setState({ session }); useAlbumArtwork.setState({ overrides: {}, status: 'ready', providers: ['apple', 'deezer'] }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('upgrades albums in turn, skipping manual choices, waiting out rate limits and counting each outcome', async () => {
    vi.useFakeTimers()
    useAlbumArtwork.setState({ overrides: { kept: { albumId: 'kept', provider: 'library', source: 'manual' } } })
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      const { albumId } = JSON.parse(String(init.body)) as { albumId: string }
      requested.push(albumId)
      if (albumId === 'a') return Response.json({ applied: true, item: { albumId: 'a', provider: 'spotify', url: 'https://i.scdn.co/image/a', source: 'auto' } })
      if (albumId === 'b') return Response.json({ applied: false, reason: 'low-confidence' })
      if (albumId === 'c' && requested.filter((id) => id === 'c').length === 1) return Response.json({ error: 'rate-limited', retryAfter: 2 }, { status: 429 })
      if (albumId === 'c') return Response.json({ applied: false, reason: 'no-match' })
      return Response.json({ error: 'spotify-error', message: 'Spotify search returned HTTP 500.' }, { status: 502 })
    }))
    const updates: Array<[number, number | undefined]> = []
    const run = useAlbumArtwork.getState().upgradeMany([album('a'), album('kept'), album('b'), album('c'), album('d')], (progress) => updates.push([progress.done, progress.waitingSeconds]))
    await vi.runAllTimersAsync()
    expect(await run).toEqual({ done: 4, total: 4, applied: 1, unchanged: 0, noMatch: 1, lowConfidence: 1, failed: 1, lastError: 'Spotify search returned HTTP 500.' })
    expect(requested).toEqual(['a', 'b', 'c', 'c', 'd'])
    expect(updates).toEqual([[0, undefined], [1, undefined], [2, undefined], [2, 2], [3, undefined], [4, undefined]])
    expect(useAlbumArtwork.getState().overrides.a.url).toBe('https://i.scdn.co/image/a')
  })

  it('draws the Spotify replacement and falls back to the library artwork if it fails to load', () => {
    vi.spyOn(apiContext, 'useApi').mockReturnValue(new NavidromeClient(session, vi.fn()))
    useAlbumArtwork.setState({ overrides: { 'al-1': { albumId: 'al-1', provider: 'spotify', url: 'https://i.scdn.co/image/blue', source: 'auto' } } })
    render(createElement(Artwork, { id: 'al-1', albumId: 'al-1', alt: 'Blue' }))
    const image = screen.getByAltText('Blue') as HTMLImageElement
    expect(image.src).toBe('https://i.scdn.co/image/blue')
    fireEvent.error(image)
    expect((screen.getByAltText('Blue') as HTMLImageElement).src).toMatch(/^https:\/\/music\.example\/rest\/getCoverArt\.view/)
  })

  it('keeps the library artwork when the album has no replacement or the person kept it', () => {
    vi.spyOn(apiContext, 'useApi').mockReturnValue(new NavidromeClient(session, vi.fn()))
    useAlbumArtwork.setState({ overrides: { 'al-2': { albumId: 'al-2', provider: 'library', source: 'manual' } } })
    render(createElement(Artwork, { id: 'al-2', albumId: 'al-2', alt: 'Hejira' }))
    expect((screen.getByAltText('Hejira') as HTMLImageElement).src).toMatch(/getCoverArt\.view/)
  })

  it('stops after five failures in a row instead of failing the whole library', async () => {
    vi.useFakeTimers()
    const fetcher = vi.fn(async () => Response.json({ error: 'spotify-forbidden', message: 'Spotify search returned HTTP 403.' }, { status: 502 }))
    vi.stubGlobal('fetch', fetcher)
    const run = useAlbumArtwork.getState().upgradeMany(['1', '2', '3', '4', '5', '6', '7'].map(album))
    await vi.runAllTimersAsync()
    expect(await run).toMatchObject({ done: 5, total: 7, failed: 5, stopped: true, lastError: 'Spotify search returned HTTP 403.' })
    expect(fetcher).toHaveBeenCalledTimes(5)
  })
})
