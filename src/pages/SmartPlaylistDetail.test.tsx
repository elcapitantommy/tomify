import { fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SmartPlaylistDetail } from './SmartPlaylistDetail'
import { smartPlaylistsApi } from '../lib/smart-playlists'

const api = {
  session: { serverUrl: 'https://music.test', username: 'tom' },
  allSongs: vi.fn(),
  genres: vi.fn(),
  createPlaylist: vi.fn(),
}
vi.mock('../lib/api-context', () => ({ useApi: () => api }))
vi.mock('../components/TrackList', () => ({ TrackList: ({ tracks }: { tracks: { title: string }[] }) => <ol>{tracks.map((track) => <li key={track.title}>{track.title}</li>)}</ol> }))
vi.mock('../lib/smart-playlists', async (original) => {
  const actual = await original<typeof import('../lib/smart-playlists')>()
  return { ...actual, smartPlaylistsApi: { get: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn(), list: vi.fn() } }
})

const songs = [
  { id: '1', title: 'So What', artist: 'Miles Davis', album: 'Kind of Blue', genre: 'Jazz', year: 1959, playCount: 9 },
  { id: '2', title: 'Smells Like Teen Spirit', artist: 'Nirvana', album: 'Nevermind', genre: 'Rock', year: 1991, playCount: 2 },
]

function renderAt(path: string) {
  return render(<MemoryRouter initialEntries={[path]}><Routes><Route path="/playlists/smart/:id" element={<SmartPlaylistDetail/>}/><Route path="/playlists/:id" element={<p>Navidrome playlist</p>}/></Routes></MemoryRouter>)
}

describe('SmartPlaylistDetail', () => {
  beforeEach(() => {
    api.allSongs.mockReset().mockResolvedValue(songs)
    api.genres.mockReset().mockResolvedValue(['Jazz', 'Rock'])
    api.createPlaylist.mockReset().mockResolvedValue({ id: 'nav-9', name: 'x' })
  })

  it('loads saved rules, shows the matching songs, and snapshots them as a Navidrome playlist', async () => {
    vi.mocked(smartPlaylistsApi.get).mockResolvedValue({ id: 'sp-1', name: 'Jazz', rules: { genres: ['Jazz'], sort: 'most-played' }, updatedAt: '' })
    renderAt('/playlists/smart/sp-1')
    expect(await screen.findByText('So What')).toBeInTheDocument()
    expect(screen.queryByText('Smells Like Teen Spirit')).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Save as playlist' }))
    expect(await screen.findByText('Navidrome playlist')).toBeInTheDocument()
    expect(api.createPlaylist).toHaveBeenCalledWith(expect.stringMatching(/^Jazz \(/), ['1'])
  })

  it('updates the matches as rules change and creates a new smart playlist', async () => {
    vi.mocked(smartPlaylistsApi.create).mockResolvedValue({ id: 'sp-2', name: 'Nineties', rules: {}, updatedAt: '' })
    renderAt('/playlists/smart/new')
    expect(await screen.findByText('Smells Like Teen Spirit')).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('From year'), { target: { value: '1990' } })
    expect(screen.queryByText('So What')).not.toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Nineties' } })
    fireEvent.click(screen.getByRole('button', { name: 'Create' }))
    await vi.waitFor(() => expect(smartPlaylistsApi.create).toHaveBeenCalledWith('Nineties', expect.objectContaining({ yearFrom: 1990 })))
  })
})
