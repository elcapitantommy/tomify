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
  beforeEach(() => { useAuth.setState({ session }); useAlbumArtwork.setState({ overrides: {}, status: 'ready', spotifyAvailable: true }) })
  afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

  it('upgrades albums in turn, skipping ones with a manual choice and counting each outcome', async () => {
    vi.useFakeTimers()
    useAlbumArtwork.setState({ overrides: { kept: { albumId: 'kept', provider: 'library', source: 'manual' } } })
    const requested: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (_path: string, init: RequestInit) => {
      const { albumId } = JSON.parse(String(init.body)) as { albumId: string }
      requested.push(albumId)
      if (albumId === 'a') return Response.json({ applied: true, item: { albumId: 'a', provider: 'spotify', url: 'https://i.scdn.co/image/a', source: 'auto' } })
      if (albumId === 'b') return Response.json({ applied: false, reason: 'low-confidence' })
      return Response.json({ error: 'spotify-unavailable' }, { status: 502 })
    }))
    const updates: number[] = []
    const run = useAlbumArtwork.getState().upgradeMany([album('a'), album('kept'), album('b'), album('c')], (progress) => updates.push(progress.done))
    await vi.runAllTimersAsync()
    expect(await run).toEqual({ done: 3, total: 3, applied: 1, skipped: 1, failed: 1 })
    expect(requested).toEqual(['a', 'b', 'c'])
    expect(updates).toEqual([0, 1, 2, 3])
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
})
