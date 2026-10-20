import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Album, Track } from '../types'
import { usePlayer } from '../stores/player'
import { useAuth } from '../stores/auth'
import { useLivePlayback } from '../stores/livePlayback'
import { TrackList } from './TrackList'
import { AlbumCard } from './MediaCards'
import { PlayerBar } from './Player'
import { AlbumLabel, ArtistLabel, TrackLabel } from './StatsList'

vi.mock('./Artwork', () => ({ Artwork: () => null }))
const api = { star: vi.fn(), unstar: vi.fn(), setRating: vi.fn(async () => undefined) }
vi.mock('../lib/api-context', () => ({ useApi: () => api, useOptionalApi: () => api }))

const duet: Track = { id: 't1', title: 'Under Pressure', artist: 'Queen & David Bowie', artistId: 'queen', artists: [{ id: 'queen', name: 'Queen' }, { id: 'bowie', name: 'David Bowie' }], album: 'Hot Space', albumId: 'hs', duration: 248 }

function routed(ui: React.ReactNode) {
  return render(<MemoryRouter initialEntries={['/']}><Routes><Route path="/" element={ui}/><Route path="/artists/:id" element={<p>Artist page</p>}/></Routes></MemoryRouter>)
}

describe('artist links', () => {
  beforeEach(() => {
    useAuth.setState({ session: { serverUrl: 'https://music.example', username: 'tom', salt: 's', token: 't' }, status: 'signed-in', error: null, isAdmin: false })
    useLivePlayback.setState({ snapshot: null, devices: [], optimistic: null, serverOffset: 0 })
    usePlayer.setState({ queue: [], currentIndex: 0, playing: false, queueOpen: false, nowPlayingOpen: false })
  })

  it('links each artist on a track row without playing the track', () => {
    const playTracks = vi.fn()
    usePlayer.setState({ playTracks })
    routed(<TrackList tracks={[duet]}/>)
    expect(screen.getByRole('link', { name: 'Queen' })).toHaveAttribute('href', '/artists/queen')
    expect(screen.getByRole('link', { name: 'David Bowie' })).toHaveAttribute('href', '/artists/bowie')
    expect(screen.getByRole('link', { name: 'Queen' }).closest('button')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Under Pressure' }))
    expect(playTracks).toHaveBeenCalledWith([duet], 0)
    fireEvent.click(screen.getByRole('link', { name: 'David Bowie' }))
    expect(playTracks).toHaveBeenCalledTimes(1)
    expect(screen.getByText('Artist page')).toBeInTheDocument()
  })

  it('shows plain text for a track with no artist id', () => {
    routed(<TrackList tracks={[{ id: 't2', title: 'Mystery', artist: 'Unknown Artist', album: 'Tapes' }]}/>)
    expect(screen.getByText('Unknown Artist')).toBeInTheDocument()
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('keeps the album card artist link outside the album link', () => {
    const album: Album = { id: 'al', name: 'Flood', artist: 'They Might Be Giants', artistId: 'tmbg', year: 1990 }
    routed(<AlbumCard album={album}/>)
    const artist = screen.getByRole('link', { name: 'They Might Be Giants' })
    expect(artist).toHaveAttribute('href', '/artists/tmbg')
    expect(artist.parentElement?.closest('a')).toBeNull()
    expect(screen.getByRole('link', { name: 'Flood' })).toHaveAttribute('href', '/albums/al')
  })

  it('closes Now Playing when its artist link is followed', () => {
    usePlayer.setState({ queue: [duet], currentIndex: 0, nowPlayingOpen: true })
    routed(<PlayerBar/>)
    const links = screen.getAllByRole('link', { name: 'David Bowie' })
    fireEvent.click(links[links.length - 1])
    expect(usePlayer.getState().nowPlayingOpen).toBe(false)
  })

  it('closes the queue when a queued artist link is followed', () => {
    usePlayer.setState({ queue: [duet], currentIndex: 0, queueOpen: true })
    routed(<PlayerBar/>)
    const links = screen.getAllByRole('link', { name: 'Queen' })
    fireEvent.click(links[links.length - 1])
    expect(usePlayer.getState().queueOpen).toBe(false)
  })

  it('links artists on stats and Wrapped rows when the id is known', () => {
    routed(<><ArtistLabel row={{ plays: 3, seconds: 1, artist: 'Muse', artistId: 'muse' }}/><AlbumLabel row={{ plays: 2, seconds: 1, album: 'Absolution', albumId: 'abs', artist: 'Muse', artistId: 'muse' }}/><TrackLabel row={{ plays: 1, seconds: 1, title: 'Hysteria', artist: 'Kinks' }}/></>)
    expect(screen.getAllByRole('link', { name: 'Muse' })).toHaveLength(2)
    expect(screen.queryByRole('link', { name: 'Kinks' })).toBeNull()
  })
})
