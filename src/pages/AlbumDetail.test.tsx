import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { useEffect } from 'react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Album, Track } from '../types'
import { useAlbumArtwork } from '../stores/albumArtwork'
import { useAuth } from '../stores/auth'
import { usePlayer } from '../stores/player'
import { useReleaseMetadata } from '../stores/releaseMetadata'
import { AlbumDetail } from './AlbumDetail'

const album: Album & { song: Track[] } = { id: 'album-1', name: 'Flood', artist: 'They Might Be Giants', year: 1990, song: [{ id: 'track-1', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood', duration: 200 }] }
const api = { session: { username: 'guest' }, album: vi.fn(async (_id: string) => album), albums: vi.fn(async () => [album]), allAlbums: vi.fn(async () => [album]), artist: vi.fn(), coverArtUrl: () => 'https://music.example/cover.jpg' }

vi.mock('../lib/api-context', () => ({ useApi: () => api }))
const completenessMounts = vi.hoisted(() => ({ count: 0 }))
vi.mock('../components/AlbumCompleteness', () => ({ AlbumCompleteness: function MockCompleteness() { useEffect(() => { completenessMounts.count += 1 }, []); return <p>completeness check</p> } }))
vi.mock('../components/AlbumArtworkPicker', () => ({ AlbumArtworkPicker: ({ searchOnOpen }: { searchOnOpen?: boolean }) => <p>artwork picker{searchOnOpen ? ' searching' : ''}</p> }))
vi.mock('../components/TrackList', () => ({ TrackList: () => null }))

function renderAlbum(id = 'album-1') {
  return render(<MemoryRouter initialEntries={[`/album/${id}`]}><Routes><Route path="/album/:id" element={<AlbumDetail/>}/></Routes></MemoryRouter>)
}

describe('AlbumDetail admin tools', () => {
  beforeEach(() => {
    useReleaseMetadata.setState({ overrides: { 'album-1': { albumId: 'album-1', releaseType: 'album', source: 'musicbrainz' } }, cloudStatus: 'cloud' } as never)
    useAlbumArtwork.setState({ overrides: {}, status: 'ready', providers: ['apple', 'deezer'] })
  })

  it('gives administrators metadata editing, the completeness check and click-to-replace artwork', async () => {
    useAuth.setState({ isAdmin: true })
    renderAlbum()
    // The completeness check waits for the edition lookup; a busy CI runner can take longer than findBy's default 1 s.
    expect(await screen.findByRole('button', { name: 'Edit metadata' }, { timeout: 5000 })).toBeInTheDocument()
    expect(await screen.findByText('completeness check', undefined, { timeout: 5000 })).toBeInTheDocument()
    expect(screen.queryByText(/artwork picker/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Change album artwork' }))
    expect(screen.getByText('artwork picker searching')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Close album artwork options' }))
    expect(screen.queryByText(/artwork picker/)).not.toBeInTheDocument()
  })

  it('mounts the completeness check once, after the edition lookup for this album', async () => {
    useAuth.setState({ isAdmin: true })
    completenessMounts.count = 0
    // The album arrives after the empty no-album edition lookup has settled, which used to show the check for a moment before the real lookup hid it again.
    api.allAlbums.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve([album]), 20)))
    const slowAlbum = { ...album, id: 'album-slow' }
    useReleaseMetadata.setState({ overrides: { 'album-slow': { albumId: 'album-slow', releaseType: 'album', source: 'musicbrainz' } } } as never)
    api.album.mockImplementationOnce(() => new Promise((resolve) => setTimeout(() => resolve(slowAlbum), 20)))
    renderAlbum('album-slow')
    expect(await screen.findByText('completeness check', undefined, { timeout: 5000 })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText('completeness check')).toBeInTheDocument())
    expect(completenessMounts.count).toBe(1)
  })

  it('hides metadata editing, the completeness check and artwork replacement from other users', async () => {
    useAuth.setState({ isAdmin: false })
    renderAlbum()
    expect(await screen.findByRole('heading', { name: 'Flood' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit metadata' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Change album artwork' })).not.toBeInTheDocument()
    expect(screen.queryByText('completeness check')).not.toBeInTheDocument()
  })
})

describe('AlbumDetail versions', () => {
  const japan: Album & { song: Track[] } = { id: 'album-2', name: 'Flood (Japan Edition)', artist: 'They Might Be Giants', year: 1990, song: [{ id: 'track-2', title: 'Birdhouse in Your Soul', artist: 'They Might Be Giants', album: 'Flood (Japan Edition)', duration: 200 }, { id: 'track-3', title: 'Bonus Track', artist: 'They Might Be Giants', album: 'Flood (Japan Edition)', duration: 100 }] }

  beforeEach(() => {
    useAuth.setState({ isAdmin: false })
    useReleaseMetadata.setState({ overrides: {}, cloudStatus: 'local' } as never)
    api.allAlbums.mockResolvedValue([album, japan])
    api.album.mockImplementation(async (albumId: string) => albumId === japan.id ? japan : album)
  })

  it('shows one version at a time, picked from a dropdown, and plays the picked version', async () => {
    const playTracks = vi.fn()
    usePlayer.setState({ playTracks } as never)
    renderAlbum()
    const picker = await screen.findByRole('combobox', { name: 'Version' }, { timeout: 5000 })
    expect(screen.getByRole('option', { name: 'Flood' })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Flood (Japan Edition)' })).toBeInTheDocument()
    expect(screen.getByText(/2 versions · 1 songs/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(playTracks).toHaveBeenLastCalledWith(album.song)
    fireEvent.change(picker, { target: { value: 'album-2' } })
    expect(await screen.findByText(/2 versions · 2 songs/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Play' }))
    expect(playTracks).toHaveBeenLastCalledWith(japan.song)
  })

  it('has no dropdown when there is only one version', async () => {
    api.allAlbums.mockResolvedValue([album])
    renderAlbum()
    expect(await screen.findByRole('heading', { name: 'Flood' })).toBeInTheDocument()
    await waitFor(() => expect(api.allAlbums).toHaveBeenCalled())
    expect(screen.queryByRole('combobox', { name: 'Version' })).not.toBeInTheDocument()
  })
})
